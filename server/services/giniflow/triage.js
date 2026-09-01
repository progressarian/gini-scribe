import pool from "../../config/db.js";
import {
  CATEGORY_META,
  TRIAGE_PIPELINE,
  isCategory,
  chainIndex,
  isChainStatus,
} from "../../../shared/giniflowStatus.js";
import { callLabel } from "../../../shared/callStatuses.js";
import { syncAppointmentsToFlow } from "./appointmentSync.js";
import { classifyMarker, MARKER_LABEL } from "./consultBrief.js";
import { BIO_TARGET, STABILITY } from "../analytics/biomarkerTargets.js";
import { IST_TODAY } from "./statusEngine.js";

// The day BEFORE the day: are the reports in, what do the numbers say, who
// should see them, and who will be a problem at 9am.
//
// docs/gini-flow/18-TRIAGE-BOARD-PLAN.md. Two things there are worth repeating
// beside the code they explain:
//
//   1. `giniflow_visits.category` was NULL on every row ever written, and it is
//      read by the board's dot, the consultant's chip and the MO's `canClose`
//      rule. This module is the missing writer — which is why it is less a new
//      screen than the switch that turns on behaviour three others already have.
//
//   2. The visit rows for a FUTURE day do not exist until something makes them.
//      `syncAppointmentsToFlow` is date-parameterised and nothing ever called it
//      that way, so opening the board for tomorrow would have had nothing to
//      write a category to. `getTriageDay` ensures the day first (§3.2b).

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── The engine (§5) ─────────────────────────────────────────────────────────
// HbA1c only, deliberately: this is a diabetes practice and HbA1c is the tier-1
// marker. Widening it to a composite is a clinical change, not a refactor.
//
// The thresholds are read from `biomarkerTargets.js` rather than copied, so the
// triage board and the consult screen can never disagree about whether a
// patient is at target (§3.3). `RISE` is the one number the notes add that the
// targets file has no opinion on.
export const HBA1C_GOAL = BIO_TARGET.hba1c.good; // 7.0
export const HBA1C_HIGH = BIO_TARGET.hba1c.warn; // 9.0
export const HBA1C_STABLE = STABILITY.hba1c; // 0.3 — smaller moves are noise
export const HBA1C_RISE = 1.5;

// The notes' five branches, in their order, plus the two cases they do not
// cover — an untriaged patient has to land SOMEWHERE, and leaving them
// uncategorised is the state this whole screen exists to end:
//
//   · above goal but flat, or above goal with no previous reading
//   · at goal but rising by more than the noise floor
//
// Both go to `worse_in_range`, the "SD leads, chief validates" column. That is
// the conservative direction: the only category that lets the MO close a
// patient without the doctor seeing them is `in_control`, so an unclear patient
// must never land there by default.
export function categoriseHba1c(current, previous) {
  const cur = num(current);
  if (cur === null) return "no_reports";

  const prev = num(previous);
  const delta = prev === null ? null : cur - prev;
  const rising = delta !== null && delta > HBA1C_STABLE;
  const improving = delta !== null && delta < -HBA1C_STABLE;

  if (cur > HBA1C_HIGH || (delta !== null && delta > HBA1C_RISE)) return "worse_out_of_range";
  if (cur >= HBA1C_GOAL && cur <= HBA1C_HIGH && rising) return "worse_in_range";
  if (improving && cur > HBA1C_GOAL) return "getting_better";
  if (cur <= HBA1C_GOAL && !rising) return "in_control";
  return "worse_in_range";
}

// ── Special routing (§5) ────────────────────────────────────────────────────
// A SUGGESTION on the card, never an automatic assignment: the coordinator
// still presses Assign. Two rules in code, as the plan asks, with more expected
// — a config table can come when the list outgrows a code change.
const ROUTING_RULES = [
  {
    match: /foot\s*ulcer|diabetic[_ ]?foot/i,
    label: "Diabetic foot ulcer",
    suggest: "Suggest the diabetic-foot clinic",
    icon: "🦶",
  },
  {
    match: /retinopath/i,
    label: "Retinopathy",
    suggest: "Suggest an ophthalmology referral",
    icon: "👁",
  },
];

const routingFor = (diagnoses = []) => {
  const text = diagnoses.filter(Boolean).join(" · ");
  if (!text) return [];
  return ROUTING_RULES.filter((r) => r.match.test(text)).map((r) => ({
    label: r.label,
    suggest: r.suggest,
    icon: r.icon,
  }));
};

// ── Report status (§6, and the notes' three states) ─────────────────────────
// "All required tests" is the notes' list. Lipid is satisfied by any one of its
// three members: a lipid profile that reported LDL but not triglycerides is a
// lipid profile.
const REQUIRED_REPORTS = [
  { key: "hba1c", label: "HbA1c", markers: ["hba1c"] },
  { key: "fbs", label: "FBS", markers: ["fg"] },
  { key: "lipid", label: "Lipid", markers: ["ldl", "tg", "tc"] },
  { key: "egfr", label: "eGFR", markers: ["egfr"] },
  { key: "uacr", label: "UACR", markers: ["uacr"] },
];

function reportStatusFor(biomarkers) {
  const bio = biomarkers || {};
  const present = [];
  const missing = [];
  for (const req of REQUIRED_REPORTS) {
    (req.markers.some((m) => num(bio[m]) !== null) ? present : missing).push(req.label);
  }
  const state = missing.length === 0 ? "ok" : present.length === 0 ? "missing" : "partial";
  return {
    state,
    present,
    missing,
    text:
      state === "ok"
        ? `${present.join(" · ")} — all present`
        : state === "partial"
          ? `${present.join(" · ")} present — ${missing.join(", ")} missing`
          : "No reports received yet",
  };
}

// ── Bio chips (§4.3) ────────────────────────────────────────────────────────
// "6.9 → 7.4 HbA1c", previous → current. The colour is `consultBrief`'s own
// classification rather than a second rule: that module already answers both
// halves of the question the chip asks — did it move, and is it at goal — and a
// private copy here would let the card and the consult screen disagree about
// the same number (§4.3).
const CHIP_MARKERS = ["hba1c", "fg", "ldl", "tg", "uacr", "egfr"];

const chipTone = (marker) => {
  if (!marker) return "n";
  if (marker.movement === "worse") return marker.status === "good" ? "a" : "r";
  if (marker.status === "bad") return "r";
  if (marker.status === "warn") return "a";
  if (marker.status === "good") return "g";
  return "n";
};

function bioChips(current, previous) {
  const chips = [];
  for (const key of CHIP_MARKERS) {
    const marker = classifyMarker(key, current?.[key], previous?.[key]);
    if (!marker) continue;
    chips.push({
      key,
      label: MARKER_LABEL[key]?.label || key,
      unit: MARKER_LABEL[key]?.unit ?? "",
      value: marker.value,
      previous: marker.previous,
      delta: marker.delta,
      movement: marker.movement,
      status: marker.status,
      tone: chipTone(marker),
    });
  }
  return chips;
}

// ── Compliance (§4.3) ───────────────────────────────────────────────────────
// The plan names `pre_visit_compliance.pct`. The column actually holds either
// shape depending on which client wrote it — the patient app posts an ARRAY of
// per-medicine adherence items (see the 2026-05-11 migration), and a later
// summary write posts an object with a pct. Read both rather than showing "—"
// for every patient who used the app.
const ADHERENCE_SCORE = { always: 100, mostly: 75, sometimes: 40, missed: 0 };

function compliancePct(preVisit) {
  if (!preVisit) return null;
  if (!Array.isArray(preVisit)) {
    const pct = num(preVisit.pct ?? preVisit.percent ?? preVisit.percentage);
    return pct === null ? null : Math.max(0, Math.min(100, Math.round(pct)));
  }
  const scores = preVisit
    .map((item) => ADHERENCE_SCORE[String(item?.adherence || "").toLowerCase()])
    .filter((s) => s !== undefined);
  if (!scores.length) return null;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

const complianceTone = (pct) => (pct === null ? "n" : pct < 60 ? "r" : pct <= 80 ? "a" : "g");

// ── The confirmation pill (§4.3) ────────────────────────────────────────────
// Read from `shared/callStatuses.js` — the vocabulary the OBT team already
// works on /ghm — rather than inventing a parallel one. Only ONE of its eleven
// values means "confirmed for this appointment", and two mean the opposite:
// mapping `rescheduled` to confirmed would put a patient who is coming next
// week on tomorrow's board with a green tick.
const CALL_PILL = {
  called: { tone: "confirmed", text: "✓ Confirmed" },
  no_call_needed: { tone: "confirmed", text: "✓ No call needed" },
  rescheduled: { tone: "danger", text: "⚠ Rescheduled — not coming" },
  cancelled: { tone: "danger", text: "⚠ Cancelled — not coming" },
  wrong_number: { tone: "danger", text: "⚠ Cannot reach — needs a number" },
};

const NOT_CONFIRMED = { tone: "pending", text: "Not confirmed" };

const confirmationPill = (callStatus) => {
  const value = callStatus || "pending";
  const pill = CALL_PILL[value] || NOT_CONFIRMED;
  return { ...pill, status: value, statusLabel: callLabel(value) };
};

// Once they are in the building the call no longer matters, and the notes are
// explicit that the two pills are never shown together.
const IN_BUILDING_FROM = chainIndex("checked_in");
const hasArrived = (status) => isChainStatus(status) && chainIndex(status) >= IN_BUILDING_FROM;

// Which feed a result arrived on. "Auto-received" means a machine put it there:
// the lab's own sync and the HealthRay sync. Everything else — an extraction
// from an uploaded report, a typed result, the patient's app — is somebody
// having uploaded it, which is the distinction the pipeline bar's second and
// third steps are counting.
//
// Written as a list rather than `source = 'lab'`, which was the obvious guess
// and matched 215 rows out of 160,000: the lab feed writes `lab_healthray`.
const AUTO_SOURCES = ["lab", "healthray", "lab_healthray"];

// ── The day ─────────────────────────────────────────────────────────────────
// One query for the whole day. Everything the card shows that is not on the
// visit row comes from a lateral, so a day of 120 patients is still one round
// trip — the same rule the board's own query follows.
const DAY_SQL = `
  SELECT v.id,
         v.patient_id,
         v.visit_date::text                       AS visit_date,
         v.current_status,
         v.category,
         v.category_source,
         v.category_set_at,
         v.assigned_sd_id,
         v.assigned_doctor_id,
         v.lifestyle_flagged,
         v.appointment_time::text                 AS appointment_time,
         p.name                                   AS patient_name,
         p.file_no,
         p.age,
         p.sex,
         sd.short_name                            AS sd_name,
         doc.short_name                           AS doctor_name,
         setter.short_name                        AS category_set_by_name,
         a.id                                     AS appointment_id,
         a.status                                 AS appointment_status,
         a.call_status,
         a.call_date::text                        AS call_date,
         a.biomarkers,
         a.pre_visit_compliance,
         a.pre_visit_symptoms,
         a.pre_visit_notes,
         seq.visit_number,
         prev.biomarkers                          AS prev_biomarkers,
         prev.appointment_date::text              AS prev_report_date,
         last_visit.appointment_date::text        AS last_visit_date,
         rep.lab_at,
         rep.upload_at,
         rep.latest_test_date,
         docs.uploaded_at                         AS doc_uploaded_at,
         dx.labels                                AS diagnoses
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors sd     ON sd.id     = v.assigned_sd_id
    LEFT JOIN doctors doc    ON doc.id    = v.assigned_doctor_id
    LEFT JOIN doctors setter ON setter.id = v.category_set_by
    LEFT JOIN appointments a ON a.id = v.appointment_id
    LEFT JOIN LATERAL (
      -- The patient's real visit sequence: giniflow_visits alone would always
      -- say 1, exactly as the board's own query notes.
      SELECT COUNT(*)::int + 1 AS visit_number
        FROM appointments pa
       WHERE pa.patient_id = v.patient_id
         AND pa.appointment_date < v.visit_date
         AND pa.status = 'completed'
    ) seq ON TRUE
    LEFT JOIN LATERAL (
      -- The previous reading the "rising / improving" test needs. The same
      -- lookup the consult screen does, so both compare against the same visit.
      SELECT pa.biomarkers, pa.appointment_date
        FROM appointments pa
       WHERE pa.patient_id = v.patient_id
         AND pa.biomarkers IS NOT NULL
         AND pa.appointment_date < v.visit_date
       ORDER BY pa.appointment_date DESC LIMIT 1
    ) prev ON TRUE
    LEFT JOIN LATERAL (
      SELECT pa.appointment_date
        FROM appointments pa
       WHERE pa.patient_id = v.patient_id
         AND pa.appointment_date < v.visit_date
         AND pa.status IN ('completed', 'seen')
       ORDER BY pa.appointment_date DESC LIMIT 1
    ) last_visit ON TRUE
    LEFT JOIN LATERAL (
      -- Where this patient's numbers came from, and when. 'lab' is the feed the
      -- lab sync writes; anything else was typed or extracted from an upload.
      SELECT MAX(l.created_at) FILTER (WHERE l.source = ANY($2::text[]))     AS lab_at,
             MAX(l.created_at) FILTER (WHERE NOT (l.source = ANY($2::text[]))) AS upload_at,
             MAX(l.test_date)::text                                            AS latest_test_date
        FROM lab_results l
       WHERE l.patient_id = v.patient_id
         AND l.test_date >= v.visit_date - INTERVAL '120 days'
         AND l.test_date <= v.visit_date
    ) rep ON TRUE
    LEFT JOIN LATERAL (
      SELECT MAX(d.created_at) AS uploaded_at
        FROM documents d
       WHERE d.patient_id = v.patient_id
         AND NOT (COALESCE(d.source, '') = ANY($2::text[]))
         AND COALESCE(d.doc_date, d.created_at::date) >= v.visit_date - INTERVAL '120 days'
         AND COALESCE(d.doc_date, d.created_at::date) <= v.visit_date
    ) docs ON TRUE
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(COALESCE(dg.label, dg.diagnosis_id)) AS labels
        FROM diagnoses dg
       WHERE dg.patient_id = v.patient_id AND dg.is_active
    ) dx ON TRUE
   WHERE v.visit_date = $1::date
     AND NOT COALESCE(p.is_blocked, FALSE)
   ORDER BY v.appointment_time NULLS LAST, p.name`;

const iso = (ts) => (ts ? new Date(ts).toISOString() : null);

const clockOf = (time) => (time ? String(time).slice(0, 5) : null);

const dayLabel = (date) =>
  date
    ? new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
    : null;

function buildCard(row) {
  const biomarkers = row.biomarkers || {};
  const previous = row.prev_biomarkers || {};
  const report = reportStatusFor(biomarkers);
  const pct = compliancePct(row.pre_visit_compliance);
  const arrived = hasArrived(row.current_status);
  const symptoms = (row.pre_visit_symptoms || []).filter(Boolean);

  // Which of the two feeds delivered the numbers. The lab's own feed is the
  // "auto-received" case the notes name; anything else came in by hand.
  const labAt = row.lab_at ? new Date(row.lab_at) : null;
  const uploadAt = [row.upload_at, row.doc_uploaded_at]
    .filter(Boolean)
    .map((t) => new Date(t))
    .sort((a, b) => b - a)[0];
  const fromLab = !!labAt && (!uploadAt || labAt >= uploadAt);
  const reportAddedAt =
    labAt && uploadAt ? (labAt > uploadAt ? labAt : uploadAt) : labAt || uploadAt;

  return {
    visitId: row.id,
    patientId: row.patient_id,
    appointmentId: row.appointment_id,
    name: row.patient_name,
    fileNo: row.file_no,
    age: row.age,
    sex: row.sex,
    visitNumber: row.visit_number,
    isNewPatient: (row.visit_number ?? 1) <= 1,
    slot: clockOf(row.appointment_time),
    status: row.current_status,
    appointmentStatus: row.appointment_status,
    arrived,
    category: row.category,
    categorySource: row.category_source,
    categorySetAt: iso(row.category_set_at),
    categorySetBy: row.category_set_by_name,
    // Never both pills — once they are in the building the call is history.
    confirmation: arrived ? null : confirmationPill(row.call_status),
    callDate: row.call_date,
    report: {
      ...report,
      addedAt: iso(reportAddedAt),
      addedLabel: reportAddedAt
        ? new Date(reportAddedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })
        : null,
      source: reportAddedAt ? (fromLab ? "Lab · auto-received" : "Uploaded") : null,
      testDate: row.latest_test_date,
    },
    bios: bioChips(biomarkers, previous),
    previousReportDate: row.prev_report_date,
    previousReportLabel: dayLabel(row.prev_report_date),
    lastVisitDate: row.last_visit_date,
    lastVisitLabel: row.last_visit_date ? dayLabel(row.last_visit_date) : null,
    compliance: { pct, tone: complianceTone(pct), known: pct !== null },
    lifestyleFlagged: !!row.lifestyle_flagged,
    // §6 recommends shipping without the MHG boxes rather than inventing a
    // table nothing fills. There IS one real source already — the pre-visit
    // check-in the patient app writes onto the appointment — so the card shows
    // that and simply omits the box when it is empty, which is what the plan
    // asks for. The richer "questions" capture the prototype draws is still to
    // be built in the patient app.
    symptoms,
    question: row.pre_visit_notes || null,
    routing: routingFor(row.diagnoses || []),
    assignment: {
      sdId: row.assigned_sd_id,
      sdName: row.sd_name,
      doctorId: row.assigned_doctor_id,
      doctorName: row.doctor_name,
      assigned: !!(row.assigned_sd_id || row.assigned_doctor_id),
    },
  };
}

// ── The eight pipeline counts (§4.1) ────────────────────────────────────────
// Each is also the filter of the same name, defined once as a predicate so a
// step's number and the patients clicking it opens cannot disagree.
const PIPELINE_TESTS = {
  total: () => true,
  lab_reports_in: (c) => c.report.source === "Lab · auto-received",
  reports_uploaded: (c) => c.report.source === "Uploaded",
  data_complete: (c) => c.report.state === "ok",
  categorised: (c) => !!c.category,
  assigned: (c) => c.assignment.assigned,
  checked_in: (c) => c.arrived,
  no_show_cancel: (c) =>
    c.status === "no_show" ||
    c.status === "cancelled" ||
    c.appointmentStatus === "no_show" ||
    c.appointmentStatus === "cancelled",
};

const pipelineCounts = (cards) =>
  Object.fromEntries(
    TRIAGE_PIPELINE.map((step) => [step.key, cards.filter(PIPELINE_TESTS[step.key]).length]),
  );

const matchesSearch = (card, q) => {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (needle.length < 2) return true;
  return (
    (card.name || "").toLowerCase().includes(needle) ||
    (card.fileNo || "").toLowerCase().includes(needle)
  );
};

// The whole screen, for one date.
//
// The day's visits are ensured FIRST (§3.2b): a triage board opened on tomorrow
// would otherwise have nothing to write a category to. Both steps are
// idempotent — the sync skips visits already at or past their target, and the
// sweep only writes rows whose category actually changed — so re-opening the
// board costs nothing.
export async function getTriageDay(
  visitDate,
  { doctorId = null, filter = null, q = null, ensure = true, db = pool } = {},
) {
  let ensured = null;
  if (ensure) {
    ensured = await syncAppointmentsToFlow({ date: visitDate, db });
    await autoCategoriseDay(visitDate, { db });
  }

  const { rows } = await db.query(DAY_SQL, [visitDate, AUTO_SOURCES]);
  const cards = rows.map(buildCard);
  const pipeline = pipelineCounts(cards);

  const test = filter && PIPELINE_TESTS[filter] ? PIPELINE_TESTS[filter] : null;
  const shown = cards.filter(
    (c) =>
      (!test || test(c)) &&
      (!doctorId ||
        c.assignment.sdId === Number(doctorId) ||
        c.assignment.doctorId === Number(doctorId)) &&
      matchesSearch(c, q),
  );

  const columns = Object.entries(CATEGORY_META).map(([key, meta]) => ({
    key,
    ...meta,
    count: shown.filter((c) => c.category === key).length,
    cards: shown.filter((c) => c.category === key),
  }));

  // A patient the engine could not place is not silently dropped: they are the
  // coordinator's actual worklist, so they get their own tray under the board.
  const uncategorised = shown.filter((c) => !c.category);

  return {
    date: visitDate,
    pipeline,
    steps: TRIAGE_PIPELINE.map((s) => ({ ...s, count: pipeline[s.key] })),
    columns,
    uncategorised,
    totals: {
      total: cards.length,
      shown: shown.length,
      uncategorised: cards.filter((c) => !c.category).length,
      unassigned: cards.filter((c) => !c.assignment.assigned).length,
      coordinatorSet: cards.filter((c) => c.categorySource === "coordinator").length,
    },
    ensured: ensured
      ? { created: ensured.created, advanced: ensured.advanced, considered: ensured.considered }
      : null,
  };
}

// ── The sweep (§5.3, §7) ────────────────────────────────────────────────────
// Auto-categorisation may only write rows whose `category_source` is NULL or
// 'auto'. A coordinator's judgement is the end of the argument — it survives
// every later run, including the one a 6pm lab result triggers.
export async function autoCategoriseDay(visitDate, { db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT v.id, v.category, a.biomarkers, prev.biomarkers AS prev_biomarkers
       FROM giniflow_visits v
       LEFT JOIN appointments a ON a.id = v.appointment_id
       LEFT JOIN LATERAL (
         SELECT pa.biomarkers FROM appointments pa
          WHERE pa.patient_id = v.patient_id
            AND pa.biomarkers IS NOT NULL
            AND pa.appointment_date < v.visit_date
          ORDER BY pa.appointment_date DESC LIMIT 1
       ) prev ON TRUE
      WHERE v.visit_date = $1::date
        AND (v.category_source IS NULL OR v.category_source = 'auto')`,
    [visitDate],
  );

  const changed = rows
    .map((r) => ({
      id: r.id,
      from: r.category,
      to: categoriseHba1c(r.biomarkers?.hba1c, r.prev_biomarkers?.hba1c),
    }))
    .filter((r) => r.from !== r.to);

  if (changed.length) {
    // One statement for the day. A per-row UPDATE over the connection pooler is
    // what made the appointment sync take twenty seconds before it was batched.
    await db.query(
      `UPDATE giniflow_visits v
          SET category = t.category,
              category_source = 'auto',
              category_set_by = NULL,
              category_set_at = NOW(),
              updated_at = NOW()
         FROM UNNEST($1::uuid[], $2::text[]) AS t(id, category)
        WHERE v.id = t.id
          AND (v.category_source IS NULL OR v.category_source = 'auto')`,
      [changed.map((c) => c.id), changed.map((c) => c.to)],
    );
  }

  return { date: visitDate, considered: rows.length, updated: changed.length };
}

// ── Coordinator writes ──────────────────────────────────────────────────────
// `category` is a property of the visit, not a journey step, so — like priority
// — it is written to the row and NOT logged as a giniflow_visit_events row. An
// event that is not a journey step restarts the patient's station timer, which
// is the rule 10-QUEUE-CONTROL-PLAN.md set (§7).
//
// Passing `category: null` hands the row back to the engine: the source is
// cleared and the day's sweep re-decides it. That is the only way to undo an
// override, so it is a first-class action rather than a database fix.
export async function categorise(visitId, category, actorId = null, db = pool) {
  if (category !== null && !isCategory(category)) {
    throw Object.assign(new Error(`Unknown category: ${category}`), { status: 400 });
  }

  if (category === null) {
    const { rows } = await db.query(
      `UPDATE giniflow_visits
          SET category_source = NULL, category_set_by = NULL, category_set_at = NULL,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, visit_date::text AS visit_date`,
      [visitId],
    );
    if (!rows.length) throw Object.assign(new Error("No such visit"), { status: 404 });
    await autoCategoriseDay(rows[0].visit_date, { db });
    const after = await db.query(
      `SELECT category, category_source FROM giniflow_visits WHERE id = $1`,
      [visitId],
    );
    return {
      visitId,
      category: after.rows[0].category,
      categorySource: after.rows[0].category_source,
      reset: true,
    };
  }

  const { rows } = await db.query(
    `UPDATE giniflow_visits
        SET category = $2, category_source = 'coordinator', category_set_by = $3,
            category_set_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING id, category, category_source, category_set_at`,
    [visitId, category, actorId],
  );
  if (!rows.length) throw Object.assign(new Error("No such visit"), { status: 404 });
  return {
    visitId: rows[0].id,
    category: rows[0].category,
    categorySource: rows[0].category_source,
    categorySetAt: iso(rows[0].category_set_at),
  };
}

// Assignment. Either half may be set on its own — a patient can be given to an
// SD before anyone decides which consultant validates them — and `null` clears
// that half, which is how a mis-assignment is undone.
export async function assign(visitId, { sdId, doctorId } = {}, actorId = null, db = pool) {
  const sets = [];
  const params = [visitId];

  const resolve = async (id, what) => {
    if (id === undefined) return undefined;
    if (id === null) return null;
    const { rows } = await db.query(
      `SELECT id FROM doctors WHERE id = $1 AND COALESCE(is_active, TRUE)`,
      [id],
    );
    if (!rows.length) throw Object.assign(new Error(`Unknown ${what}`), { status: 400 });
    return rows[0].id;
  };

  const sd = await resolve(sdId, "SD");
  const doctor = await resolve(doctorId, "doctor");

  if (sd !== undefined) {
    params.push(sd);
    sets.push(`assigned_sd_id = $${params.length}`);
  }
  if (doctor !== undefined) {
    params.push(doctor);
    sets.push(`assigned_doctor_id = $${params.length}`);
  }
  if (!sets.length) throw Object.assign(new Error("Nothing to assign"), { status: 400 });

  const { rows } = await db.query(
    `UPDATE giniflow_visits SET ${sets.join(", ")}, updated_at = NOW()
      WHERE id = $1
      RETURNING id, assigned_sd_id, assigned_doctor_id`,
    params,
  );
  if (!rows.length) throw Object.assign(new Error("No such visit"), { status: 404 });

  const named = await db.query(
    `SELECT sd.short_name AS sd_name, doc.short_name AS doctor_name
       FROM giniflow_visits v
       LEFT JOIN doctors sd  ON sd.id  = v.assigned_sd_id
       LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
      WHERE v.id = $1`,
    [visitId],
  );

  return {
    visitId,
    actorId,
    sdId: rows[0].assigned_sd_id,
    doctorId: rows[0].assigned_doctor_id,
    sdName: named.rows[0]?.sd_name ?? null,
    doctorName: named.rows[0]?.doctor_name ?? null,
  };
}

// Who the coordinator may assign to, with the load each already carries that
// day — assigning without seeing the queue is how one SD ends up with thirty
// patients and another with four.
export async function getAssignableStaff(visitDate, db = pool) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.short_name, d.role, d.specialty, COALESCE(d.is_chief, FALSE) AS is_chief,
            COALESCE(load.n, 0)::int AS assigned_today
       FROM doctors d
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n FROM giniflow_visits v
          WHERE v.visit_date = $1::date
            AND (v.assigned_sd_id = d.id OR v.assigned_doctor_id = d.id)
       ) load ON TRUE
      WHERE COALESCE(d.is_active, TRUE)
        AND LOWER(COALESCE(d.role, '')) IN ('consultant', 'md', 'mo', 'admin')
      ORDER BY COALESCE(d.is_chief, FALSE) DESC, d.name`,
    [visitDate],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    shortName: r.short_name || r.name,
    role: r.role,
    specialty: r.specialty,
    isChief: r.is_chief,
    assignedToday: r.assigned_today,
  }));
}

// The launcher tile's number: how much of the NEXT day is still unsorted, which
// is the whole reason to open this screen.
export async function getTriageSummary(db = pool) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE v.category IS NULL)::int AS uncategorised
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = ${IST_TODAY} + 1
        AND NOT COALESCE(p.is_blocked, FALSE)`,
  );
  return rows[0] || { total: 0, uncategorised: 0 };
}
