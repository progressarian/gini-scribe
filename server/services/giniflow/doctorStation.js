import pool from "../../config/db.js";
import { advanceStatus, budgetColour, returnToQueue } from "./statusEngine.js";
import { getSlaConfig, budgetMap, budgetLookup } from "./board.js";
import { slaKeyForStatus, STATUS_LABEL } from "../../../shared/giniflowStatus.js";
import { todaysVitals, previousVitals } from "./visitVitals.js";
import { buildBrief } from "./consultBrief.js";
import { seedDraftOn } from "./prescription.js";
import { OPEN_LAB_CASES_SQL } from "./labStation.js";

// The consultant's station — the queue that forms in front of Dr. Bhansali, and
// the consult screen itself.
//
// Design: docs/gini-flow/13-CONSULTANT-STATION-PLAN.md
// Part 2 (prescription, tests, medicine card, Finalize): prescription.js,
// medicineCard.js, finalize.js.
//
// The consultant is the floor's known bottleneck — `wait_doctor` is the column
// the whole day backs up behind — so this queue leads with waiting time, and
// the groups are ordered by what the consultant can act on next.

const QUEUE_STATUSES = [
  "checked_in",
  "vitals_pending",
  "with_vitals",
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
  "doctor_done",
  "pharmacy_pending",
  "dispensed",
  "exited",
  "blocked_reports",
];

const DONE_STATUSES = [
  "doctor_done",
  "rx_pending",
  "with_rx",
  "pharmacy_pending",
  "dispensed",
  "exited",
];

// The journey rail every card carries: Check-in › Vitals › MO › With Dr. › Pharmacy.
const RAIL = [
  { key: "checkin", label: "Check-in", statuses: ["checked_in", "vitals_pending"] },
  { key: "vitals", label: "Vitals", statuses: ["with_vitals", "vitals_done"] },
  { key: "mo", label: "MO", statuses: ["sd_pending", "with_sd"] },
  { key: "doctor", label: "With Dr.", statuses: ["ready_for_doctor", "with_doctor"] },
  {
    key: "rx",
    label: "Prescription Explain",
    statuses: ["doctor_done", "rx_pending", "with_rx"],
  },
  { key: "pharmacy", label: "Pharmacy", statuses: ["pharmacy_pending"] },
];

const railFor = (status, reachedKeys) =>
  RAIL.map((step) => {
    const current = step.statuses.includes(status);
    return {
      key: step.key,
      label: step.label,
      state: current ? "current" : reachedKeys.has(step.key) ? "done" : "todo",
    };
  });

const minutesSince = (from, now) =>
  from ? Math.max(0, Math.round((now.getTime() - new Date(from).getTime()) / 60000)) : null;

// Four groups (plan §4.2). A patient whose reports have not arrived stays in
// "pipeline" however long they have waited — calling them in is exactly the
// wasted consultation this system exists to prevent.
//
// But "waiting on results" and "has no tests" are not the same thing, and
// reading `results_status` alone conflated them: `none` means *no lab work
// exists for this visit*, not *the results have not come back*. Every patient
// handed over on a day when nobody ordered a test was filed under "not ready
// yet — can't proceed", which is the opposite of true. The question is whether
// anything is actually outstanding, so that is what this asks.
const waitingOnLab = (row) =>
  row.results_status === "partial" ||
  (row.results_status !== "ready" && row.open_orders + row.open_cases > 0);

//
// Ownership is part of the answer, not a filter applied afterwards. "With me
// now" has to mean *me*: a patient in a colleague's room is real and worth
// seeing on the All scope, but under its own heading.
const groupOf = (row, isMine) => {
  if (row.current_status === "with_doctor") return isMine ? "withMe" : "withOtherDoctor";
  if (DONE_STATUSES.includes(row.current_status)) return "done";
  if (row.current_status === "ready_for_doctor" && !waitingOnLab(row)) {
    return isMine ? "resultsReady" : "pipeline";
  }
  return "pipeline";
};

const resultsLine = (row) => {
  if (row.results_status === "ready") {
    return { status: "ready", label: row.lab_name ? `✓ ${row.lab_name}` : "✓ Ready" };
  }
  if (row.results_status === "partial") return { status: "partial", label: "Partial results" };
  if (row.open_orders + row.open_cases > 0) return { status: "awaiting", label: "Awaiting lab" };
  if (row.biomarkers) return { status: "previous", label: "Previous reports on file" };
  return { status: "missing", label: "✗ Missing — no reports yet" };
};

const QUEUE_SQL = `
  SELECT v.id, v.current_status, v.results_status, v.category, v.blocked_reason,
         v.priority, v.priority_reason, v.assigned_doctor_id, v.assigned_sd_id,
         v.appointment_time::text AS appointment_time,
         p.id AS patient_id, p.name, p.file_no, p.age, p.sex,
         COALESCE(doc.short_name, doc.name) AS doctor_name,
         sd.short_name  AS sd_name,
         seq.visit_number,
         a.biomarkers,
         first_ev.occurred_at AS checked_in_at,
         last_ev.occurred_at  AS status_since,
         (SELECT count(*)::int FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.sample_status <> 'uploaded') AS open_orders,
         ${OPEN_LAB_CASES_SQL} AS open_cases,
         -- Which rail steps this visit has actually passed through. Read from the
         -- log rather than inferred from the current status, so a patient the
         -- HealthRay sync jumped forward does not show phantom completed steps.
         (SELECT array_agg(DISTINCT e.status) FROM giniflow_visit_events e
           WHERE e.visit_id = v.id) AS reached,
         -- Either table, for the reason visitVitals.js gives: a nurse working on
         -- HealthRay's screen writes the older one, and that reading is what
         -- moved the patient here.
         COALESCE(
           (SELECT max(gv.recorded_at) FROM giniflow_vitals gv WHERE gv.visit_id = v.id),
           (SELECT max(tv.recorded_at) FROM vitals tv
             WHERE tv.patient_id = v.patient_id
               AND (tv.recorded_at AT TIME ZONE 'Asia/Kolkata')::date = v.visit_date)
         ) AS vitals_at,
         ($3::text IS NULL
          OR p.name ILIKE '%' || $3 || '%'
          OR p.file_no ILIKE '%' || $3 || '%') AS matches
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
    LEFT JOIN doctors sd  ON sd.id  = v.assigned_sd_id
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
       WHERE e.visit_id = v.id ORDER BY occurred_at DESC, id DESC LIMIT 1
    ) last_ev ON TRUE
   WHERE v.visit_date = $1::date
     AND v.current_status = ANY($2)
     AND NOT COALESCE(p.is_blocked, FALSE)
   ORDER BY v.appointment_time NULLS LAST, first_ev.occurred_at NULLS LAST`;

const RAIL_STATUS_TO_KEY = new Map(RAIL.flatMap((step) => step.statuses.map((s) => [s, step.key])));

// `dispensed` and `exited` are past the last rail step rather than on it, so
// they mark Pharmacy done — otherwise a patient who has gone home shows a rail
// with the last stop still empty.
const REACHED_EXTRA = { dispensed: "pharmacy", exited: "pharmacy" };

const reachedKeysFor = (reached) => {
  const keys = new Set();
  for (const status of reached || []) {
    const key = RAIL_STATUS_TO_KEY.get(status) || REACHED_EXTRA[status];
    if (key) keys.add(key);
  }
  return keys;
};

// The two numbers the prototype puts on every card. Taken from the appointment's
// biomarkers, the same blob the MO station's chips read, and chosen by the
// consult brief's ranking so the card and the consult agree about what matters.
const keyNumbersFor = (biomarkers) => {
  if (!biomarkers) return [];
  const { tiles } = buildBrief(biomarkers, {});
  return tiles
    .filter((t) => t.value !== null && t.value !== undefined)
    .slice(0, 2)
    .map((t) => ({ test: t.label, value: String(t.value), unit: t.unit }));
};

export async function getDoctorQueue(
  visitDate,
  { doctorId = null, scope = "mine", q = null } = {},
  now = new Date(),
  db = pool,
) {
  const raw = typeof q === "string" && q.trim() ? q.trim() : null;
  const term = raw ? raw.replace(/[%_\\]/g, "\\$&") : null;

  const [{ rows }, sla, { rows: durations }] = await Promise.all([
    db.query(QUEUE_SQL, [visitDate, QUEUE_STATUSES, term]),
    getSlaConfig(db),
    // Time actually spent in the room today: the gap between entering
    // `with_doctor` and whatever event followed it. Derived from the log rather
    // than stored, like every other duration in Gini Flow.
    db.query(
      `SELECT v.assigned_doctor_id,
              EXTRACT(EPOCH FROM (next_ev.occurred_at - e.occurred_at)) / 60 AS minutes
         FROM giniflow_visit_events e
         JOIN giniflow_visits v ON v.id = e.visit_id
         JOIN LATERAL (
           SELECT occurred_at FROM giniflow_visit_events n
            WHERE n.visit_id = e.visit_id
              AND (n.occurred_at, n.id) > (e.occurred_at, e.id)
            ORDER BY n.occurred_at, n.id LIMIT 1
         ) next_ev ON TRUE
        WHERE v.visit_date = $1::date AND e.status = 'with_doctor'`,
      [visitDate],
    ),
  ]);
  const budgetFor = budgetLookup(sla);
  // The two day-level figures below are averages over every category, so they
  // read the base budgets — an override belongs to one patient, not to a mean.
  const budgets = budgetMap(sla);

  // Gini runs one main consultant today, but a query that hard-codes that is a
  // rewrite the day it stops being true. An unassigned visit belongs to whoever
  // is looking — it has not been claimed by anyone else.
  const mine = (r) => !r.assigned_doctor_id || !doctorId || r.assigned_doctor_id === doctorId;
  const inScope = (r) => scope === "all" || mine(r);

  const groups = { withMe: [], withOtherDoctor: [], resultsReady: [], pipeline: [], done: [] };
  // Patients in the pipeline who belong to ANOTHER consultant, kept by consultant
  // rather than dropped. Without this the queue answered "who is coming to me"
  // but not "who is on the floor at all" — and a consultant covering a colleague,
  // or wondering why the doctor queue is empty while the floor is full, could not
  // see it. An unassigned patient is not here: nobody has claimed them, so they
  // stay in the signed-in consultant's own list where they can be picked up.
  const othersPipeline = new Map();
  const counters = {
    withMe: 0,
    withOtherDoctor: 0,
    resultsReady: 0,
    pipeline: 0,
    done: 0,
    missingResults: 0,
    total: 0,
  };
  const completedDurations = durations
    .filter((d) => (!doctorId || scope === "all" ? true : d.assigned_doctor_id === doctorId))
    .map((d) => Math.max(0, Math.round(Number(d.minutes))))
    .filter((m) => Number.isFinite(m));

  for (const row of rows) {
    const isMine = mine(row);
    const group = groupOf(row, isMine);
    // Another consultant's patient who has not reached anyone yet: shown in the
    // second column of the pipeline, whatever the scope toggle says, because
    // that column is exactly the question "who is waiting for someone else".
    const belongsToOther = !isMine && group === "pipeline";
    if (!inScope(row) && !belongsToOther) continue;
    counters.total++;

    if (!belongsToOther) counters[group]++;
    // Same distinction: this counts patients the lab is still holding up, not
    // every patient who happens to have no tests today.
    if (!DONE_STATUSES.includes(row.current_status) && waitingOnLab(row)) {
      counters.missingResults++;
    }

    const waited = minutesSince(row.status_since, now);
    const budget = budgetFor(slaKeyForStatus(row.current_status), row.category);

    const card = {
      visitId: row.id,
      patientId: row.patient_id,
      name: row.name,
      fileNo: row.file_no,
      age: row.age,
      sex: row.sex,
      visitNumber: row.visit_number,
      appointmentTime: (row.appointment_time || "").slice(0, 5) || null,
      category: row.category,
      priority: row.priority || "normal",
      priorityReason: row.priority_reason,
      blockedReason: row.blocked_reason,
      status: row.current_status,
      statusLabel: STATUS_LABEL[row.current_status] || row.current_status,
      sdName: row.sd_name,
      doctorName: row.doctor_name,
      statusSince: row.status_since ? new Date(row.status_since).toISOString() : null,
      checkedInAt: row.checked_in_at ? new Date(row.checked_in_at).toISOString() : null,
      waitMinutes: waited,
      waitBudget: budget,
      waitColour: budgetColour(waited ?? 0, budget),
      journey: railFor(row.current_status, reachedKeysFor(row.reached)),
      results: resultsLine(row),
      keyNumbers: keyNumbersFor(row.biomarkers),
      hasVitals: !!row.vitals_at,
    };

    if (!row.matches) continue;
    if (belongsToOther) {
      const key = row.assigned_doctor_id;
      if (!othersPipeline.has(key)) {
        othersPipeline.set(key, {
          doctorId: key,
          doctorName: row.doctor_name || "Unnamed consultant",
          cards: [],
        });
      }
      othersPipeline.get(key).cards.push(card);
    } else {
      groups[group].push(card);
    }
  }

  // Priority first, then longest waiting — the board's rule, so a patient the
  // coordinator marked urgent is at the top here too.
  const rank = { urgent: 0, high: 1, normal: 2 };
  const byPriorityThenWait = (a, b) =>
    (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2) ||
    (b.waitMinutes ?? 0) - (a.waitMinutes ?? 0);
  for (const key of Object.keys(groups)) groups[key].sort(byPriorityThenWait);

  // Consultants ordered by who has the most waiting — the longest queue is the
  // one a covering colleague is most likely to be asked about.
  const pipelineOthers = [...othersPipeline.values()]
    .map((g) => ({ ...g, cards: g.cards.sort(byPriorityThenWait) }))
    .sort((a, b) => b.cards.length - a.cards.length || a.doctorName.localeCompare(b.doctorName));

  const avgVisitMinutes = completedDurations.length
    ? Math.round(completedDurations.reduce((a, b) => a + b, 0) / completedDurations.length)
    : null;

  return {
    groups,
    pipelineOthers,
    query: raw,
    scope,
    counts: {
      total: counters.total,
      withMe: counters.withMe,
      resultsReady: counters.resultsReady,
      pipeline: counters.pipeline,
      completed: counters.done,
      missingResults: counters.missingResults,
      pipelineOthers: pipelineOthers.reduce((n, g) => n + g.cards.length, 0),
      avgVisitMinutes,
      visitBudgetMinutes: budgets.doctor ?? null,
      journeyBudgetMinutes: budgets.total_journey ?? null,
    },
  };
}

// Everything the consult screen reads. One round trip per patient.
export async function getConsult(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.current_status, v.results_status, v.category,
            v.blocked_reason, v.priority, v.priority_reason,
            v.assigned_doctor_id, v.assigned_sd_id, v.visit_date::text AS visit_date,
            p.name, p.file_no, p.age, p.sex, p.notes,
            COALESCE(doc.short_name, doc.name) AS doctor_name,
            sd.short_name  AS sd_name,
            seq.visit_number,
            a.biomarkers, a.compliance, a.pre_visit_compliance,
            first_ev.occurred_at AS checked_in_at,
            last_ev.occurred_at  AS status_since
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
       LEFT JOIN doctors sd  ON sd.id  = v.assigned_sd_id
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
          WHERE e.visit_id = v.id ORDER BY occurred_at DESC, id DESC LIMIT 1
       ) last_ev ON TRUE
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return null;
  const v = rows[0];

  const [
    { rows: history },
    vitals,
    lastVitals,
    { rows: sdNote },
    { rows: proposals },
    { rows: orders },
    { rows: diagnoses },
    { rows: labs },
    { rows: reports },
    { rows: carePlan },
    { rows: lastVisit },
  ] = await Promise.all([
    db.query(
      `SELECT appointment_date, biomarkers FROM appointments
        WHERE patient_id = $1 AND biomarkers IS NOT NULL
          AND appointment_date < COALESCE(
                (SELECT visit_date FROM giniflow_visits WHERE id = $2),
                (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
        ORDER BY appointment_date DESC NULLS LAST LIMIT 8`,
      [v.patient_id, visitId],
    ),
    // Either table may hold today's reading — see visitVitals.js. Reading only
    // `giniflow_vitals` told the consultant a patient had no vitals when the
    // reading that moved them to this queue was sitting in the older one.
    todaysVitals(visitId, { patientId: v.patient_id, visitDate: v.visit_date }, db),
    previousVitals(v.patient_id, v.visit_date, db),
    db.query(
      `SELECT n.plan, n.source, n.updated_at, d.short_name AS author
         FROM giniflow_sd_notes n
         LEFT JOIN doctors d ON d.id = n.authored_by
        WHERE n.visit_id = $1`,
      [visitId],
    ),
    db.query(
      `SELECT r.id, r.medicine_name, r.from_dose, r.to_dose, r.reason, r.change_type,
              r.status, r.decided_at, d.short_name AS proposed_by_name
         FROM giniflow_rx_proposals r
         LEFT JOIN doctors d ON d.id = r.proposed_by
        WHERE r.visit_id = $1 ORDER BY r.created_at`,
      [visitId],
    ),
    db.query(
      `SELECT o.id, o.urgency, o.payment_status, o.sample_status, o.created_at,
              COALESCE(json_agg(t.test_name ORDER BY t.test_name)
                       FILTER (WHERE t.test_name IS NOT NULL), '[]'::json) AS tests
         FROM giniflow_lab_orders o
         LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1
        GROUP BY o.id ORDER BY o.created_at`,
      [visitId],
    ),
    db.query(
      `SELECT diagnosis_id, label, status, category, key_value, trend, since_year, notes
         FROM diagnoses WHERE patient_id = $1 AND is_active
        ORDER BY CASE category WHEN 'primary' THEN 0 ELSE 1 END, sort_order, id`,
      [v.patient_id],
    ),
    // The chart's own lab table — Gini Flow reads the patient's chart, it does
    // not keep a second one.
    db.query(
      `SELECT DISTINCT ON (COALESCE(canonical_name, test_name))
              COALESCE(canonical_name, test_name) AS test, test_name, result, result_text,
              unit, ref_range, flag, panel_name, test_date
         FROM lab_results WHERE patient_id = $1
        ORDER BY COALESCE(canonical_name, test_name), test_date DESC, id DESC`,
      [v.patient_id],
    ),
    db.query(
      `SELECT id, doc_type, title, doc_date, created_at
         FROM documents WHERE patient_id = $1
        ORDER BY COALESCE(doc_date, created_at::date) DESC LIMIT 12`,
      [v.patient_id],
    ),
    db.query(
      `SELECT treatment, lifestyle, internal_note, next_visit_date::text AS next_visit_date,
              next_visit_interval, goals, updated_at
         FROM giniflow_care_plans WHERE visit_id = $1`,
      [visitId],
    ),
    db.query(
      `SELECT appointment_date::text AS date FROM appointments
        WHERE patient_id = $1 AND status = 'completed'
          AND appointment_date < COALESCE(
                (SELECT visit_date FROM giniflow_visits WHERE id = $2),
                (NOW() AT TIME ZONE 'Asia/Kolkata')::date)
        ORDER BY appointment_date DESC NULLS LAST LIMIT 1`,
      [v.patient_id, visitId],
    ),
  ]);

  // Today's numbers are the appointment's biomarkers, topped up with the vitals
  // the station took an hour ago — a BP recorded at the chair is today's BP.
  const current = { ...(v.biomarkers || {}) };
  if (vitals) {
    if (vitals.bp_sys != null) current.sbp = vitals.bp_sys;
    if (vitals.bp_dia != null) current.dbp = vitals.bp_dia;
    if (vitals.weight != null) current.weight = vitals.weight;
    if (vitals.bmi != null) current.bmi = vitals.bmi;
  }
  const previous = history[0]?.biomarkers || null;
  const brief = buildBrief(current, previous);

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
    priority: v.priority || "normal",
    priorityReason: v.priority_reason,
    status: v.current_status,
    statusLabel: STATUS_LABEL[v.current_status] || v.current_status,
    resultsStatus: v.results_status,
    blockedReason: v.blocked_reason,
    sdName: v.sd_name,
    doctorName: v.doctor_name,
    assignedDoctorId: v.assigned_doctor_id,
    checkedInAt: v.checked_in_at ? new Date(v.checked_in_at).toISOString() : null,
    statusSince: v.status_since ? new Date(v.status_since).toISOString() : null,
    // A finalized visit is read-only; the only writable path is an addendum.
    finalized: DONE_STATUSES.includes(v.current_status),
    inRoom: v.current_status === "with_doctor",
    header: {
      lastVisitDate: lastVisit[0]?.date || null,
      compliancePct: v.pre_visit_compliance?.pct ?? null,
      summary: brief.summary,
    },
    tiles: brief.tiles,
    markers: brief.markers,
    concerns: {
      reports: brief.reportConcerns,
      // The patient's own words and the since-last-visit block have no
      // structured source yet (plan §6.1); returning empty arrays rather than
      // inventing rows, so the screen can say "nothing recorded".
      patient: [],
      sinceLast: [],
    },
    diagnoses,
    labs,
    reports,
    vitals,
    lastVitals,
    biomarkerHistory: history
      .map((h) => ({ date: h.appointment_date, biomarkers: h.biomarkers }))
      .reverse(),
    moPlan: sdNote[0]
      ? { plan: sdNote[0].plan, author: sdNote[0].author, updatedAt: sdNote[0].updated_at }
      : null,
    proposals,
    orders: orders.map((o) => ({ ...o, tests: o.tests || [] })),
    carePlan: carePlan[0]
      ? { ...carePlan[0], goals: carePlan[0].goals || [] }
      : { treatment: "", lifestyle: "", internalNote: "", goals: [] },
  };
}

// The trend behind a tapped tile.
export async function getTrend(patientId, marker, db = pool) {
  const { rows } = await db.query(
    `SELECT appointment_date::text AS date, biomarkers FROM appointments
      WHERE patient_id = $1 AND biomarkers IS NOT NULL
      ORDER BY appointment_date`,
    [patientId],
  );
  const key = marker === "bp" ? "sbp" : marker;
  const series = rows
    .map((r) => ({ date: r.date, value: Number(r.biomarkers?.[key]) }))
    .filter((p) => Number.isFinite(p.value));
  return { marker, series };
}

// Whose patient is this? The queue's second column deliberately shows patients
// assigned to OTHER consultants — "who is on the floor at all" — so a consultant
// can open one. Opening is fine; writing is not. An unassigned patient stays
// writable: nobody has claimed them, so the first consultant to open one is
// picking them up, which is how the queue's "Mine" column already treats them.
export async function visitOwnership(visitId, doctorId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.assigned_doctor_id, COALESCE(d.short_name, d.name) AS doctor_name
       FROM giniflow_visits v
       LEFT JOIN doctors d ON d.id = v.assigned_doctor_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) return { found: false, readOnly: false, ownerName: null };
  const assigned = rows[0].assigned_doctor_id;
  return {
    found: true,
    readOnly: !!assigned && !!doctorId && assigned !== doctorId,
    ownerName: rows[0].doctor_name,
  };
}

// The same question asked of a prescription item or a dose proposal. Those
// endpoints are keyed on the row, not the visit, so the visit gate above cannot
// see them — and a read-only page that still let an item be edited would be a
// lock on the front door with the side gate open.
export async function rowOwnership(table, rowId, doctorId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.id AS visit_id, v.assigned_doctor_id, COALESCE(d.short_name, d.name) AS doctor_name
       FROM ${table} r
       JOIN giniflow_visits v ON v.id = r.visit_id
       LEFT JOIN doctors d ON d.id = v.assigned_doctor_id
      WHERE r.id = $1`,
    [rowId],
  );
  if (!rows.length) return { found: false, readOnly: false, ownerName: null };
  const assigned = rows[0].assigned_doctor_id;
  return {
    found: true,
    readOnly: !!assigned && !!doctorId && assigned !== doctorId,
    ownerName: rows[0].doctor_name,
  };
}

// Claiming the room. One patient with a consultant at a time: the older module
// once showed four consultations at once for one doctor, and every duration it
// reported after that was fiction.
export async function startConsult(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.current_status, v.visit_date, v.assigned_doctor_id,
              (SELECT COALESCE(d.short_name, d.name) FROM doctors d
                WHERE d.id = v.assigned_doctor_id) AS assigned_doctor_name
         FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });

    // One patient, one room. The COALESCE below keeps the first consultant as
    // the owner, but on its own it let a second one open the consult anyway —
    // the status was already `with_doctor`, so nothing advanced and nothing
    // objected — and two people wrote a care plan and a prescription against
    // the same visit.
    if (
      actorId &&
      rows[0].current_status === "with_doctor" &&
      rows[0].assigned_doctor_id &&
      rows[0].assigned_doctor_id !== actorId
    ) {
      throw Object.assign(
        new Error(
          `This patient is already in ${rows[0].assigned_doctor_name || "another consultant"}'s room — they cannot be in two places at once`,
        ),
        { status: 409 },
      );
    }

    if (actorId) {
      const { rows: busy } = await client.query(
        `SELECT v.id, p.name FROM giniflow_visits v
           JOIN patients p ON p.id = v.patient_id
          WHERE v.visit_date = $1::date AND v.current_status = 'with_doctor'
            AND v.assigned_doctor_id = $2 AND v.id <> $3
          LIMIT 1`,
        [rows[0].visit_date, actorId, visitId],
      );
      if (busy.length) {
        throw Object.assign(
          new Error(`${busy[0].name} is already in the room — finish or release them first`),
          { status: 409 },
        );
      }
    }

    if (rows[0].current_status !== "with_doctor") {
      await advanceStatus(client, {
        visitId,
        toStatus: "with_doctor",
        actorRole: "doctor",
        actorId,
        // The consultant may take a patient who is still queued at an earlier
        // station — a walk-in, or a patient the floor moved by hand. HealthRay
        // does the same thing when it observes `in_visit`.
        allowSkip: true,
      });
    }
    await client.query(
      `UPDATE giniflow_visits SET assigned_doctor_id = COALESCE(assigned_doctor_id, $2),
              updated_at = NOW() WHERE id = $1`,
      [visitId, actorId],
    );

    // The prescription opens pre-seeded with last visit's regimen, every row
    // `continued` — addendum v1.1 §1, docs/gini-flow/24-ADDENDUM-V11-PLAN.md §2.
    // Copying is the default state, not a button: 400 of last week's 438 visits
    // arrived on an average of 7.2 medicines, and the alternative to seeding is
    // a consultant retyping them under time pressure, which is how a medicine
    // gets dropped.
    //
    // In this transaction, so a claim that fails leaves no draft behind, and
    // idempotent — a second claim finds the draft started and does nothing.
    const seeded = await seedDraftOn(client, visitId);

    await client.query("COMMIT");
    return { started: true, seeded: seeded.seeded };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// The consultant stepped out — the patient goes back to the queue rather than
// occupying a room they are not in. Mirrors the MO station's releaseWorkup.
export async function releaseConsult(visitId, actorId = null, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT current_status FROM giniflow_visits WHERE id = $1 FOR UPDATE`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
    if (rows[0].current_status !== "with_doctor") {
      throw Object.assign(new Error("This patient is not in the room"), { status: 409 });
    }
    // Through the engine's own primitive rather than a direct UPDATE (CS-09):
    // the rule that `current_status` is written in one place is worth keeping
    // true, and returnToQueue also clears the manual queue position the way
    // every other transition does.
    await returnToQueue(client, {
      visitId,
      toStatus: "ready_for_doctor",
      actorRole: "doctor",
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

export async function saveCarePlan(visitId, plan, actorId = null, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO giniflow_care_plans
       (visit_id, treatment, lifestyle, internal_note, next_visit_date,
        next_visit_interval, goals, source, authored_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
     ON CONFLICT (visit_id) DO UPDATE
        SET treatment = EXCLUDED.treatment,
            lifestyle = EXCLUDED.lifestyle,
            internal_note = EXCLUDED.internal_note,
            next_visit_date = EXCLUDED.next_visit_date,
            next_visit_interval = EXCLUDED.next_visit_interval,
            goals = EXCLUDED.goals,
            source = EXCLUDED.source,
            authored_by = COALESCE(EXCLUDED.authored_by, giniflow_care_plans.authored_by),
            updated_at = NOW()
     RETURNING visit_id, updated_at`,
    [
      visitId,
      plan.treatment ?? null,
      plan.lifestyle ?? null,
      plan.internalNote ?? null,
      plan.nextVisitDate || null,
      plan.nextVisitInterval ?? null,
      JSON.stringify(plan.goals ?? []),
      plan.source || "typed",
      actorId,
    ],
  );
  return rows[0];
}

// The MO proposed; the consultant decides. These columns have existed since the
// MO station shipped and nothing has ever written them — this is what does.
export async function decideProposal(proposalId, decision, actorId = null, db = pool) {
  if (!["approved", "adjusted", "rejected"].includes(decision.status)) {
    throw Object.assign(new Error(`Unknown decision: ${decision.status}`), { status: 400 });
  }
  if (decision.status === "rejected" && !decision.note) {
    throw Object.assign(new Error("Rejecting a proposal needs a reason"), { status: 400 });
  }
  const { rows } = await db.query(
    `UPDATE giniflow_rx_proposals
        SET status = $2,
            to_dose = COALESCE($3, to_dose),
            -- COALESCE, because giniflow_rx_proposals.reason is nullable and the
            -- MO is not required to give one: NULL || ' · consultant: …' is NULL
            -- in Postgres, so the consultant's mandatory justification for
            -- overruling a colleague was being written as nothing (CS-08).
            reason = CASE WHEN $4::text IS NULL THEN reason
                          ELSE NULLIF(CONCAT_WS(' · ', reason, 'consultant: ' || $4), '') END,
            decided_by = $5, decided_at = NOW()
      WHERE id = $1
      RETURNING id, medicine_name, from_dose, to_dose, status, decided_at`,
    [proposalId, decision.status, decision.adjustedDose ?? null, decision.note ?? null, actorId],
  );
  if (!rows.length) throw Object.assign(new Error("Proposal not found"), { status: 404 });
  return rows[0];
}
