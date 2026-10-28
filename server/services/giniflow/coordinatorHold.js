import pool from "../../config/db.js";
import { referralsFromNote } from "../healthray/noteSections.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { ONLINE_VISIT_SQL } from "./rxFollowups.js";
import { closeCoordinatorStep, insertCoordinatorStep } from "./journey.js";
import { CHAIN, STATUS_LABEL, TERMINAL_STATUSES } from "../../../shared/giniflowStatus.js";
import { specialtyLabel } from "../../../shared/giniflowReferrals.js";
import {
  AWAITING_COORDINATOR,
  HOLD_DECISIONS,
  HOLD_DECISION_LABEL,
  HOLD_NOTE_MAX,
  HOLD_NOTE_MIN,
  NOTE_REQUIRED_DECISIONS,
} from "../../../shared/coordinatorHold.js";
import { collectFollowups } from "../careFollowups/collect.js";

const OPENABLE = CHAIN.slice(CHAIN.indexOf("checked_in"), CHAIN.indexOf("rx_pending") + 1);
const GATED = ["with_rx", "pharmacy_pending"];
const REFERRAL_IN_NOTE = `'(consult(ation)?[[:space:]]+with|refer(red)?[[:space:]]+to|opinion)'`;
const REMOVED = "Referral removed";

const READY_RECHECK_MS = 60000;
let tableReady = false;
let readyCheckedAt = 0;

export async function holdsReady(db = pool) {
  if (tableReady) return true;
  if (Date.now() - readyCheckedAt < READY_RECHECK_MS) return false;
  readyCheckedAt = Date.now();
  const { rows } = await db.query(
    `SELECT to_regclass('public.giniflow_coordinator_holds') IS NOT NULL AS ok`,
  );
  tableReady = rows[0].ok;
  return tableReady;
}

const fail = (status, message, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });

const EVIDENCE_SQL = (where) => `
  SELECT v.id AS visit_id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
         COALESCE(v.echo_referral, FALSE) AS echo_referral,
         ${ONLINE_VISIT_SQL("v")} AS online,
         ${labOnlyPredicate("v", "$2")} AS lab_only,
         EXISTS (SELECT 1 FROM giniflow_referrals r WHERE r.visit_id = v.id) AS desk,
         EXISTS (SELECT 1 FROM referrals r
                   LEFT JOIN appointments ap ON ap.id = r.appointment_id
                  WHERE r.patient_id = v.patient_id
                    AND COALESCE(r.status, '') <> 'cancelled'
                    AND COALESCE(ap.appointment_date,
                                 (r.created_at AT TIME ZONE 'Asia/Kolkata')::date) = v.visit_date)
           AS scribe,
         ARRAY(SELECT a.healthray_clinical_notes FROM appointments a
                WHERE a.patient_id = v.patient_id AND a.appointment_date = v.visit_date
                  AND a.status IN ('completed', 'seen')
                  AND a.healthray_clinical_notes ~* ${REFERRAL_IN_NOTE}) AS notes,
         h.id AS hold_id, h.status AS hold_status, h.sources AS hold_sources
    FROM giniflow_visits v
    LEFT JOIN giniflow_coordinator_holds h ON h.visit_id = v.id
   WHERE v.merged_into_visit_id IS NULL AND ${where}`;

const sourcesOf = (row) =>
  [
    row.desk && "gf_referral",
    row.scribe && "rx_referral",
    (row.notes || []).some((note) => referralsFromNote(note).length) && "hr_note_referral",
    row.echo_referral && "echo_referral",
  ].filter(Boolean);

const sameSources = (a = [], b = []) => a.length === b.length && a.every((s) => b.includes(s));

const marker = (client, visitId, status, actorRole, actorId, meta) =>
  client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, $2, $3, $4, clock_timestamp(), $5)`,
    [visitId, status, actorRole, actorId, meta],
  );

export function planFor(row) {
  const sources = sourcesOf(row);
  const eligible = !row.online && !row.lab_only;
  if (!row.hold_id) {
    return eligible && sources.length && OPENABLE.includes(row.current_status)
      ? { open: sources }
      : null;
  }
  if (row.hold_status !== "waiting") return null;
  if (!eligible || !sources.length) return { skip: REMOVED };
  return sameSources(sources, row.hold_sources) ? null : { update: sources };
}

async function applyPlan(client, row, plan) {
  if (plan.open) {
    const { rows } = await client.query(
      `INSERT INTO giniflow_coordinator_holds (visit_id, patient_id, visit_date, sources)
       VALUES ($1, $2, $3::date, $4)
       ON CONFLICT (visit_id) DO NOTHING RETURNING id`,
      [row.visit_id, row.patient_id, row.visit_date, plan.open],
    );
    if (!rows.length) return null;
    await insertCoordinatorStep(client, row.visit_id);
    await marker(client, row.visit_id, "coordinator_hold", "system", null, {
      sources: plan.open,
    });
    return "opened";
  }
  if (plan.skip) {
    const { rowCount } = await client.query(
      `UPDATE giniflow_coordinator_holds
          SET status = 'skipped', skip_reason = $2, updated_at = NOW()
        WHERE visit_id = $1 AND status = 'waiting'`,
      [row.visit_id, plan.skip],
    );
    if (!rowCount) return null;
    await closeCoordinatorStep(client, row.visit_id, "skipped");
    await marker(client, row.visit_id, "coordinator_done", "system", null, {
      skipped: true,
      reason: plan.skip,
    });
    return "skipped";
  }
  await client.query(
    `UPDATE giniflow_coordinator_holds SET sources = $2, updated_at = NOW()
      WHERE visit_id = $1 AND status = 'waiting'`,
    [row.visit_id, plan.update],
  );
  return "updated";
}

export async function syncHoldIn(client, visitId) {
  if (!(await holdsReady(client))) return null;
  const { rows } = await client.query(EVIDENCE_SQL("v.id = $1"), [visitId, LAB_ONLY_DOCTOR]);
  if (!rows.length) return null;
  const plan = planFor(rows[0]);
  return plan ? applyPlan(client, rows[0], plan) : null;
}

export async function syncHoldSafely(client, visitId) {
  await client.query("SAVEPOINT coordinator_hold");
  try {
    const done = await syncHoldIn(client, visitId);
    await client.query("RELEASE SAVEPOINT coordinator_hold");
    return done;
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT coordinator_hold");
    console.error(`coordinator hold sync: visit ${visitId}: ${e.message}`);
    return null;
  }
}

export async function syncDayHolds(db, day) {
  const result = { opened: 0, skipped: 0, updated: 0, errors: 0 };
  if (!(await holdsReady(db))) return result;
  const { rows } = await db.query(
    EVIDENCE_SQL(`v.visit_date = $1::date
                  AND (h.id IS NULL OR h.status = 'waiting')
                  AND (h.id IS NOT NULL OR v.current_status = ANY($3))`),
    [day, LAB_ONLY_DOCTOR, OPENABLE],
  );
  for (const row of rows) {
    if (!planFor(row)) continue;
    const client = typeof db.release === "function" ? db : await db.connect();
    try {
      await client.query("BEGIN");
      const fresh = await client.query(`${EVIDENCE_SQL("v.id = $1")} FOR NO KEY UPDATE OF v`, [
        row.visit_id,
        LAB_ONLY_DOCTOR,
      ]);
      const plan = fresh.rows.length ? planFor(fresh.rows[0]) : null;
      const done = plan ? await applyPlan(client, fresh.rows[0], plan) : null;
      await client.query("COMMIT");
      if (done) result[done] += 1;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      result.errors += 1;
      console.error(`coordinator hold sync: visit ${row.visit_id}: ${e.message}`);
    } finally {
      if (client !== db) client.release();
    }
  }
  return result;
}

export async function syncReferralHold(patientId, appointmentId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.id FROM giniflow_visits v
        WHERE v.patient_id = $1 AND v.merged_into_visit_id IS NULL
          AND v.visit_date = COALESCE(
                (SELECT a.appointment_date FROM appointments a WHERE a.id = $2),
                (NOW() AT TIME ZONE 'Asia/Kolkata')::date)`,
      [patientId, appointmentId],
    );
    const done = rows.length ? await syncHoldSafely(client, rows[0].id) : null;
    await client.query("COMMIT");
    return done;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`coordinator hold sync: patient ${patientId}: ${e.message}`);
    return null;
  } finally {
    client.release();
  }
}

export async function assertCoordinatorDone(client, visitId, toStatus) {
  if (!GATED.includes(toStatus)) return;
  if (!(await holdsReady(client))) return;
  await syncHoldIn(client, visitId);
  const { rows } = await client.query(
    `SELECT status FROM giniflow_coordinator_holds WHERE visit_id = $1`,
    [visitId],
  );
  if (rows[0]?.status === "waiting") {
    throw fail(
      409,
      "This patient was referred — the Care Coordinator must see them before the prescription is explained",
      { reason: AWAITING_COORDINATOR },
    );
  }
}

export async function holdsForVisits(db, visitIds, now = new Date()) {
  const holds = new Map();
  if (!visitIds.length || !(await holdsReady(db))) return holds;
  const { rows } = await db.query(
    `SELECT visit_id, opened_at FROM giniflow_coordinator_holds
      WHERE visit_id = ANY($1::uuid[]) AND status = 'waiting'`,
    [visitIds],
  );
  for (const row of rows) {
    holds.set(row.visit_id, {
      waiting: true,
      blocking: true,
      minutes: Math.max(0, Math.round((now - new Date(row.opened_at)) / 60000)),
    });
  }
  return holds;
}

const ON_FLOOR_SQL = `
  SELECT h.visit_id, h.patient_id, h.status, h.decision, h.note, h.sources,
         h.opened_at, h.done_at, h.skip_reason,
         COALESCE(dd.short_name, dd.name) AS done_by_name,
         v.current_status, p.name, p.file_no, p.age, p.sex, p.phone,
         COALESCE(doc.short_name, doc.name) AS doctor_name,
         COALESCE((SELECT json_agg(json_build_object('specialty', r.specialty,
                                                     'doctor', r.to_doctor,
                                                     'hospital', r.hospital)
                                   ORDER BY r.created_at)
                     FROM giniflow_referrals r WHERE r.visit_id = v.id), '[]') AS desk,
         COALESCE((SELECT json_agg(json_build_object('specialty', r.speciality,
                                                     'doctor', r.doctor_name)
                                   ORDER BY r.created_at)
                     FROM referrals r
                     LEFT JOIN appointments ap ON ap.id = r.appointment_id
                    WHERE r.patient_id = v.patient_id
                      AND COALESCE(r.status, '') <> 'cancelled'
                      AND COALESCE(ap.appointment_date,
                                   (r.created_at AT TIME ZONE 'Asia/Kolkata')::date) = v.visit_date),
                  '[]') AS scribe,
         ARRAY(SELECT a.healthray_clinical_notes FROM appointments a
                WHERE a.patient_id = v.patient_id AND a.appointment_date = v.visit_date
                  AND a.status IN ('completed', 'seen')
                  AND a.healthray_clinical_notes ~* ${REFERRAL_IN_NOTE}) AS notes
    FROM giniflow_coordinator_holds h
    JOIN giniflow_visits v ON v.id = h.visit_id
    JOIN patients p ON p.id = h.patient_id
    LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
    LEFT JOIN doctors dd ON dd.id = h.done_by
   WHERE h.visit_date = $1::date AND h.status = ANY($2)
     AND ($3::boolean OR v.current_status <> ALL($4))
   ORDER BY h.opened_at`;

const referralsOf = (row) => [
  ...row.desk.map((r) => ({
    target: [specialtyLabel(r.specialty), r.doctor].filter(Boolean).join(" — "),
    where: r.hospital || null,
  })),
  ...row.scribe.map((r) => ({
    target: [r.specialty, r.doctor].filter(Boolean).join(" — ") || "Referral",
    where: null,
  })),
  ...(row.notes || [])
    .flatMap((note) => referralsFromNote(note))
    .map((r) => ({ target: r.reason, where: null })),
  ...((row.sources || []).includes("echo_referral") ? [{ target: "Echo", where: null }] : []),
];

const onFloorRow = (row, now) => ({
  visitId: row.visit_id,
  patientId: row.patient_id,
  name: row.name,
  fileNo: row.file_no,
  age: row.age,
  sex: row.sex,
  phone: row.phone,
  doctorName: row.doctor_name,
  status: row.current_status,
  statusLabel: STATUS_LABEL[row.current_status] || row.current_status,
  holdStatus: row.status,
  decision: row.decision,
  decisionLabel: row.decision ? HOLD_DECISION_LABEL[row.decision] : null,
  note: row.note || row.skip_reason || null,
  doneAt: row.done_at ? new Date(row.done_at).toISOString() : null,
  doneBy: row.done_by_name || null,
  openedAt: new Date(row.opened_at).toISOString(),
  minutes: Math.max(0, Math.round((now - new Date(row.opened_at)) / 60000)),
  referrals: referralsOf(row),
});

export async function listOnFloor(day, now = new Date(), db = pool) {
  if (!(await holdsReady(db))) {
    return { day, ready: false, blocking: false, waiting: [], done: [] };
  }
  const [{ rows: waiting }, { rows: done }] = await Promise.all([
    db.query(ON_FLOOR_SQL, [day, ["waiting"], false, TERMINAL_STATUSES]),
    db.query(ON_FLOOR_SQL, [day, ["done", "skipped"], true, TERMINAL_STATUSES]),
  ]);
  return {
    day,
    ready: true,
    blocking: true,
    waiting: waiting.map((r) => onFloorRow(r, now)),
    done: done.map((r) => onFloorRow(r, now)).reverse(),
  };
}

const cleanNote = (note, required) => {
  const text = typeof note === "string" ? note.trim() : "";
  if (required && text.length < HOLD_NOTE_MIN)
    throw fail(400, "Say what was decided — a few words are enough");
  if (text.length > HOLD_NOTE_MAX)
    throw fail(400, `Keep the note under ${HOLD_NOTE_MAX} characters`);
  return text || null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function withWaitingHold(visitId, db, work) {
  if (!UUID_RE.test(String(visitId))) {
    throw fail(404, "This patient is not waiting for the Care Coordinator");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT h.*, v.current_status FROM giniflow_coordinator_holds h
         JOIN giniflow_visits v ON v.id = h.visit_id
        WHERE h.visit_id = $1 FOR UPDATE OF h`,
      [visitId],
    );
    if (!rows.length) throw fail(404, "This patient is not waiting for the Care Coordinator");
    if (rows[0].status !== "waiting") {
      throw fail(409, "The Care Coordinator has already sent this patient on");
    }
    const result = await work(client, rows[0]);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const FOLLOWUP_MOVES = {
  booked_outside: { from: ["open", "booked"], to: "booked_outside" },
  declined: { from: ["open", "booked", "booked_outside"], to: "declined" },
  not_available: { from: ["open", "booked", "booked_outside"], to: "not_available" },
};

export async function applyDecisionToFollowups(hold, actorId = null, db = pool) {
  const label = HOLD_DECISION_LABEL[hold.decision];
  const note = `Care Coordinator on the floor: ${label}${hold.note ? ` — ${hold.note}` : ""}`;
  const move = FOLLOWUP_MOVES[hold.decision];
  const { rows: items } = await db.query(
    `SELECT id, status FROM care_followups
      WHERE patient_id = $1 AND ordered_on = $2::date
        AND status IN ('open', 'booked', 'booked_outside')`,
    [hold.patient_id, hold.visit_date],
  );
  for (const item of items) {
    const to = move?.from.includes(item.status) ? move.to : null;
    if (to) {
      await db.query(
        `UPDATE care_followups SET status = $2, outcome_reason = $3, updated_at = NOW()
          WHERE id = $1 AND status = $4`,
        [item.id, to, note, item.status],
      );
    }
    await db.query(
      `INSERT INTO care_followup_events (followup_id, kind, from_status, to_status, note, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [item.id, to ? "status" : "note", to ? item.status : null, to, note, actorId],
    );
  }
  return items.length;
}

const followUpAfterDone = (hold, actorId, db) =>
  collectFollowups({ db })
    .catch((e) => console.error("coordinator hold: follow-up collect failed:", e.message))
    .then(() => applyDecisionToFollowups(hold, actorId, db))
    .catch((e) => console.error("coordinator hold: follow-up update failed:", e.message));

export async function completeHold(visitId, { decision, note } = {}, ctx = {}, db = pool) {
  if (!HOLD_DECISIONS.some((d) => d.value === decision)) {
    throw fail(400, "Choose what was decided for the referral");
  }
  const text = cleanNote(note, NOTE_REQUIRED_DECISIONS.includes(decision));
  const actorId = ctx.actorId ?? null;
  const hold = await withWaitingHold(visitId, db, async (client, row) => {
    const { rows } = await client.query(
      `UPDATE giniflow_coordinator_holds
          SET status = 'done', decision = $2, note = $3, done_at = NOW(), done_by = $4,
              updated_at = NOW()
        WHERE visit_id = $1 RETURNING *`,
      [visitId, decision, text, actorId],
    );
    await closeCoordinatorStep(client, visitId, "done");
    await marker(client, visitId, "coordinator_done", "coordinator", actorId, {
      decision,
      note: text,
    });
    return { ...rows[0], visit_date: row.visit_date };
  });
  followUpAfterDone(hold, actorId, db);
  return { visitId, status: "done", decision, decisionLabel: HOLD_DECISION_LABEL[decision] };
}

export async function skipHold(visitId, { reason } = {}, ctx = {}, db = pool) {
  const text = cleanNote(reason, true);
  const actorId = ctx.actorId ?? null;
  await withWaitingHold(visitId, db, async (client) => {
    await client.query(
      `UPDATE giniflow_coordinator_holds
          SET status = 'skipped', skip_reason = $2, done_at = NOW(), done_by = $3,
              updated_at = NOW()
        WHERE visit_id = $1`,
      [visitId, text, actorId],
    );
    await closeCoordinatorStep(client, visitId, "skipped");
    await marker(client, visitId, "coordinator_done", "coordinator", actorId, {
      skipped: true,
      reason: text,
    });
  });
  return { visitId, status: "skipped" };
}
