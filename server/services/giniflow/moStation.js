import pool from "../../config/db.js";
import { OPEN_LAB_CASES_SQL } from "./labStation.js";
import { finalizeConsult } from "./finalize.js";
import { advanceStatus, budgetColour } from "./statusEngine.js";
import { getSlaConfig, budgetLookup } from "./board.js";
import { slaKeyForStatus, WAIT_SINCE_SQL } from "../../../shared/giniflowStatus.js";
import { todaysVitals, previousVitals } from "./visitVitals.js";
import { insertLabStepsForOrder } from "./journey.js";
import { ALLERGY_NOT_ASKED } from "../../../shared/giniflowAllergy.js";

// The MO / SD station — where the queue forms.
//
// Brief §4.3: queue of sd_pending for the logged-in SD, patient brief, plan
// textarea, and three actions. The one hard rule is that Close — sending a
// patient to pharmacy without the doctor seeing them — is green-category only.
//
// Design and the gaps it is built around: docs/gini-flow/08-MO-SD-STATION-PLAN.md

// The category no longer gates the close — the MO's recorded reading of the
// reports does (31 §4 D1). It is still exported: the triage smoke asserts a
// green patient is categorised as one, and the screen shows the category beside
// the decision as evidence.
export const CLOSEABLE_CATEGORY = "in_control";

// Can this patient be ended here, without the consultant? A plan has to exist,
// and reports — if any were ordered — have to have been read and called normal.
const closeableNow = ({ hasPlan, orders, outcome }) =>
  !!hasPlan && (orders === 0 || outcome === "normal");

// The orders that gate all of this: the ones that produce something to read
// TODAY. An order raised for tomorrow or the next visit produces no report now,
// and counting it deadlocked the patient — results_status could never reach
// "ready", so reviewReports refused ("the reports are not in yet") and the close
// refused in turn ("review the reports before closing"), for ever.
//
// One rule, used by the queue's grouping, the patient pane's canClose and the
// close itself. Three readings of "does this visit have tests" is how a row
// advertises closeable while the service refuses.
const GATING_ORDER_SQL = `o.urgency = 'today'`;

const gatingOrders = (orders = []) => orders.filter((o) => o.urgency === "today").length;

// Lab-track statuses that mean the sample has not been taken yet.
const UNCOLLECTED = ["ordered", "payment_pending", "paid"];

const QUEUE_STATUSES = [
  "checked_in",
  "vitals_pending",
  "with_vitals",
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "doctor_done",
  // Closing without the doctor finalizes, and finalize advances the visit past
  // doctor_done. Stopping the queue there made the patient vanish the moment the
  // MO closed them: no card, no list of who they had closed today, no way back
  // into the record. They belong in "Done", which is where groupOf puts them.
  "rx_pending",
  "with_rx",
];

const bioChips = (biomarkers) => {
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
  if (biomarkers.fg != null) {
    const v = Number(biomarkers.fg);
    chips.push({ label: `FBS ${v}`, tone: v > 130 ? "a" : "g" });
  }
  return chips;
};

// The line v2 and v3 put on every row: whether there is anything to work from.
const reportsLine = (resultsStatus, hasBiomarkers) => {
  if (resultsStatus === "ready") return { label: "✓ Reports complete", tone: "g" };
  if (resultsStatus === "partial") return { label: "Partial results", tone: "a" };
  if (hasBiomarkers) return { label: "✓ Previous reports on file", tone: "g" };
  return { label: "🔵 No reports", tone: "n" };
};

const QUEUE_SQL = `
  SELECT v.id, v.current_status, v.results_status, v.category, v.assigned_sd_id,
         v.appointment_time::text AS appointment_time, v.blocked_reason,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
         sd.short_name AS sd_name,
         seq.visit_number,
         a.biomarkers,
         a.pre_visit_compliance,
         first_ev.occurred_at AS checked_in_at,
         last_ev.occurred_at  AS status_since,
         (SELECT count(*)::int FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.sample_status <> 'uploaded'
             AND ${GATING_ORDER_SQL}) AS open_orders,
         -- How far the slowest outstanding order has got. "Waiting on results"
         -- is not one state: a sample nobody has drawn is the MO's to chase,
         -- one on the analyser is not.
         (SELECT o.sample_status FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.sample_status <> 'uploaded'
             AND ${GATING_ORDER_SQL}
           ORDER BY array_position(
             ARRAY['ordered','payment_pending','paid','sample_collected','processing','results_ready'],
             o.sample_status) LIMIT 1) AS lab_stage,
         ${OPEN_LAB_CASES_SQL} AS open_cases,
         (SELECT plan IS NOT NULL AND length(trim(plan)) > 0
            FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS has_plan,
         (SELECT reports_outcome FROM giniflow_sd_notes n WHERE n.visit_id = v.id)
           AS reports_outcome,
         -- Search runs here, not in the browser, for two reasons: the queue the
         -- MO can see is only part of the day, and a phone number is never sent
         -- to the client at all, so it is unsearchable anywhere else. Digits are
         -- compared to digits so "98765 43210" finds "+91-9876543210".
         ($3::text IS NULL
          OR p.name ILIKE '%' || $3 || '%'
          OR p.file_no ILIKE '%' || $3 || '%'
          OR ($4::text <> '' AND (
               regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE '%' || $4 || '%'
               OR EXISTS (
                    SELECT 1 FROM unnest(COALESCE(p.alt_phone, '{}'::text[])) ap
                     WHERE regexp_replace(ap, '\\D', '', 'g') LIKE '%' || $4 || '%')))
         ) AS matches
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors sd ON sd.id = v.assigned_sd_id
    LEFT JOIN appointments a ON a.id = v.appointment_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int + 1 AS visit_number FROM appointments pa
       WHERE pa.patient_id = v.patient_id AND pa.appointment_date < v.visit_date
         AND pa.status = 'completed'
    ) seq ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND e.status = 'checked_in' ORDER BY occurred_at LIMIT 1
    ) first_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND ${WAIT_SINCE_SQL("e", "v")}
       ORDER BY occurred_at DESC, id DESC LIMIT 1
    ) last_ev ON TRUE
   WHERE v.visit_date = $1::date
     AND v.current_status = ANY($2)
     AND NOT COALESCE(p.is_blocked, FALSE)
   ORDER BY v.appointment_time NULLS LAST, first_ev.occurred_at NULLS LAST`;

// Five groups, not four: "waiting on results" and "no reports at all" need
// different actions from the MO, so the prototypes count them separately and so
// do we. Merging them hides the only group an MO can unblock.
const waitMinutes = (row, now) =>
  row.status_since
    ? Math.max(0, Math.round((now.getTime() - new Date(row.status_since).getTime()) / 60000))
    : null;

const groupOf = (row, sdId) => {
  const mine = !row.assigned_sd_id || row.assigned_sd_id === sdId;
  if (row.current_status === "with_sd") return mine ? "withMe" : "withOtherSd";
  if (["ready_for_doctor", "doctor_done", "rx_pending", "with_rx"].includes(row.current_status)) {
    return mine ? "done" : "withOtherSd";
  }
  if (["vitals_done", "sd_pending"].includes(row.current_status)) {
    if (!mine) return "withOtherSd";
    // Either source counts: an MO waiting on bloods does not care which system
    // the order was raised in.
    const openLab = row.open_orders + row.open_cases;
    if (row.results_status !== "ready" && openLab > 0) return "awaitingResults";
    if (row.results_status !== "ready" && !row.biomarkers) return "missingReports";
    return "waitingForMe";
  }
  return "inPipeline";
};

export async function getMoQueue(visitDate, sdId = null, q = null, now = new Date(), db = pool) {
  // A typed % or _ is a character the MO meant, not a wildcard.
  const raw = typeof q === "string" && q.trim() ? q.trim() : null;
  const term = raw ? raw.replace(/[%_\\]/g, "\\$&") : null;
  const digits = raw ? raw.replace(/\D/g, "") : "";
  const [{ rows }, sla] = await Promise.all([
    db.query(QUEUE_SQL, [visitDate, QUEUE_STATUSES, term, digits]),
    getSlaConfig(db),
  ]);
  const budgetFor = budgetLookup(sla);

  const groups = {
    withMe: [],
    waitingForMe: [],
    awaitingResults: [],
    missingReports: [],
    inPipeline: [],
    done: [],
    withOtherSd: [],
  };

  const counters = {};
  for (const r of rows) {
    const compliancePct = r.pre_visit_compliance?.pct ?? null;
    const card = {
      visitId: r.id,
      patientId: r.patient_id,
      name: r.name,
      fileNo: r.file_no,
      age: r.age,
      sex: r.sex,
      visitNumber: r.visit_number,
      category: r.category,
      status: r.current_status,
      resultsStatus: r.results_status,
      sdName: r.sd_name,
      assignedSdId: r.assigned_sd_id,
      appointmentTime: (r.appointment_time || "").slice(0, 5) || null,
      // "Now" is the patient at the desk and "Next" the head of the waiting
      // queue, as the vitals station reads. Everyone else keeps their clock
      // time, which is the only useful thing to say about them.
      slot: null,
      checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).toISOString() : null,
      statusSince: r.status_since ? new Date(r.status_since).toISOString() : null,
      // The wait is judged against the same budget the board judges it by, so a
      // patient the coordinator sees in red is red at the MO's desk too. The
      // client recomputes the minutes every second; the budget and the colour
      // come from here, where the SLA config lives.
      waitMinutes: waitMinutes(r, now),
      waitBudget: budgetFor(slaKeyForStatus(r.current_status), r.category),
      waitColour: budgetColour(
        waitMinutes(r, now) ?? 0,
        budgetFor(slaKeyForStatus(r.current_status), r.category),
      ),
      bios: bioChips(r.biomarkers),
      reports: reportsLine(r.results_status, !!r.biomarkers),
      // v2 shows "74% compliance". Only render when the source has a value —
      // it exists on appointments but is unpopulated for most patients.
      compliancePct,
      openOrders: r.open_orders + r.open_cases,
      labStage: r.lab_stage || null,
      hasPlan: !!r.has_plan,
      canClose: closeableNow({
        hasPlan: r.has_plan,
        orders: r.open_orders + r.open_cases,
        outcome: r.reports_outcome,
      }),
      reportsOutcome: r.reports_outcome || null,
    };
    const group = groupOf(r, sdId);
    counters[group] = (counters[group] || 0) + 1;
    // Counters describe the whole day; the groups hold what the search matched.
    // Otherwise the header numbers would fall as the MO types, and a search
    // would read as patients leaving the floor.
    if (r.matches) groups[group].push(card);
  }

  // "Now" is the patient at the desk; "Next" is the head of the waiting queue.
  groups.withMe.forEach((c) => (c.slot = "Now"));
  if (groups.waitingForMe[0]) groups.waitingForMe[0].slot = "Next";
  for (const g of Object.values(groups))
    for (const c of g) c.slot = c.slot || c.appointmentTime || "—";

  const matched = Object.values(groups).reduce((n, g) => n + g.length, 0);

  return {
    ...groups,
    query: raw,
    matched,
    total: rows.length,
    counters: {
      withMe: counters.withMe || 0,
      waitingForMe: counters.waitingForMe || 0,
      awaitingResults: counters.awaitingResults || 0,
      missingReports: counters.missingReports || 0,
      closedByMe: counters.done || 0,
    },
  };
}

// The brief an MO reads before writing a plan.
export async function getMoPatient(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.current_status, v.results_status, v.category, v.patient_id,
            v.visit_date::text AS visit_date,
            v.assigned_sd_id, v.blocked_reason,
            p.name, p.file_no, p.age, p.sex, p.notes,
            p.allergy_status, p.allergy_note,
            a.biomarkers, a.compliance, a.pre_visit_compliance,
            a.opd_diagnoses, a.opd_medications,
            seq.visit_number,
            first_ev.occurred_at AS checked_in_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int + 1 AS visit_number FROM appointments pa
          WHERE pa.patient_id = v.patient_id AND pa.appointment_date < v.visit_date
            AND pa.status = 'completed'
       ) seq ON TRUE
       LEFT JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events e
          WHERE e.visit_id = v.id AND e.status = 'checked_in' ORDER BY occurred_at LIMIT 1
       ) first_ev ON TRUE
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return null;
  const v = rows[0];

  // Five reads that do not depend on each other. Run together: an MO tapping
  // through a queue pays one round trip per patient, not six.
  const [
    vitals,
    lastVitals,
    { rows: history },
    { rows: notes },
    { rows: proposals },
    { rows: orders },
    { rows: reports },
  ] = await Promise.all([
    // Today's reading and the one before it — the MO is reading a change, not a
    // number. Through the shared reader, because the reading may be in either
    // table: a patient whose nurse worked on HealthRay's screen has one, and
    // that reading is what advanced them to this desk.
    todaysVitals(visitId, { patientId: v.patient_id, visitDate: v.visit_date }, db),
    previousVitals(v.patient_id, v.visit_date, db),
    // The same markers from the visits before this one, newest first — a tile
    // shows a change, and a change needs the reading it changed from.
    db.query(
      `SELECT appointment_date, biomarkers FROM appointments
          WHERE patient_id = $1 AND biomarkers IS NOT NULL
            AND appointment_date < COALESCE(
                  (SELECT visit_date FROM giniflow_visits WHERE id = $2),
                  (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
          ORDER BY appointment_date DESC NULLS LAST LIMIT 6`,
      [v.patient_id, visitId],
    ),
    db.query(
      `SELECT plan, source, updated_at, reports_outcome, reports_reviewed_at, reports_review_note
         FROM giniflow_sd_notes WHERE visit_id = $1`,
      [visitId],
    ),
    db.query(
      `SELECT id, medicine_name, from_dose, to_dose, reason, change_type, status
           FROM giniflow_rx_proposals WHERE visit_id = $1 ORDER BY created_at`,
      [visitId],
    ),
    db.query(
      `SELECT o.id, o.urgency, o.payment_status, o.sample_status,
                COALESCE(json_agg(t.test_name ORDER BY t.test_name)
                         FILTER (WHERE t.test_name IS NOT NULL), '[]'::json) AS tests,
                -- Values the lab typed in rather than scanned. They are in
                -- lab_results like any other, so the chart and the trends have
                -- them already — this puts the numbers on the card where the MO
                -- is looking at the order they belong to. A scalar subquery, not
                -- a lateral: json has no equality operator, so it cannot be
                -- carried through the GROUP BY the tests need.
                COALESCE((
                  SELECT json_agg(json_build_object(
                           'testName', lr.test_name, 'value', lr.result,
                           'valueText', lr.result_text, 'unit', lr.unit,
                           'refRange', lr.ref_range, 'flag', lr.flag)
                         ORDER BY lr.flag NULLS LAST, lr.test_name)
                    FROM lab_results lr WHERE lr.lab_order_id = o.id
                ), '[]'::json) AS values
           FROM giniflow_lab_orders o
           LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
          WHERE o.visit_id = $1
          GROUP BY o.id ORDER BY o.created_at`,
      [visitId],
    ),
    db.query(
      `SELECT id, doc_type, title, doc_date, created_at, file_name, mime_type
         FROM documents WHERE patient_id = $1
        ORDER BY COALESCE(doc_date, created_at::date) DESC, created_at DESC LIMIT 30`,
      [v.patient_id],
    ),
  ]);

  return {
    visitId: v.id,
    patientId: v.patient_id,
    visitDate: v.visit_date,
    name: v.name,
    fileNo: v.file_no,
    age: v.age,
    sex: v.sex,
    visitNumber: v.visit_number,
    category: v.category,
    status: v.current_status,
    resultsStatus: v.results_status,
    assignedSdId: v.assigned_sd_id,
    checkedInAt: v.checked_in_at ? new Date(v.checked_in_at).toISOString() : null,
    canClose: closeableNow({
      hasPlan: !!notes[0]?.plan?.trim(),
      // Not orders.length: the list below shows tomorrow's and next visit's
      // orders too, and those gate nothing today.
      orders: gatingOrders(orders),
      outcome: notes[0]?.reports_outcome,
    }),
    reportsOutcome: notes[0]?.reports_outcome || null,
    reportsReviewNote: notes[0]?.reports_review_note || null,
    reportsReviewedAt: notes[0]?.reports_reviewed_at
      ? new Date(notes[0].reports_reviewed_at).toISOString()
      : null,
    // `patients.allergy_status` exists now (24-ADDENDUM-V11-PLAN.md §5.1). A
    // patient nobody has asked yet is NULL in the column and "not_known" here,
    // so every screen deals with the three states and none of them has to read
    // an absent answer as "no allergies".
    allergyStatus: v.allergy_status || ALLERGY_NOT_ASKED,
    allergyNote: v.allergy_note,
    // No phase column exists either (plan §3b.1). Omitted rather than guessed.
    vitals,
    lastVitals,
    biomarkers: v.biomarkers || null,
    // Oldest first, so a sparkline reads left to right.
    biomarkerHistory: history
      .map((h) => ({ date: h.appointment_date, biomarkers: h.biomarkers }))
      .reverse(),
    previousBiomarkers: history[0]?.biomarkers || null,
    // The prototype's urgency reads "Next visit · Nov 2026". The date lives on
    // the appointment's biomarkers blob as `followup`; when it is absent the
    // screen says "Next visit" and nothing more, rather than inventing a month.
    nextVisitDate: v.biomarkers?.followup || null,
    compliance: v.compliance || null,
    compliancePct: v.pre_visit_compliance?.pct ?? null,
    diagnoses: v.opd_diagnoses || null,
    medications: v.opd_medications || null,
    reports,
    plan: notes[0]?.plan ?? "",
    planUpdatedAt: notes[0]?.updated_at ?? null,
    proposals,
    orders: orders.map((o) => ({ ...o, tests: o.tests || [], values: o.values || [] })),
  };
}

// Plan §6 rule 3. Until now the rule lived only in the screen, which hid the
// buttons — but a hidden button is not a rule, and the action behind one of
// these buttons sends a patient home without a doctor seeing them. An
// unassigned patient stays open to anyone (first-claim, plan §7); once someone
// holds them, everybody else must take over explicitly, which is logged.
async function assertOwner(db, visitId, actorId) {
  const { rows } = await db.query(
    `SELECT v.assigned_sd_id, d.short_name
       FROM giniflow_visits v
       LEFT JOIN doctors d ON d.id = v.assigned_sd_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const owner = rows[0].assigned_sd_id;
  if (owner && owner !== actorId) {
    throw Object.assign(
      new Error(
        `${rows[0].short_name || "Another MO"} is working this patient — take over first if they have handed them to you`,
      ),
      { status: 409, assignedTo: owner },
    );
  }
  return owner;
}

// The explicit hand-off between MOs: a shift change, or a patient genuinely
// passed across the desk. Recorded, because "who was working this patient" is a
// question the day's log has to be able to answer.
export async function takeOver(visitId, actorId = null, db = pool) {
  if (!actorId)
    throw Object.assign(new Error("Sign in as an MO to take a patient over"), { status: 403 });
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status, assigned_sd_id FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (rows[0].assigned_sd_id === actorId) {
      await client.query("COMMIT");
      return { takenOver: false, assignedTo: actorId };
    }
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
       VALUES ($1, $2, 'mo_sd', $3, $4)`,
      [visitId, rows[0].current_status, actorId, { taken_over_from: rows[0].assigned_sd_id }],
    );
    await client.query(
      `UPDATE giniflow_visits SET assigned_sd_id = $2, updated_at = NOW() WHERE id = $1`,
      [visitId, actorId],
    );
    await client.query("COMMIT");
    return { takenOver: true, assignedTo: actorId, from: rows[0].assigned_sd_id };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Claiming mirrors the vitals station: the board's "With SD / MO" column and the
// queue's "with me now" must agree with what is physically happening.
export async function startWorkup(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.current_status, v.assigned_sd_id,
              (SELECT COALESCE(d.short_name, d.name) FROM doctors d
                WHERE d.id = v.assigned_sd_id) AS assigned_sd_name
         FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });

    // One patient, one desk. This used to be a deliberate no-op — a second MO
    // opening the card kept the first as owner and was let through — but the
    // patient is physically at one desk, and two MOs working the same visit
    // meant two sets of test orders and medicine proposals against it. The
    // second is now refused; releaseWorkup is how the first hands over.
    if (
      actorId &&
      rows[0].current_status === "with_sd" &&
      rows[0].assigned_sd_id &&
      rows[0].assigned_sd_id !== actorId
    ) {
      throw Object.assign(
        new Error(
          `This patient is already with ${rows[0].assigned_sd_name || "another MO"} — they cannot be in two places at once`,
        ),
        { status: 409 },
      );
    }

    // Only from the two statuses that mean "vitals are done, this patient is
    // mine to work up". Claiming from checked_in would skip the vitals station
    // entirely — no reading taken, the vitals budget measuring nothing, and the
    // board showing them at the SD desk while they wait for their BP.
    const CLAIMABLE = ["vitals_done", "sd_pending"];
    if (CLAIMABLE.includes(rows[0].current_status)) {
      await advanceStatus(client, {
        visitId,
        toStatus: "with_sd",
        actorRole: "mo_sd",
        actorId,
      });
    } else if (rows[0].current_status !== "with_sd") {
      throw Object.assign(
        new Error(
          `This patient is at ${rows[0].current_status.replace(/_/g, " ")} — they reach you once vitals are done`,
        ),
        { status: 409 },
      );
    }
    // First MO to open an unassigned patient takes them; anyone else has been
    // refused above, so reaching here means it is theirs or nobody's.
    if (!rows[0].assigned_sd_id && actorId) {
      await client.query(`UPDATE giniflow_visits SET assigned_sd_id = $2 WHERE id = $1`, [
        visitId,
        actorId,
      ]);
    }
    await client.query("COMMIT");
    return { started: true, assignedTo: rows[0].assigned_sd_id || actorId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Autosaved draft. Upsert, not append: the plan that matters is the one standing
// at hand-off, and an MO interrupted mid-workup should find what they typed.
export async function savePlan(visitId, { plan, source = "typed", actorId = null }, db = pool) {
  await assertOwner(db, visitId, actorId);
  const { rows } = await db.query(
    `INSERT INTO giniflow_sd_notes (visit_id, plan, source, authored_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (visit_id) DO UPDATE
       SET plan = EXCLUDED.plan, source = EXCLUDED.source,
           authored_by = COALESCE(EXCLUDED.authored_by, giniflow_sd_notes.authored_by),
           updated_at = NOW()
     RETURNING updated_at`,
    [visitId, plan ?? "", source, actorId],
  );
  return { savedAt: rows[0].updated_at };
}

export async function addProposal(visitId, proposal, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO giniflow_rx_proposals
       (visit_id, medicine_name, from_dose, to_dose, reason, change_type, proposed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, medicine_name, from_dose, to_dose, reason, change_type, status`,
    [
      visitId,
      proposal.medicineName,
      proposal.fromDose ?? null,
      proposal.toDose ?? null,
      proposal.reason ?? null,
      proposal.changeType ?? "changed",
      proposal.actorId ?? null,
    ],
  );
  return rows[0];
}

export async function withdrawProposal(proposalId, db = pool) {
  const { rowCount } = await db.query(
    `DELETE FROM giniflow_rx_proposals WHERE id = $1 AND status = 'proposed'`,
    [proposalId],
  );
  if (!rowCount) {
    throw Object.assign(new Error("Proposal not found, or already decided by the doctor"), {
      status: 409,
    });
  }
  return { withdrawn: true };
}

export async function getTestPanels(db = pool) {
  const { rows: panels } = await db.query(
    `SELECT panel_key, label, icon, test_names FROM giniflow_test_panels
      WHERE is_active ORDER BY display_order`,
  );
  const { rows: tests } = await db.query(
    `SELECT test_name, price, gloss FROM giniflow_test_catalog WHERE is_active ORDER BY test_name`,
  );
  return {
    panels: panels.map((p) => ({
      key: p.panel_key,
      label: p.label,
      icon: p.icon,
      tests: p.test_names,
    })),
    // The gloss is why an MO picks a test, so it travels with the price.
    tests: tests.map((t) => ({ name: t.test_name, price: Number(t.price), gloss: t.gloss })),
  };
}

// Trigger 2: ordering tests creates the lab order reception collects against.
// Prices are copied from the catalogue onto the order lines and totalled onto the
// order, so the patient is charged what they were quoted even if the catalogue
// moves afterwards.
export async function orderTests(
  visitId,
  { urgency, tests = [], customTests = [], actorId = null },
  db = pool,
) {
  // Two kinds of line on one order: tests from the clinic's catalogue, priced
  // from it, and tests typed in for THIS patient, which exist only on this
  // order. A one-off ultrasound is not a test the whole clinic should be
  // offered from then on, which is what putting it in the catalogue would mean.
  const custom = (Array.isArray(customTests) ? customTests : [])
    .map((t) => ({
      name: String(t?.name || "")
        .replace(/\s+/g, " ")
        .trim(),
      price: Number(t?.price) > 0 ? Number(t.price) : 0,
    }))
    .filter((t) => t.name.length >= 2);
  const catalogueNames = (Array.isArray(tests) ? tests : []).filter(Boolean);

  const seen = new Set(catalogueNames.map((n) => n.toUpperCase()));
  const customOnly = custom.filter((t) => !seen.has(t.name.toUpperCase()));

  if (!catalogueNames.length && !customOnly.length) {
    throw Object.assign(new Error("No tests selected"), { status: 400 });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertOwner(client, visitId, actorId);

    const { rows: visitRows } = await client.query(
      `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!visitRows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const current = visitRows[0].current_status;

    const { rows: priced } = await client.query(
      `SELECT test_name, price FROM giniflow_test_catalog WHERE test_name = ANY($1)`,
      [catalogueNames],
    );
    const priceOf = Object.fromEntries(priced.map((r) => [r.test_name, Number(r.price)]));
    const uncatalogued = catalogueNames.filter((name) => priceOf[name] === undefined);
    if (uncatalogued.length)
      throw Object.assign(new Error(`Not in the test catalogue: ${uncatalogued.join(", ")}`), {
        status: 400,
      });
    for (const t of customOnly) priceOf[t.name] = t.price;
    const tests = [...catalogueNames, ...customOnly.map((t) => t.name)];
    // MO-12: the same panel confirmed twice is two lab orders, two payment cards
    // on reception's desk and two charges. Only an order whose sample has not
    // been taken counts — once the blood is drawn, re-ordering the same test is
    // a genuine repeat, which is a real thing an MO does.
    const { rows: already } = await client.query(
      `SELECT DISTINCT t.test_name
         FROM giniflow_lab_orders o
         JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 AND t.test_name = ANY($2)
          AND o.sample_status = ANY($3)`,
      [visitId, tests, UNCOLLECTED],
    );
    if (already.length)
      throw Object.assign(
        new Error(
          `Already ordered and not yet collected: ${already.map((r) => r.test_name).join(", ")}`,
        ),
        { status: 409, duplicates: already.map((r) => r.test_name) },
      );

    const total = tests.reduce((sum, name) => sum + priceOf[name], 0);

    const order = await client.query(
      `INSERT INTO giniflow_lab_orders
         (visit_id, ordered_by, urgency, payment_status, amount_total, sample_status)
       VALUES ($1, $2, $3, 'pending', $4, 'payment_pending')
       RETURNING id`,
      [visitId, actorId, urgency, total],
    );
    const orderId = order.rows[0].id;

    await client.query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
       SELECT $1, * FROM UNNEST($2::text[], $3::numeric[])`,
      [orderId, tests, tests.map((n) => priceOf[n])],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
       VALUES ($1, 'payment', 'pending', 'mo_sd', $2)`,
      [orderId, actorId],
    );

    // Ordering today's tests ends this sitting: the patient goes to reception
    // and the lab, the MO takes the next one, and they come back when the
    // reports land. Three things depended on this and none of them worked while
    // the patient stayed at `with_sd`:
    //
    //   - the lab could not draw the sample at all — `with_sd` is a room, and
    //     the lab station refuses to collect from a patient another station has;
    //   - the MO's own "waiting on results" group only holds `vitals_done` /
    //     `sd_pending`, so the patient they had just sent to the lab never
    //     appeared in it;
    //   - the desk stayed occupied, so the queue behind them did not move.
    //
    // Written directly, like `releaseWorkup`: `sd_pending` is behind `with_sd`
    // and the chain only moves forwards. The MO keeps the patient
    // (`assigned_sd_id` is untouched) so the reports come back to them.
    let sentToLab = false;
    if (urgency === "today" && current === "with_sd") {
      await client.query(
        `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
         VALUES ($1, 'sd_pending', 'mo_sd', $2, $3)`,
        [visitId, actorId, { source: "lab_ordered", lab_order_id: orderId, tests: tests.length }],
      );
      await client.query(
        `UPDATE giniflow_visits SET current_status = 'sd_pending', updated_at = NOW()
          WHERE id = $1`,
        [visitId],
      );
      sentToLab = true;
    }

    // The journey the patient is shown, and the counter they are about to stand
    // at. Only today's tests: a next-visit panel is not a stop on this visit.
    if (urgency === "today") await insertLabStepsForOrder(client, visitId);

    await client.query("COMMIT");
    return {
      orderId,
      urgency,
      tests,
      total,
      sentToLab,
      // Only today's tests reach reception now; the rest wait for their day.
      reachesReceptionToday: urgency === "today",
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// MO-15: an MO who taps the wrong card has claimed the patient, and the chain
// only moves forwards — so without this the mistake has no exit and the patient
// sits at a desk nobody is working. This is a correction, not a transition:
// it writes the patient back to the queue they came from and records why.
export async function releaseWorkup(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.current_status, v.assigned_sd_id,
              (SELECT plan FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS plan
         FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (rows[0].assigned_sd_id && rows[0].assigned_sd_id !== actorId)
      throw Object.assign(new Error("This patient is not yours to put back"), { status: 409 });
    if (rows[0].current_status !== "with_sd")
      throw Object.assign(
        new Error(
          `This patient is at ${rows[0].current_status.replace(/_/g, " ")} — only a patient open at your desk can be put back`,
        ),
        { status: 409 },
      );

    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
       VALUES ($1, 'sd_pending', 'mo_sd', $2, $3)`,
      [visitId, actorId, { released: true, had_plan: !!rows[0].plan?.trim() }],
    );
    await client.query(
      `UPDATE giniflow_visits
          SET current_status = 'sd_pending', assigned_sd_id = NULL, updated_at = NOW()
        WHERE id = $1`,
      [visitId],
    );
    await client.query("COMMIT");
    return { released: true, status: "sd_pending" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function readyForDoctor(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // A patient handed over with no plan wastes the consultation the whole board
    // exists to protect.
    await assertOwner(client, visitId, actorId);
    const { rows } = await client.query(
      `SELECT (SELECT plan FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS plan
         FROM giniflow_visits v WHERE v.id = $1`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (!rows[0].plan || !rows[0].plan.trim()) {
      throw Object.assign(new Error("Write a plan before handing this patient to the doctor"), {
        status: 409,
      });
    }

    // A one-status move from with_sd; allowSkip was suppressing the guard that
    // catches a hand-over from a patient who never reached the desk.
    await advanceStatus(client, {
      visitId,
      toStatus: "ready_for_doctor",
      actorRole: "mo_sd",
      actorId,
    });
    await client.query("COMMIT");
    return { status: "ready_for_doctor" };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Close sends a patient to pharmacy without a doctor seeing them. Green category
// only, enforced here — the button is hidden for everyone else, but a hidden
// button is not a rule, and this is the one action on the floor that removes a
// consultation.
export async function closeWithoutDoctor(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertOwner(client, visitId, actorId);
    const { rows } = await client.query(
      // Subselects, not a LEFT JOIN: FOR UPDATE cannot be applied to the
      // nullable side of an outer join, and the row that must be locked is the
      // visit.
      `SELECT v.category, v.results_status,
              (SELECT plan FROM giniflow_sd_notes n WHERE n.visit_id = v.id) AS plan,
              (SELECT reports_outcome FROM giniflow_sd_notes n WHERE n.visit_id = v.id)
                AS reports_outcome,
              (SELECT count(*)::int FROM giniflow_lab_orders o
                WHERE o.visit_id = v.id AND ${GATING_ORDER_SQL}) AS orders
         FROM giniflow_visits v
        WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    const { plan, reports_outcome: outcome, orders } = rows[0];

    if (!plan || !plan.trim()) {
      throw Object.assign(new Error("Write a plan before closing this patient"), { status: 409 });
    }

    // The gate is the MO's recorded reading of the reports, not the category
    // (31 §4 D1). A patient with no tests ordered has nothing to have read, so
    // the plan above is the whole record; one with reports must have them read
    // and called normal, by name and at a time, before the consultation is
    // removed from their visit.
    if (orders > 0 && outcome !== "normal") {
      throw Object.assign(
        new Error(
          outcome === "needs_consultant"
            ? "You marked these reports as needing the consultant — send them on instead"
            : "Review the reports before closing this patient",
        ),
        { status: 409 },
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    // If the connection has dropped, ROLLBACK rejects too — and the release
    // below it would never run, losing a client from the pool every time. Every
    // sibling in this file uses `finally` for exactly that reason.
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Finalize owns the atomic save, the medicine matching, the card, the
  // counselling note and the status. Closing without it left the draft in
  // `giniflow_rx_items` and sent the patient to a pharmacy with no prescription
  // at all (31 §3 G4) — so the close IS the finalize, not a status change
  // beside one.
  const result = await finalizeConsult(visitId, actorId, db, { closedBySd: true });
  return { ...result, status: "doctor_done", skippedDoctor: true };
}

// The MO's attestation that they read the reports and what they concluded. The
// close gate reads `normal` from here; `needs_consultant` is the referral, and
// the screen turns it into the existing hand-off to the consultant.
export async function reviewReports(visitId, { outcome, note = null, actorId = null }, db = pool) {
  if (!["normal", "needs_consultant"].includes(outcome)) {
    throw Object.assign(new Error(`Unknown review outcome: ${outcome}`), { status: 400 });
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await assertOwner(client, visitId, actorId);
    const { rows } = await client.query(
      `SELECT results_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (rows[0].results_status !== "ready") {
      throw Object.assign(new Error("The reports are not in yet — there is nothing to review"), {
        status: 409,
      });
    }

    await client.query(
      `INSERT INTO giniflow_sd_notes (visit_id, reports_reviewed_at, reports_reviewed_by,
                                      reports_outcome, reports_review_note)
       VALUES ($1, NOW(), $2, $3, $4)
       ON CONFLICT (visit_id) DO UPDATE
         SET reports_reviewed_at  = NOW(),
             reports_reviewed_by  = EXCLUDED.reports_reviewed_by,
             reports_outcome      = EXCLUDED.reports_outcome,
             reports_review_note  = COALESCE(EXCLUDED.reports_review_note,
                                             giniflow_sd_notes.reports_review_note)`,
      [visitId, actorId, outcome, note],
    );
    await client.query(
      `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
       VALUES ($1, 'reports_reviewed', 'mo_sd', $2, $3)`,
      [visitId, actorId, { outcome, source: "mo_review" }],
    );
    await client.query("COMMIT");
    return { visitId, outcome };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
