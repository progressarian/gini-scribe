import pool from "../../config/db.js";
import { advanceStatus, returnToQueue, budgetColour, IST_TODAY } from "./statusEngine.js";
import { getSlaConfig, budgetMap } from "./board.js";
import {
  STATUS_LABEL,
  slaKeyForStatus,
  compareQueue,
  columnForStatus,
} from "../../../shared/giniflowStatus.js";

// The vitals station: who is waiting, what was recorded last time, and the save
// that moves the patient on.
//
// Queue order: the patient at the station is "Now", the one after is "Next", the
// rest show their appointment time. Within that, the board's ordering rule
// applies — priority first, then a manual position, then longest waiting — so
// the station calls patients in the order the floor manager arranged.

const QUEUE_STATUSES = ["checked_in", "vitals_pending", "with_vitals"];

// A held patient is in the building and cannot be called. They are deliberately
// NOT in QUEUE_STATUSES — but leaving them off the screen entirely meant the
// station could not see that they existed, or why they were waiting.
const HELD_STATUSES = ["blocked_reports"];

const bmiOf = (weight, height) => {
  const w = Number(weight);
  const h = Number(height);
  if (!w || !h) return null;
  return Number((w / (h / 100) ** 2).toFixed(1));
};

const minutesSince = (from, now) =>
  from ? Math.max(0, Math.round((now - new Date(from)) / 60000)) : null;

const QUEUE_SQL = `
  SELECT v.id, v.current_status, v.category, v.appointment_time::text AS appointment_time,
         v.priority, v.priority_reason, v.blocked_reason,
         v.queue_position, v.queue_column,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
         first_ev.occurred_at AS checked_in_at,
         last_ev.occurred_at  AS status_since,
         seq.visit_number,
         bio.biomarkers
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'checked_in'
       ORDER BY occurred_at LIMIT 1
    ) first_ev ON TRUE
    -- What the current wait is measured from. The board times every card from
    -- its last event, and the station must agree with it: a card the board has
    -- turned red cannot look calm at the station that could act on it.
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id ORDER BY occurred_at DESC, id DESC LIMIT 1
    ) last_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int + 1 AS visit_number FROM appointments pa
       WHERE pa.patient_id = v.patient_id AND pa.appointment_date < v.visit_date
         AND pa.status = 'completed'
    ) seq ON TRUE
    LEFT JOIN LATERAL (
      SELECT a.biomarkers FROM appointments a WHERE a.id = v.appointment_id
    ) bio ON TRUE
   WHERE v.visit_date = $1::date
     AND v.current_status = ANY($2)
     AND NOT COALESCE(p.is_blocked, FALSE)
   ORDER BY v.appointment_time NULLS LAST, first_ev.occurred_at NULLS LAST`;

// Vitals recorded today, newest first. The count alone told the nurse how many
// patients they had seen but gave them no way back to one — and a mistyped
// weight is only correctable if you can find the patient again.
const DONE_SQL = `
  SELECT gv.id, gv.recorded_at, gv.weight, gv.bp_sys, gv.bp_dia, gv.source,
         v.id AS visit_id, v.current_status,
         p.name, p.file_no, p.age, p.sex
    FROM giniflow_vitals gv
    JOIN giniflow_visits v ON v.id = gv.visit_id
    JOIN patients p ON p.id = v.patient_id
   WHERE v.visit_date = $1::date
   ORDER BY gv.recorded_at DESC`;

export async function getVitalsQueue(visitDate, now = new Date(), db = pool) {
  const budgets = budgetMap(await getSlaConfig(db));

  const [{ rows }, { rows: heldRows }, { rows: doneRows }] = await Promise.all([
    db.query(QUEUE_SQL, [visitDate, QUEUE_STATUSES]),
    db.query(QUEUE_SQL, [visitDate, HELD_STATUSES]),
    db.query(DONE_SQL, [visitDate]),
  ]);

  const waiting = (r) => {
    const minutes = minutesSince(r.status_since, now);
    const budget = budgets[slaKeyForStatus(r.current_status)] ?? null;
    return {
      statusSince: r.status_since ? new Date(r.status_since).toISOString() : null,
      waitMinutes: minutes,
      waitBudget: budget,
      waitColour: budgetColour(minutes ?? 0, budget),
    };
  };

  const base = (r) => ({
    visitId: r.id,
    patientId: r.patient_id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    visitNumber: r.visit_number,
    category: r.category,
    status: r.current_status,
    appointmentTime: r.appointment_time,
    // There is no separate VIP flag in Gini Flow, and borrowing flow_visits.is_vip
    // would reconnect the retired module (00-OVERVIEW §2.3). Urgent priority IS
    // the VIP mark, set by the coordinator on the board.
    priority: r.priority || "normal",
    priorityReason: r.priority_reason,
    blockedReason: r.blocked_reason,
    // A manual position only counts inside the queue it was set for.
    queuePosition:
      r.queue_column && r.queue_column === columnForStatus(r.current_status)
        ? r.queue_position
        : null,
    checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
    bios: bioChips(r.biomarkers),
    ...waiting(r),
  });

  // Exactly one patient is "Now": whoever is physically at the station. If
  // nobody has been started yet, that is the head of the queue. Two "Now" rows
  // would tell the nurse two people are in front of them.
  //
  // Everyone behind them is ordered by the board's rule, so an urgent patient
  // rises to the top of the queue rather than sitting in appointment order.
  const ordered = rows
    .map(base)
    .map((r) => ({ ...r, statusMinutes: r.waitMinutes }))
    .sort((a, b) => {
      const atStation = (r) => (r.status === "with_vitals" ? 0 : 1);
      return atStation(a) - atStation(b) || compareQueue(a, b);
    });

  return {
    doneToday: doneRows.length,
    queue: ordered.map((r, i) => ({
      ...r,
      slot: i === 0 ? "Now" : i === 1 ? "Next" : (r.appointmentTime || "").slice(0, 5) || "—",
    })),
    held: heldRows.map(base),
    done: doneRows.map((r) => ({
      visitId: r.visit_id,
      name: r.name,
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      recordedAt: new Date(r.recorded_at).toISOString(),
      weight: r.weight,
      bp: r.bp_sys && r.bp_dia ? `${r.bp_sys}/${r.bp_dia}` : null,
      source: r.source,
      // Where the patient has got to since — the queue visibly moving is what
      // tells the nurse their work landed.
      nowAt: STATUS_LABEL[r.current_status] || r.current_status,
    })),
  };
}

// The two chips the prototype shows beside a queued patient, from the
// biomarkers HealthRay already attaches to the appointment.
function bioChips(biomarkers) {
  if (!biomarkers || typeof biomarkers !== "object") return [];
  const chips = [];
  if (biomarkers.hba1c != null) {
    const v = Number(biomarkers.hba1c);
    chips.push({ label: `HbA1c ${v}`, tone: v > 9 ? "r" : v > 7 ? "a" : "g" });
  }
  if (biomarkers.bpSys != null && biomarkers.bpDia != null) {
    const sys = Number(biomarkers.bpSys);
    const dia = Number(biomarkers.bpDia);
    chips.push({
      label: `BP ${sys}/${dia}`,
      tone: sys >= 140 || dia >= 90 ? "r" : sys >= 130 || dia >= 85 ? "a" : "g",
    });
  }
  return chips;
}

export async function getVitalsPatient(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.current_status, v.category, v.patient_id,
            p.name, p.file_no, p.age, p.sex, p.notes,
            first_ev.occurred_at AS checked_in_at,
            seq.visit_number
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = 'checked_in'
          ORDER BY occurred_at LIMIT 1
       ) first_ev ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int + 1 AS visit_number FROM appointments pa
          WHERE pa.patient_id = v.patient_id AND pa.appointment_date < v.visit_date
            AND pa.status = 'completed'
       ) seq ON TRUE
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return null;
  const visit = rows[0];

  // Last visit's reading, for the "↑ 1.4 kg from last visit" comparisons. Reads
  // the shared clinical `vitals` table, which is where a patient's history
  // actually lives — Gini Flow writes its own readings but has no history yet.
  const { rows: last } = await db.query(
    `SELECT weight, height, bp_sys, bp_dia, pulse, spo2, temp, recorded_at
       FROM vitals
      WHERE patient_id = $1 AND recorded_at::date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      ORDER BY recorded_at DESC LIMIT 1`,
    [visit.patient_id],
  );

  const { rows: current } = await db.query(
    `SELECT weight, height, bmi, bp_sys, bp_dia, pulse, spo2, temp, source, recorded_at
       FROM giniflow_vitals WHERE visit_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
    [visitId],
  );

  return {
    visitId: visit.id,
    patientId: visit.patient_id,
    name: visit.name,
    fileNo: visit.file_no,
    age: visit.age,
    sex: visit.sex,
    visitNumber: visit.visit_number,
    category: visit.category,
    status: visit.current_status,
    checkedInAt: visit.checked_in_at ? new Date(visit.checked_in_at).toISOString() : null,
    lastVisit: last[0] || null,
    recorded: current[0] || null,
  };
}

// Saving is one transaction: the reading, the status move, and the event that
// carries the numbers so the timeline shows them without a join.
export async function saveVitals(
  visitId,
  { weight, height, bpSys, bpDia, pulse, spo2, temp, source = "manual", actorId = null },
  db = pool,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const visit = await client.query(
      `SELECT patient_id, current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!visit.rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });

    const bmi = bmiOf(weight, height);
    const saved = await client.query(
      `INSERT INTO giniflow_vitals
         (visit_id, patient_id, weight, height, bmi, bp_sys, bp_dia, pulse, spo2, temp, source, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, recorded_at`,
      [
        visitId,
        visit.rows[0].patient_id,
        weight ?? null,
        height ?? null,
        bmi,
        bpSys ?? null,
        bpDia ?? null,
        pulse ?? null,
        spo2 ?? null,
        temp ?? null,
        source,
        actorId,
      ],
    );

    // Only move a patient forward. A correction to an already-recorded visit
    // saves the reading without dragging them back through the chain.
    const from = visit.rows[0].current_status;
    if (["checked_in", "vitals_pending", "with_vitals"].includes(from)) {
      await advanceStatus(client, {
        visitId,
        toStatus: "vitals_done",
        actorRole: "vitals",
        actorId,
        allowSkip: true,
        meta: {
          vitals: {
            weight,
            height,
            bmi,
            bp: bpSys && bpDia ? `${bpSys}/${bpDia}` : null,
            pulse,
            spo2,
            temp,
          },
          source,
        },
      });
    }

    await client.query("COMMIT");
    return { id: saved.rows[0].id, recordedAt: saved.rows[0].recorded_at, bmi };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Who put this patient at the station. There is no `assigned_vitals_id` column
// the way the consultant has `assigned_doctor_id`, so the holder is read back
// off the event that moved them — the log is the record of who did what, and it
// is already written on every transition.
const VITALS_HOLDER_SQL = `(SELECT e.actor_id
     FROM giniflow_visit_events e
    WHERE e.visit_id = v.id AND e.status = 'with_vitals'
    ORDER BY e.occurred_at DESC, e.seq DESC
    LIMIT 1)`;

// Claiming marks the patient as at the station, so the board's "At vitals"
// column and the queue's "Now" agree with what is physically happening.
export async function startVitals(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status, visit_date FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });

    // One nurse, one chair. Tapping a second patient used to walk them to "at
    // vitals" as well, so the queue showed several people at a station that
    // holds one — and the one actually in the chair lost their place at the
    // top. The patient already claimed has to be finished or sent back first.
    if (actorId) {
      const { rows: busy } = await client.query(
        `SELECT v.id, p.name FROM giniflow_visits v
           JOIN patients p ON p.id = v.patient_id
          WHERE v.visit_date = $1::date AND v.current_status = 'with_vitals'
            AND v.id <> $3 AND ${VITALS_HOLDER_SQL} = $2
          LIMIT 1`,
        [rows[0].visit_date, actorId, visitId],
      );
      if (busy.length) {
        throw Object.assign(
          new Error(
            `${busy[0].name} is already at your station — finish them, or send them back to the queue first`,
          ),
          { status: 409 },
        );
      }
    }

    if (["checked_in", "vitals_pending"].includes(rows[0].current_status)) {
      await advanceStatus(client, {
        visitId,
        toStatus: "with_vitals",
        actorRole: "vitals",
        actorId,
        allowSkip: true,
      });
    }
    await client.query("COMMIT");
    return { started: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// The patient got up, or was claimed by mistake — they go back to the queue
// rather than holding a chair they are not in. Mirrors releaseConsult and the
// MO's releaseWorkup, and is the way out of the refusal startVitals now gives.
export async function releaseVitals(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (rows[0].current_status !== "with_vitals") {
      throw Object.assign(new Error("This patient is not at the station"), { status: 409 });
    }
    // Through the engine's primitive, not a direct UPDATE: it writes the event
    // and clears the manual queue position the way every transition does.
    await returnToQueue(client, {
      visitId,
      toStatus: "vitals_pending",
      actorRole: "vitals",
      actorId,
      meta: { released: true },
    });
    await client.query("COMMIT");
    return { released: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export { IST_TODAY };
