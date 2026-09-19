import pool from "../../config/db.js";
import { toLocal10 } from "../../../shared/phone.js";
import { LAB_RUNGS, UNDRAWN_SAMPLE_STATUSES } from "../../../shared/labStages.js";
import { labStepsAreManual } from "../../../shared/manualFloor.js";
import {
  BOARD_COLUMNS,
  OFF_BOARD_STATUSES,
  compareQueue,
  columnForStatus,
  STATUS_LABEL,
  slaKeyForStatus,
  TERMINAL_STATUSES,
  NOT_A_MARKER_SQL,
  JOURNEY_START_SQL,
  WAIT_SINCE_SQL,
  isChainStatus,
  chainIndex,
  MACHINE_STATION_COLUMN,
  isMachineColumn,
  machineColumnFor,
  SIDE_TRACK_COLUMNS,
} from "../../../shared/giniflowStatus.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "./labOnlyVisits.js";
import { hideLabOnlyPatients } from "./floorSettings.js";
import { BEHIND_STATION_LABEL, healthrayChainStatus } from "./observation.js";
import { IST_TODAY, budgetColour } from "./statusEngine.js";
import {
  TESTS_HOLD_SQL,
  LIVE_LAB_CASE_SQL,
  caseReportedBeforeVisit,
  caseSampledBeforeVisit,
  chiefWaitClock,
} from "./testsHold.js";
import { getMachines } from "./machineCatalog.js";
import { JOURNEY_STEPS_SQL } from "./journey.js";
import { journeyProgress } from "../../../shared/journeyOrder.js";
import { machineForTest } from "../../../shared/machineStages.js";

export async function getSlaConfig(db = pool) {
  const { rows } = await db.query(
    `SELECT station, label, description, budget_minutes, category_overrides, display_order
       FROM giniflow_sla_config ORDER BY display_order`,
  );
  return rows.map((r) => ({
    station: r.station,
    label: r.label,
    description: r.description,
    budgetMinutes: r.budget_minutes,
    categoryOverrides: r.category_overrides,
    displayOrder: r.display_order,
  }));
}

export const budgetMap = (slaConfig) =>
  Object.fromEntries(slaConfig.map((s) => [s.station, s.budgetMinutes]));

// Per-category budgets (brief §3 `sla_config.category_overrides`, Phase 4).
//
// A station's budget is not one number for every patient. A red-category
// patient — worse and out of range — is meant to take the doctor longer than an
// in-control follow-up, and judging both against 20 minutes makes the board lie
// twice: the careful consultation shows red, and the rushed one shows green.
//
// `budgetMap` stays for the callers with no patient in hand — the timeline's
// lab_total, the day's per-station averages, which are across all categories by
// definition. Anything looking at ONE visit resolves through this instead.
//
// The override is a plain `{category: minutes}` object on the row; anything
// missing, null, or non-positive falls back to the station budget, so a
// half-filled override cannot blank a budget out.
export const budgetLookup = (slaConfig) => {
  const byStation = new Map(slaConfig.map((s) => [s.station, s]));
  return (station, category = null) => {
    const row = byStation.get(station);
    if (!row) return null;
    const override = category ? row.categoryOverrides?.[category] : null;
    return Number.isFinite(override) && override > 0 ? override : (row.budgetMinutes ?? null);
  };
};

const UNDRAWN_LAB_SQL = UNDRAWN_SAMPLE_STATUSES.map((s) => `'${s}'`).join(", ");

const TODAY_CASES = (v, p) => `
           FROM lab_cases lc
          WHERE lc.case_date = ${v}.visit_date
            AND (lc.patient_id = ${v}.patient_id
                 OR (lc.patient_id IS NULL
                     AND lc.raw_list_json->'patient'->>'healthray_uid' = ${p}.file_no))
            AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders lo
                             WHERE lo.visit_id = ${v}.id AND lo.urgency = 'today' AND lo.kind = 'lab')
            AND NOT ${caseReportedBeforeVisit(v)}
            AND ${LIVE_LAB_CASE_SQL("lc")}`;

const CASE_REPORTED = `(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on') IS NOT NULL`;

const CASE_ACTION = (action) =>
  `EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
            WHERE a.case_no = lc.case_no AND a.action IN (${action}))`;

const MACHINE_HOLD_SQL = (v, p, manualParam) => `
      SELECT
        (SELECT count(*)::int FROM giniflow_lab_orders o
          WHERE o.visit_id = ${v}.id AND o.urgency = 'today' AND o.kind = 'lab'
            AND o.sample_status IN (${UNDRAWN_LAB_SQL}))
        + (SELECT count(*)::int ${TODAY_CASES(v, p)}
            AND NOT ${CASE_ACTION("'sample_taken', 'report_uploaded'")}
            AND NOT ${CASE_REPORTED}
            AND NOT ${caseSampledBeforeVisit(v)}
            AND (${manualParam}
                 OR (lc.raw_list_json->>'phlebotomy_status' IS DISTINCT FROM 'Completed'
                     AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on' IS NULL)))
          AS lab_undrawn,
        (SELECT count(*)::int FROM giniflow_lab_orders o
          WHERE o.visit_id = ${v}.id AND o.urgency = 'today' AND o.kind = 'lab'
            AND o.sample_status = 'drawing')
        + (SELECT count(*)::int ${TODAY_CASES(v, p)}
            AND ${CASE_ACTION("'drawing_started'")}
            AND NOT ${CASE_ACTION("'sample_taken', 'report_uploaded'")}
            AND NOT ${CASE_REPORTED})
          AS lab_drawing,
        (SELECT count(*)::int FROM giniflow_lab_orders o
          WHERE o.visit_id = ${v}.id AND o.urgency = 'today' AND o.kind = 'lab'
            AND o.sample_status NOT IN ('uploaded', 'reported'))
        + (SELECT count(*)::int ${TODAY_CASES(v, p)}
            AND NOT ${CASE_ACTION("'report_uploaded'")}) AS lab_open,
        (SELECT count(*)::int FROM giniflow_lab_orders o
          WHERE o.visit_id = ${v}.id AND o.urgency = 'today' AND o.kind = 'lab'
            AND o.payment_status NOT IN ('paid', 'claim_approved')
            AND o.sample_status NOT IN ('uploaded', 'reported'))
        + (SELECT count(*)::int ${TODAY_CASES(v, p)}
            AND NOT EXISTS (SELECT 1 FROM giniflow_visit_steps lb
                             WHERE lb.visit_id = ${v}.id AND lb.step_catalog_id = 'lab_billing'
                               AND lb.status = 'done')) AS lab_unpaid,
        GREATEST(
          (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
             JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
            WHERE o.visit_id = ${v}.id AND o.urgency = 'today' AND o.kind = 'lab'
              AND e.track = 'sample' AND e.status = 'sample_collected'),
          (SELECT max(a.created_at) FROM giniflow_lab_case_actions a
            WHERE a.action = 'sample_taken'
              AND a.case_no IN (SELECT lc.case_no ${TODAY_CASES(v, p)})),
          (SELECT max((COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')::timestamptz)
             ${TODAY_CASES(v, p)}
             AND NOT ${CASE_ACTION("'sample_taken'")})
        ) AS lab_drawn_at,
        LEAST(
          (SELECT min(o.created_at) FROM giniflow_lab_orders o
            WHERE o.visit_id = ${v}.id AND o.urgency = 'today' AND o.kind = 'lab'),
          (SELECT min((COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at')::timestamptz)
             ${TODAY_CASES(v, p)})
        ) AS lab_ordered_at,
        (SELECT json_agg(json_build_object(
                  'orderId', o.id,
                  'tests', (SELECT array_agg(t.test_name ORDER BY t.test_name)
                              FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id),
                  'sampleStatus', o.sample_status,
                  'paid', o.payment_status IN ('paid', 'claim_approved'),
                  'paidAt', COALESCE(
                    (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
                      WHERE e.lab_order_id = o.id AND e.track = 'payment'
                        AND e.status IN ('paid', 'claim_approved')),
                    o.created_at),
                  'startedAt', (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
                                 WHERE e.lab_order_id = o.id AND e.track = 'sample'
                                   AND e.status = 'in_progress')
                ) ORDER BY o.created_at)
           FROM giniflow_lab_orders o
          WHERE o.visit_id = ${v}.id AND o.kind = 'machine' AND o.urgency = 'today'
            AND o.sample_status <> 'reported') AS orders,
        (SELECT json_agg(json_build_object(
                  'test', t.test_name,
                  'paid', o.payment_status IN ('paid', 'claim_approved')))
           FROM giniflow_lab_orders o
           JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
          WHERE o.visit_id = ${v}.id AND o.kind = 'machine' AND o.urgency = 'today'
            AND o.sample_status <> 'reported') AS open_tests,
        (SELECT json_agg(json_build_object(
                  'catalogId', s.step_catalog_id, 'plannedMin', s.planned_duration_min))
           FROM giniflow_visit_steps s WHERE s.visit_id = ${v}.id) AS steps,
        LEAST(
          (SELECT min(g.recorded_at) FROM giniflow_vitals g WHERE g.visit_id = ${v}.id),
          (SELECT min(e.occurred_at) FROM giniflow_visit_events e
            WHERE e.visit_id = ${v}.id AND e.status IN ('with_vitals', 'vitals_done')
              AND e.actor_role <> 'system')
        ) AS vitals_at,
        (SELECT e.meta->>'source' FROM giniflow_visit_events e
          WHERE e.visit_id = ${v}.id AND ${NOT_A_MARKER_SQL("e.status")}
          ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS room_source`;

// One round trip for the whole day. The lateral joins keep it to a single query
// no matter how many visits the day has — the board polls every 10s and a
// per-visit follow-up query would multiply that by the floor's population.
const BOARD_SQL = `
  SELECT v.id,
         v.patient_id,
         v.visit_date::text                        AS visit_date,
         v.current_status,
         v.results_status,
         v.category,
         v.blocked_reason,
         v.resume_status,
         v.paused_at, v.paused_reason, v.paused_ms_total,
         v.priority,
         v.priority_reason,
         v.queue_position,
         v.queue_column,
         v.healthray_status,
         v.healthray_status_at,
         v.behind_station,
         -- Tests ordered today whose report is not filed. Derived, never a
         -- status: the patient has not moved anywhere, and nobody performed a
         -- step called "waiting". It is a fact about their orders, and the card
         -- says so rather than leaving them looking idle (39 §16).
         (SELECT count(*)::int FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.urgency = 'today'
             AND o.sample_status NOT IN ('uploaded', 'reported')) AS reports_outstanding,
         (SELECT array_agg(t.test_name ORDER BY t.test_name)
            FROM giniflow_lab_orders o
            JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
           WHERE o.visit_id = v.id AND o.urgency = 'today'
             AND o.payment_status NOT IN ('paid', 'claim_approved')
             AND o.sample_status NOT IN ('uploaded', 'reported')) AS unpaid_tests,
         (SELECT count(*)::int FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.urgency = 'today'
             AND o.payment_status NOT IN ('paid', 'claim_approved')
             AND o.sample_status NOT IN ('uploaded', 'reported')) AS unpaid_orders,
         -- Whether the floor's OWN pipeline had any today orders at all, so
         -- reports_outstanding = 0 can be told apart from "never had one".
         (SELECT count(*)::int FROM giniflow_lab_orders o
           WHERE o.visit_id = v.id AND o.urgency = 'today') AS lab_orders_today,
         v.appointment_time::text                  AS appointment_time,
         p.name                                    AS patient_name,
         p.file_no,
         p.age,
         p.sex,
         v.assigned_doctor_id,
         sd.short_name                             AS sd_name,
         doc.short_name                            AS doctor_name,
         doc.name                                  AS doctor_full_name,
         seq.visit_number,
         jr.steps AS journey_steps,
         ${labOnlyPredicate("v", "$2")}            AS lab_only,
         tests.names                               AS lab_test_names,
         tests.cases                               AS lab_all_cases,
         tests.reported                            AS lab_all_reported,
         first_ev.occurred_at                      AS journey_started_at,
         last_ev.occurred_at                       AS status_since,
         hold.tests_pending,
         hold.tests_ready_at,
         machine.orders                            AS machine_orders,
         machine.open_tests                        AS machine_open_tests,
         machine.steps                             AS machine_steps,
         machine.vitals_at                         AS machine_vitals_at,
         machine.room_source                       AS room_source,
         machine.lab_undrawn,
         machine.lab_drawing,
         machine.lab_open,
         machine.lab_drawn_at,
         machine.lab_ordered_at,
         lab.sample_status                         AS lab_sample_status,
         lab.payment_status                        AS lab_payment_status,
         lab.test_count                            AS lab_test_count,
         lab.since                                 AS lab_since,
         hrlab.cases                               AS hr_lab_cases,
         hrlab.tests                               AS hr_lab_tests,
         hrlab.since                               AS hr_lab_since,
         hrlab.collected                           AS hr_lab_collected,
         hrlab.all_collected                       AS hr_lab_all_collected,
         hrlab.at_lab                              AS hr_lab_at_lab
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN doctors sd  ON sd.id  = v.assigned_sd_id
    LEFT JOIN doctors doc ON doc.id = v.assigned_doctor_id
    -- How far along this patient's OWN journey is. The columns show where the
    -- floor has them; this shows how much of what they came for is left, which
    -- for a patient with an ECG and an X-Ray still to do is a different answer
    -- (29-RECEPTION-JOURNEY-PLAN.md).
    LEFT JOIN LATERAL (${JOURNEY_STEPS_SQL("v")}) jr ON TRUE
    LEFT JOIN LATERAL (
      -- The patient's real visit sequence. giniflow_visits alone would always
      -- say 1 — it has no history before today (GF-05).
      SELECT COUNT(*)::int + 1 AS visit_number
        FROM appointments pa
       WHERE pa.patient_id = v.patient_id
         AND pa.appointment_date < v.visit_date
         AND pa.status = 'completed'
    ) seq ON TRUE
    LEFT JOIN LATERAL (
      -- The LAST check-in, not the first. A patient who steps out for lunch is
      -- re-checked in on HealthRay when they come back, and the total is meant
      -- to answer "how long since we last had them", not to bill them for the
      -- hour they spent at the canteen. Only one visit in the 60 days to
      -- 9 Sep 2026 carried two check-ins, and it read 133 min against a real 44.
      SELECT e.occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND ${JOURNEY_START_SQL("e.status")}
       ORDER BY e.occurred_at DESC LIMIT 1
    ) first_ev ON TRUE
    LEFT JOIN LATERAL (
      SELECT e.occurred_at FROM giniflow_visit_events e
       WHERE e.visit_id = v.id AND ${WAIT_SINCE_SQL("e", "v")}
       ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
    ) last_ev ON TRUE
    LEFT JOIN LATERAL (${TESTS_HOLD_SQL("v", "p")}) hold ON TRUE
    LEFT JOIN LATERAL (${MACHINE_HOLD_SQL("v", "p", "$3")}) machine ON TRUE
    LEFT JOIN LATERAL (
      SELECT o.sample_status, o.payment_status, o.updated_at AS since,
             (SELECT COUNT(*)::int FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS test_count
        FROM giniflow_lab_orders o
       WHERE o.visit_id = v.id AND o.sample_status <> 'uploaded'
         -- The LAB track. A machine test is an order too, and it holds the
         -- patient the same way — but nothing is drawn for it, so shown here it
         -- reads "Paid · awaiting collection" against a sample that will never
         -- exist (36-MACHINE-TEST-STATION-PLAN.md §2.7). It still blocks the
         -- visit results status, so the patient is not released early; it simply
         -- stops pretending to be blood.
         AND o.kind = 'lab'
         -- Today's tests only, the same rule the lab station and the reception
         -- desk already apply. Without it a test ordered for the patient's NEXT
         -- visit joined today's lab track: payment pending at a desk collecting
         -- nothing, a sample nobody was waiting for, and — because a Gini order
         -- is the only lab card carrying a budget — a red Lab column driven
         -- entirely by work that is not due.
         --
         -- It also settles the LIMIT 1 below. A next-visit order is written at
         -- the end of a consultation, so it is newer than a same-day one and
         -- would otherwise hide the today sample the floor is actually waiting on.
         AND o.urgency = 'today'
       ORDER BY o.created_at DESC LIMIT 1
    ) lab ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS cases,
             sum(coalesce(array_length(lc.test_names, 1), 0))::int AS tests,
             min(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at') AS since,
             -- The floor's own record counts, exactly as it does in labStation.
             -- HealthRay only learns a sample was drawn when the RESULTS come
             -- back: collected_on rides in on raw_detail_json hours later, and
             -- phlebotomy_status is left at Pending on most days. Reading
             -- HealthRay alone therefore told a floor of twenty drawn samples
             -- that every one was still awaiting collection, and labelled
             -- patients whose blood was taken as having left without giving one.
             bool_or(
               lc.raw_list_json->>'phlebotomy_status' = 'Completed'
               OR (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on') IS NOT NULL
               OR EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                           WHERE a.case_no = lc.case_no AND a.action = 'sample_taken')
             ) AS collected,
             -- "Any drawn" answers what the lab is doing; "every one drawn"
             -- answers whether a patient went home with a tube still owed. A
             -- patient with two cases and one collected satisfies the first and
             -- fails the second, and it is the second that must not be missed.
             bool_and(
               lc.raw_list_json->>'phlebotomy_status' = 'Completed'
               OR (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on') IS NOT NULL
               OR EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                           WHERE a.case_no = lc.case_no AND a.action = 'sample_taken')
             ) AS all_collected,
             bool_or(
               (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'received_on') IS NOT NULL
               OR EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                           WHERE a.case_no = lc.case_no
                             AND a.action IN ('processing', 'results_ready'))
             ) AS at_lab
        FROM lab_cases lc
       WHERE lc.case_date = v.visit_date
         AND (lc.patient_id = v.patient_id
              OR (lc.patient_id IS NULL
                  AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
         AND lc.raw_detail_json->>'reported_on' IS NULL
         AND lc.pdf_storage_path IS NULL
         AND ${LIVE_LAB_CASE_SQL("lc")}
      HAVING count(*) > 0
    ) hrlab ON TRUE
    LEFT JOIN LATERAL (
      -- Every lab case of the day, reported ones included — which is what
      -- separates it from the hrlab lateral above. hrlab answers "what is the lab still
      -- working on"; this answers "what did this patient come to give", and a
      -- samples-only patient whose reports are already back still has to appear
      -- somewhere.
      SELECT count(DISTINCT lc.id)::int                                       AS cases,
             count(DISTINCT lc.id) FILTER (
               WHERE COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NOT NULL
                  OR EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                              WHERE a.case_no = lc.case_no AND a.action = 'report_uploaded')
             )::int                                                            AS reported,
             array_remove(array_agg(DISTINCT t), NULL)                         AS names
        FROM lab_cases lc
        LEFT JOIN LATERAL unnest(COALESCE(lc.test_names, ARRAY[]::text[])) t ON TRUE
       WHERE lc.case_date = v.visit_date
         AND (lc.patient_id = v.patient_id
              OR (lc.patient_id IS NULL
                  AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
         AND ${LIVE_LAB_CASE_SQL("lc")}
      HAVING count(*) > 0
    ) tests ON TRUE
   WHERE v.visit_date = $1::date
   ORDER BY last_ev.occurred_at NULLS LAST`;

const minutesSince = (from, now) =>
  from ? Math.max(0, Math.round((now - new Date(from)) / 60000)) : null;

const istClock = (ts) =>
  ts
    ? new Date(ts).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Kolkata",
      })
    : null;

const subtitleFor = (row) => {
  if (row.blocked_reason) return row.blocked_reason;
  // A queueing patient's most useful fact is when they arrived (GF-06).
  if (["checked_in", "vitals_pending"].includes(row.current_status)) {
    const at = istClock(row.journey_started_at);
    return at ? `${at} check-in` : "Checked in";
  }
  if (row.current_status === "with_sd" && row.sd_name) return `${row.sd_name} · workup`;
  if (row.current_status === "with_doctor" && row.doctor_name)
    return `${row.doctor_name} · consult`;
  if (row.current_status === "ready_for_doctor")
    return row.results_status === "ready" ? "Results ✓ · SD plan ready" : "SD plan ready";
  if (row.current_status === "with_vitals") return "BP + weight in progress";
  if (row.current_status === "pharmacy_pending") return "Dispensing";
  if (["dispensed", "exited"].includes(row.current_status)) return "Exited";
  return STATUS_LABEL[row.current_status] || row.current_status;
};

// The one-line note under a card explaining what it is waiting on. Blocked
// reasons take precedence and are rendered in the red variant by the board.
const hintFor = (row) => {
  if (row.blocked_reason) return null;
  if (row.current_status === "checked_in" || row.current_status === "vitals_pending")
    return "Waiting for vitals station";
  if (row.current_status === "ready_for_doctor" && row.category === "in_control")
    return "Green category — SD could close";
  if (row.current_status === "sd_pending") return "Waiting for Chief Endocrinologist";
  return null;
};

const hintIconFor = (row) =>
  row.current_status === "ready_for_doctor" && row.category === "in_control" ? "💡" : "→";

// What the lab card is waiting on, distinct from the main journey's hints (GF-19).
// Everything from the moment the tube leaves the patient to the moment the
// report is filed — including "reported" itself, since a filed report cannot
// exist without a drawn sample. Derived, so the two rungs the room split added
// cannot be missed here — a sample sent to the lab and not yet received had
// neither `collected` nor `atLab`, which is the card claiming the patient left
// without giving a sample.
const DRAWN_STATUSES = LAB_RUNGS.filter((r) => r.key !== "pending").flatMap(
  (r) => r.sampleStatuses,
);

const LAB_HINT = {
  payment_pending: "Waiting: reception payment",
  results_ready: "Upload pending",
  processing: null,
  sample_received: null,
  sample_sent: "Waiting: lab to receive the sample",
  sample_collected: null,
  drawing: null,
  paid: "Waiting: sample collection",
  ordered: "Waiting: payment request",
};

// A samples-only patient still on the board once the lab has finished with
// them. `hrlab` has dropped them — nothing is pending — so the lab track builds
// its own line rather than showing an empty card.
const labOnlySummary = (row) => {
  const cases = row.lab_all_cases ?? 0;
  const reported = row.lab_all_reported ?? 0;
  if (!cases) return { subtitle: "Registered · no case yet", hint: "Waiting: sample collection" };
  if (reported >= cases) return { subtitle: "✅ Reports ready", hint: null };
  return { subtitle: `${reported} of ${cases} reported`, hint: null };
};

const LAB_SUBTITLE = {
  ordered: "Ordered",
  payment_pending: "💰 Payment pending at reception",
  paid: "Paid · awaiting collection",
  drawing: "🩸 Collecting now at Lab 1",
  sample_collected: "Sample collected",
  sample_sent: "📤 Sent to the lab",
  sample_received: "📥 Received at the lab",
  processing: "⚙️ Processing in analyzer",
  results_ready: "📤 Results ready — awaiting upload",
};

// A visit the floor never closed keeps its clock running, which is right while
// the day is still being worked and wrong the moment the day is over: reading
// back a past board, an unfinished patient showed days of waiting and dragged
// every average and bottleneck with them. The clock stops at midnight IST of
// the day being read.
export const boardClock = (visitDate, now = new Date()) => {
  const end = new Date(`${visitDate}T23:59:59.999+05:30`);
  return now < end ? now : end;
};

const NOT_YET_FOR_MACHINES = ["with_vitals", "blocked_reports"];
const MACHINE_BLOCKING_ROOMS = ["with_sd", "with_doctor", "with_rx"];

const testStage = (sampleStatus) =>
  sampleStatus === "in_progress" ? "in_progress" : sampleStatus === "done" ? "done" : "waiting";

const MACHINE_STATION_ORDER = Object.keys(MACHINE_STATION_COLUMN);

export const owningMachineStation = (tests) => {
  const firstIn = (list) =>
    MACHINE_STATION_ORDER.find((station) => list.some((t) => t.station === station)) || null;
  const running = tests.find((t) => t.stage === "in_progress");
  if (running) return running.station;
  const startable = tests.filter((t) => t.stage === "waiting" && !t.heldBy && !t.unpaid);
  return firstIn(startable) || firstIn(tests) || "machine_room";
};

const blockersFor = (openTests, orders, machines) => {
  const listed =
    openTests ??
    (orders || []).flatMap((o) => (o.tests || []).map((test) => ({ test, paid: true })));
  const blockers = new Map();
  for (const { test, paid } of listed) {
    const m = machineForTest(machines, test);
    if (!m) continue;
    const seen = blockers.get(m.id);
    blockers.set(m.id, { machine: m.id, label: m.name, unpaid: !paid || !!seen?.unpaid });
  }
  return blockers;
};

export function machineCardFor(
  { orders, steps, vitalsAt, drawnAt = null, openTests = null },
  machines,
  now,
) {
  if (!orders?.length) return null;
  const blockers = blockersFor(openTests, orders, machines);
  const plannedFor = (machineId) =>
    (steps || []).find((s) => s.catalogId === machineId && s.plannedMin > 0)?.plannedMin ?? null;

  const tests = orders.flatMap((o) => {
    const stage = testStage(o.sampleStatus);
    const seen = new Set();
    const entries = (o.tests?.length ? o.tests : ["Machine test"]).flatMap((name) => {
      const m = machineForTest(machines, name);
      const key = m?.id || name;
      if (seen.has(key)) return [];
      seen.add(key);
      const budget = m ? (plannedFor(m.id) ?? m.durationMin ?? null) : null;
      return [
        {
          orderId: o.orderId,
          machine: m?.id || null,
          station: m?.station || "machine_room",
          heldBy:
            stage === "waiting" && m?.requiresBefore
              ? (blockers.get(m.requiresBefore) ?? null)
              : null,
          label: m?.name || name,
          stage,
          unpaid: o.paid === false,
          budget,
          startedAt: stage === "in_progress" ? o.startedAt : null,
          minutesOnMachine: stage === "in_progress" ? minutesSince(o.startedAt, now) : null,
        },
      ];
    });
    return entries.map((t) => ({ ...t, paidAt: o.paidAt }));
  });

  const ms = (value) => (value ? new Date(value).getTime() : null);
  const paidMs = Math.min(...tests.map((t) => ms(t.paidAt)).filter((x) => x !== null));
  const sinceMs = Math.max(
    ...[Number.isFinite(paidMs) ? paidMs : null, ms(vitalsAt), ms(drawnAt)].filter(
      (x) => x !== null,
    ),
  );
  const since = Number.isFinite(sinceMs) ? new Date(sinceMs) : null;
  const minutes = minutesSince(since, now);
  const budgets = tests.map((t) => t.budget).filter((b) => b > 0);
  const budget = budgets.length ? budgets.reduce((a, b) => a + b, 0) : null;
  const running = tests.filter((t) => t.stage === "in_progress");
  const waiting = tests.filter((t) => t.stage === "waiting");
  const unpaid = waiting.filter((t) => t.unpaid);
  const runningOver = running.some((t) => t.budget && t.minutesOnMachine > t.budget);
  const station = owningMachineStation(tests);

  const subtitle = running.length
    ? `▶️ On ${running
        .map((t) => (t.budget ? `${t.label} · ${t.minutesOnMachine}m of ${t.budget}m` : t.label))
        .join(", ")}`
    : waiting.length && unpaid.length === waiting.length
      ? `💳 ${unpaid.map((t) => t.label).join(", ")} — payment pending at reception`
      : waiting.length
        ? `⏳ Waiting for ${waiting.map((t) => t.label).join(", ")}`
        : "✅ Test done — report pending";

  return {
    tests: tests.map(({ paidAt: _paidAt, ...t }) => t),
    station,
    column: machineColumnFor(station),
    running: running.length > 0,
    awaitingPayment: waiting.length > 0 && unpaid.length === waiting.length,
    subtitle,
    since: since ? since.toISOString() : null,
    minutes,
    budget,
    colour: runningOver ? "red" : budgetColour(minutes ?? 0, budget),
  };
}

export const placementFor = (
  card,
  { roomSource = null, vitalsAt = null, labUndrawn = 0, labOpen = 0 } = {},
) => {
  if (card.finished) return "chain";
  if ((!vitalsAt && !card.labOnly) || NOT_YET_FOR_MACHINES.includes(card.status)) return "chain";
  if (MACHINE_BLOCKING_ROOMS.includes(card.status) && roomSource !== "healthray") return "chain";
  if (card.machine?.running) return "machine";
  if (labUndrawn > 0) return "lab";
  if (card.machine) return "machine";
  if (labOpen > 0 && !card.labOnly) return "lab";
  return "chain";
};

export const ownedByMachineRoom = (card, facts = {}) => placementFor(card, facts) === "machine";

const labTrackFor = (card, { labUndrawn, labDrawing, labOrderedAt, labDrawnAt }, now) => {
  const since = labUndrawn > 0 ? labOrderedAt : labDrawnAt || labOrderedAt;
  const minutes = minutesSince(since, now);
  const base = card.lab || { source: "healthray", testCount: card.labTests?.length || 0 };
  return {
    ...base,
    since: since ? new Date(since).toISOString() : base.since,
    minutes: minutes ?? base.minutes ?? 0,
    budget: base.budget ?? null,
    colour: base.colour ?? "grey",
    subtitle:
      labDrawing > 0
        ? "🩸 Collecting now at Lab 1"
        : labUndrawn > 0
          ? [
              base.subtitle || "Awaiting collection",
              ...(card.machine?.tests || [])
                .filter((t) => t.stage === "waiting")
                .map((t) => t.label)
                .filter((l, i, all) => all.indexOf(l) === i)
                .slice(0, 3)
                .map((l, i) => (i === 0 ? `also due: ${l}` : l)),
            ].join(" · ")
          : "⏳ Sample collected — waiting for lab reports",
    hint: labUndrawn > 0 ? (base.hint ?? null) : null,
    collected: labUndrawn === 0,
  };
};

const onTrackClock = (card) => {
  const track =
    card.placement === "machine" ? card.machine : card.placement === "lab" ? card.lab : null;
  if (!track) return card;
  return {
    ...card,
    statusSince: track.since,
    statusMinutes: track.minutes,
    statusBudget: track.budget ?? null,
    statusColour:
      card.placement === "machine" ? track.colour : budgetColour(track.minutes ?? 0, track.budget),
    hint: null,
    hintIcon: null,
  };
};

export async function getTestsOrderedAt(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT LEAST(
              (SELECT min(o.created_at) FROM giniflow_lab_orders o
                WHERE o.visit_id = v.id AND o.urgency = 'today'),
              (SELECT min((COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at')::timestamptz)
                 ${TODAY_CASES("v", "p")})
            ) AS ordered_at
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0]?.ordered_at ? new Date(rows[0].ordered_at) : null;
}

const placeCard = (card, row, machines, now) => {
  const clock = card.paused && row.paused_at ? new Date(row.paused_at) : now;
  const facts = {
    roomSource: row.room_source,
    vitalsAt: row.machine_vitals_at,
    labUndrawn: row.lab_undrawn ?? 0,
    labDrawing: row.lab_drawing ?? 0,
    labOpen: row.lab_open ?? 0,
    labOrderedAt: row.lab_ordered_at,
    labDrawnAt: row.lab_drawn_at,
  };
  const machine = machineCardFor(
    {
      orders: row.machine_orders,
      openTests: row.machine_open_tests,
      steps: row.machine_steps,
      vitalsAt: row.machine_vitals_at,
      drawnAt: row.lab_drawn_at,
    },
    machines,
    clock,
  );
  const withMachine = { ...card, machine };
  const placement = placementFor(withMachine, facts);
  return onTrackClock({
    ...withMachine,
    lab: placement === "lab" ? labTrackFor(withMachine, facts, clock) : card.lab,
    placement,
    machineOwned: placement === "machine",
    labStillToCollect: placement === "machine" && facts.labUndrawn > 0,
    heldByStation:
      placement === "machine" ? !!machine?.running : placement === "lab" && facts.labDrawing > 0,
  });
};

const machineColumnName = (key) =>
  BOARD_COLUMNS.find((col) => col.key === key)?.name || "Machine Room";

export async function getTestsPlacement(visitId, now = new Date(), db = pool) {
  const [{ rows }, machines] = await Promise.all([
    db.query(
      `SELECT v.current_status, v.paused_at,
              ${labOnlyPredicate("v", "$2")} AS lab_only,
              m.orders AS machine_orders, m.open_tests AS machine_open_tests,
              m.steps AS machine_steps,
              m.vitals_at AS machine_vitals_at, m.room_source,
              m.lab_undrawn, m.lab_drawing, m.lab_open, m.lab_unpaid, m.lab_drawn_at,
              m.lab_ordered_at
         FROM giniflow_visits v
         JOIN patients p ON p.id = v.patient_id
         CROSS JOIN LATERAL (${MACHINE_HOLD_SQL("v", "p", "$3")}) m
        WHERE v.id = $1`,
      [visitId, LAB_ONLY_DOCTOR, labStepsAreManual()],
    ),
    getMachines(db),
  ]);
  const row = rows[0];
  if (!row) return null;
  const placed = placeCard(
    {
      status: row.current_status,
      finished: TERMINAL_STATUSES.includes(row.current_status),
      labOnly: !!row.lab_only,
      paused: !!row.paused_at,
      lab: null,
    },
    row,
    machines,
    now,
  );
  if (placed.placement === "machine") {
    return {
      kind: "machine",
      since: placed.machine.since,
      budget: placed.machine.budget,
      label: `${machineColumnName(placed.machine.column)} — ${placed.machine.tests.map((t) => t.label).join(", ")}`,
      machine: placed.machine,
    };
  }
  if (placed.placement === "lab") {
    return {
      kind: "lab",
      since: placed.lab.since,
      budget: null,
      label:
        row.lab_unpaid > 0 && row.lab_undrawn > 0
          ? "Waiting for payment at reception — lab tests"
          : row.lab_undrawn > 0
            ? "At the lab — sample to collect"
            : "Waiting for lab reports",
    };
  }
  return null;
}

const latest = (...values) => {
  const times = values.filter(Boolean).map((v) => new Date(v).getTime());
  return times.length ? new Date(Math.max(...times)) : null;
};

const earliest = (...values) => {
  const times = values.filter(Boolean).map((v) => new Date(v).getTime());
  return times.length ? new Date(Math.min(...times)) : null;
};

const stationOf = (m) => m.station || "machine_room";

const firstRoom = (list) =>
  MACHINE_STATION_ORDER.find((station) => list.some((m) => stationOf(m) === station)) ||
  "machine_room";

const waitingLabel = (list, names) => {
  const station = firstRoom(list);
  const room =
    station === "machine_room" ? "the Machine Room" : machineColumnName(machineColumnFor(station));
  return `Waiting for ${room} — ${names}`;
};

const runLabel = (station, label) =>
  station === "machine_room"
    ? `On the machine — ${label}`
    : `On the ${machineColumnName(machineColumnFor(station))} machine — ${label}`;

export function testSegmentsFor(f, now = new Date()) {
  if (!f || (!f.vitalsAt && !f.labOnly)) return [];
  const base = f.vitalsAt ? new Date(f.vitalsAt) : null;
  const hasLab = !!f.labOrderedAt;
  const machines = f.machineOrders || [];
  const hasMachine = machines.length > 0;
  if (!hasLab && !hasMachine) return [];
  const cap = f.endAt ? new Date(f.endAt) : null;
  const segments = [];
  const push = (seg) => {
    if (!seg.from) return;
    let to = seg.to ? new Date(seg.to) : null;
    if (cap) {
      if (seg.from >= cap) return;
      to = to && to < cap ? to : cap;
    }
    if (to && to <= seg.from) return;
    if (!to && seg.from >= now) return;
    segments.push({ ...seg, to });
  };
  const payment = (from, to, what) =>
    push({
      status: "payment_wait",
      label: `Waiting for payment at reception — ${what}`,
      from,
      to,
      isWait: true,
    });

  let labDrawn = null;
  if (hasLab) {
    const ordered = latest(base, f.labOrderedAt);
    if (f.labUnpaid) {
      payment(ordered, null, "lab tests");
    } else {
      const paid = latest(base, f.labPaidAt || f.labOrderedAt);
      if (paid > ordered) payment(ordered, paid, "lab tests");
      labDrawn = f.labUndrawn > 0 ? null : latest(f.labDrawnAt) || paid;
      push({ status: "lab_room", label: "At the lab", from: paid, to: labDrawn });
    }
  }

  let machineDone = null;
  if (hasMachine && (!hasLab || labDrawn)) {
    const free = hasLab ? latest(base, labDrawn) : base;
    const ordered = latest(free, earliest(...machines.map((m) => m.createdAt)));
    const unpaid = machines.every((m) => !m.paidAt);
    const paid = unpaid ? null : latest(free, earliest(...machines.map((m) => m.paidAt)));
    if (unpaid) payment(ordered, null, f.machineLabel || "machine tests");
    else if (paid > ordered) payment(ordered, paid, f.machineLabel || "machine tests");
    const runs = machines
      .filter((m) => m.startedAt)
      .map((m) => ({
        from: new Date(m.startedAt),
        to: m.doneAt ? new Date(m.doneAt) : null,
        label: m.label || "machine test",
        station: stationOf(m),
      }))
      .sort((a, b) => a.from - b.from);
    const waitingFor = (list) =>
      waitingLabel(list, list.map((m) => m.label || "machine test").join(", "));
    const allDone = machines.every((m) => m.doneAt);
    let cursor = paid;
    for (const run of runs) {
      if (!cursor) break;
      if (run.from > cursor) {
        push({
          status: "machine_wait",
          label: waitingFor(
            machines.filter((m) => !m.startedAt || new Date(m.startedAt) >= run.from),
          ),
          from: cursor,
          to: run.from,
          isWait: true,
        });
      }
      const from = run.from > cursor ? run.from : cursor;
      push({
        status: "machine_room",
        label: runLabel(run.station, run.label),
        from,
        to: run.to,
        budgetMinutes: machines.find((m) => m.label === run.label)?.budget ?? null,
      });
      cursor = run.to && run.to > cursor ? run.to : run.to ? cursor : null;
    }
    if (cursor && !allDone) {
      push({
        status: "machine_wait",
        label: waitingFor(machines.filter((m) => !m.doneAt)),
        from: cursor,
        to: null,
        isWait: true,
      });
    }
    machineDone = allDone ? latest(...machines.map((m) => m.doneAt)) : null;
  }

  const testsDone = (!hasLab || labDrawn) && (!hasMachine || machineDone);
  if (testsDone) {
    const from = latest(labDrawn, machineDone);
    const labIn = !hasLab || f.labOpen === 0;
    const machineIn = machines.every((m) => m.reportedAt);
    const to =
      labIn && machineIn
        ? latest(hasLab ? f.labReportedAt : null, ...machines.map((m) => m.reportedAt))
        : null;
    const labPending = hasLab && f.labOpen > 0;
    const machinePending = machines.some((m) => !m.reportedAt);
    push({
      status: "reports_wait",
      label:
        labPending && machinePending
          ? "Waiting for lab and machine reports"
          : labPending
            ? "Waiting for lab reports"
            : machinePending
              ? "Waiting for machine reports"
              : "Waiting for reports",
      from,
      to: to && to > from ? to : labIn && machineIn ? from : null,
      isWait: true,
    });
  }
  segments.sort((a, b) => a.from - b.from);
  segments.forEach((seg, i) => {
    const next = segments[i + 1];
    if (next && seg.to && next.from > seg.to) seg.to = next.from;
  });
  return segments;
}

export async function getTestSegments(visitId, now = new Date(), db = pool) {
  const [{ rows }, machines] = await Promise.all([
    db.query(
      `SELECT ${labOnlyPredicate("v", "$2")} AS lab_only,
              CASE WHEN v.current_status IN ('dispensed', 'exited', 'no_show', 'cancelled')
                   THEN (SELECT max(e.occurred_at) FROM giniflow_visit_events e
                          WHERE e.visit_id = v.id AND e.status = v.current_status)
              END AS end_at,
              m.steps AS machine_steps, m.vitals_at, m.lab_undrawn, m.lab_open,
              m.lab_drawn_at, m.lab_ordered_at, m.lab_unpaid,
              (SELECT max(lb.completed_at) FROM giniflow_visit_steps lb
                WHERE lb.visit_id = v.id AND lb.step_catalog_id = 'lab_billing'
                  AND lb.status = 'done') AS lab_billing_done_at,
              (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
                 JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
                WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                  AND e.track = 'payment' AND e.status IN ('paid', 'claim_approved')) AS lab_order_paid_at,
              EXISTS (SELECT 1 FROM giniflow_lab_orders o
                       WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab') AS has_lab_order,
              GREATEST(
                (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
                   JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
                  WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                    AND e.track = 'sample' AND e.status IN ('uploaded', 'reported')),
                (SELECT max(a.created_at) FROM giniflow_lab_case_actions a
                  WHERE a.action = 'report_uploaded'
                    AND a.case_no IN (SELECT lc.case_no ${TODAY_CASES("v", "p")}))
              ) AS lab_reported_at,
              (SELECT min(o.created_at) FROM giniflow_lab_orders o
                WHERE o.visit_id = v.id AND o.urgency = 'today') AS orders_created_at,
              (SELECT array_agg(o.created_at) FROM giniflow_lab_orders o
                WHERE o.visit_id = v.id AND o.urgency = 'today') AS order_times,
              (SELECT json_agg(json_build_object(
                        'tests', (SELECT array_agg(t.test_name) FROM giniflow_lab_order_tests t
                                   WHERE t.lab_order_id = o.id),
                        'sampleStatus', o.sample_status,
                        'paidAt', (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
                                    WHERE e.lab_order_id = o.id AND e.track = 'payment'
                                      AND e.status IN ('paid', 'claim_approved')),
                        'createdAt', o.created_at,
                        'startedAt', (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
                                       WHERE e.lab_order_id = o.id AND e.track = 'sample'
                                         AND e.status = 'in_progress'),
                        'doneAt', (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
                                    WHERE e.lab_order_id = o.id AND e.track = 'sample'
                                      AND e.status IN ('done', 'reported')),
                        'reportedAt', (SELECT min(e.occurred_at) FROM giniflow_lab_order_events e
                                        WHERE e.lab_order_id = o.id AND e.track = 'sample'
                                          AND e.status = 'reported')))
                 FROM giniflow_lab_orders o
                WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'machine') AS machine_all
         FROM giniflow_visits v
         JOIN patients p ON p.id = v.patient_id
         CROSS JOIN LATERAL (${MACHINE_HOLD_SQL("v", "p", "$3")}) m
        WHERE v.id = $1`,
      [visitId, LAB_ONLY_DOCTOR, labStepsAreManual()],
    ),
    getMachines(db),
  ]);
  const r = rows[0];
  if (!r) return { segments: [], orderTimes: [] };
  const plannedFor = (id) =>
    (r.machine_steps || []).find((st) => st.catalogId === id && st.plannedMin > 0)?.plannedMin;
  const machineOrders = (r.machine_all || []).map((o) => {
    const names = [
      ...new Set(
        (o.tests || []).map((n) => machineForTest(machines, n)?.name || n).filter(Boolean),
      ),
    ];
    const ids = (o.tests || []).map((n) => machineForTest(machines, n)).filter(Boolean);
    return {
      ...o,
      station: ids[0]?.station || "machine_room",
      label: names.join(", ") || "machine test",
      budget: ids.reduce((sum, m) => sum + (plannedFor(m.id) ?? m.durationMin ?? 0), 0) || null,
      doneAt: o.doneAt || (o.sampleStatus === "reported" ? o.reportedAt : null),
      reportedAt: o.reportedAt || (o.sampleStatus === "reported" ? o.doneAt : null),
    };
  });
  const card = machineOrders.length
    ? machineCardFor(
        {
          orders: machineOrders.map((o, i) => ({ ...o, orderId: `m${i}` })),
          steps: r.machine_steps,
          vitalsAt: r.vitals_at,
        },
        machines,
        now,
      )
    : null;
  const segments = testSegmentsFor(
    {
      labOnly: !!r.lab_only,
      endAt: r.end_at,
      vitalsAt: r.vitals_at,
      testsOrderedAt: earliest(r.orders_created_at, r.lab_ordered_at),
      labOrderedAt: r.lab_ordered_at,
      labPaidAt: r.has_lab_order
        ? r.lab_order_paid_at
        : latest(r.lab_ordered_at, r.lab_billing_done_at),
      labUnpaid: r.has_lab_order ? !r.lab_order_paid_at : r.lab_unpaid > 0,
      labUndrawn: r.lab_undrawn ?? 0,
      labOpen: r.lab_open ?? 0,
      labDrawnAt: r.lab_drawn_at,
      labReportedAt: r.lab_reported_at,
      machineOrders,
      machineLabel: card ? card.tests.map((t) => t.label).join(", ") : null,
      machineBudget: card?.budget ?? null,
    },
    now,
  );
  return { segments, orderTimes: (r.order_times || []).map((t) => new Date(t)) };
}

export async function getScribeLabMarks(visitId, db = pool) {
  const LABEL = {
    paid: "Lab payment cleared",
    drawing: "Collection started",
    sample_collected: "Sample collected",
    sample_sent: "Sample sent to the lab",
    sample_received: "Sample received at the lab",
    processing: "Processing",
    results_ready: "Results ready",
    uploaded: "Report uploaded",
  };
  const ACTION = {
    drawing_started: "Collection started",
    sample_taken: "Sample collected",
    sample_sent: "Sample sent to the lab",
    sample_received: "Sample received at the lab",
    processing: "Processing",
    results_ready: "Results ready",
    report_uploaded: "Report uploaded",
  };
  const { rows } = await db.query(
    `SELECT e.status AS key, e.occurred_at AS at, 'order' AS src, o.id::text AS ref,
            (SELECT array_agg(t.test_name ORDER BY t.test_name)
               FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_order_events e
       JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
      WHERE o.visit_id = $1 AND o.urgency = 'today' AND o.kind = 'lab'
        AND ((e.track = 'sample' AND e.status <> 'paid') OR (e.track = 'payment' AND e.status = 'paid'))
     UNION ALL
     SELECT a.action AS key, a.created_at AS at, 'case' AS src, a.case_no AS ref,
            (SELECT lc2.test_names FROM lab_cases lc2 WHERE lc2.case_no = a.case_no LIMIT 1) AS tests
       FROM giniflow_lab_case_actions a
       JOIN giniflow_visits v ON v.id = $1
       JOIN patients p ON p.id = v.patient_id
      WHERE a.case_no IN (SELECT lc.case_no ${TODAY_CASES("v", "p")})
     ORDER BY at`,
    [visitId],
  );
  const refs = new Set(rows.map((r) => r.ref));
  const order = [
    "Lab payment cleared",
    "Collection started",
    "Sample collected",
    "Sample sent to the lab",
    "Sample received at the lab",
    "Processing",
    "Results ready",
    "Report uploaded",
  ];
  const reached = new Map();
  for (const r of rows) {
    const label = (r.src === "order" ? LABEL : ACTION)[r.key];
    if (!label) continue;
    const byRef = reached.get(label) || new Map();
    const at = new Date(r.at);
    if (!byRef.has(r.ref) || byRef.get(r.ref) < at) byRef.set(r.ref, at);
    reached.set(label, byRef);
  }
  return order
    .filter((label) => reached.has(label))
    .map((label) => {
      const byRef = reached.get(label);
      const done = byRef.size >= refs.size;
      return {
        status: `lab:${label}`,
        label: done || refs.size < 2 ? label : `${label} (${byRef.size} of ${refs.size})`,
        enteredAt: new Date(Math.max(...[...byRef.values()].map((d) => d.getTime()))).toISOString(),
        partial: !done,
      };
    });
}

export async function getDayBoard(visitDate, slaConfig, now = boardClock(visitDate), db = pool) {
  const budgets = budgetMap(slaConfig);
  const budgetFor = budgetLookup(slaConfig);
  const hideLabOnly = await hideLabOnlyPatients(db);
  const [{ rows }, machines] = await Promise.all([
    db.query(BOARD_SQL, [visitDate, LAB_ONLY_DOCTOR, labStepsAreManual()]),
    getMachines(db),
  ]);

  const cards = rows.map((row) => placeCard(buildCard(row), row, machines, now));

  function buildCard(row) {
    // A finished visit's clock stopped when it exited; only a patient still in
    // the building is timed against the present moment.
    const finished = TERMINAL_STATUSES.includes(row.current_status);
    // A paused patient's clocks read against the moment they stepped out, so
    // the card holds still instead of counting a break nobody is waiting on.
    // Resume shifts the anchors forward by the same span, which is what keeps
    // every other duration in the system right without it knowing about pause.
    const paused = !!row.paused_at;
    const clock = finished && row.status_since ? new Date(row.status_since) : now;
    const liveClock = paused ? new Date(row.paused_at) : now;
    const { heldForTests, since: waitSince } = chiefWaitClock(row);
    const statusMinutes = finished ? null : minutesSince(waitSince, liveClock);
    const totalMinutes = minutesSince(row.journey_started_at, paused ? liveClock : clock);
    const budget = heldForTests
      ? null
      : budgetFor(slaKeyForStatus(row.current_status), row.category);
    // Settled entirely in SQL by labOnlyPredicate, so this board and the lab
    // station cannot drift apart on who counts as samples-only.
    const labOnly = !!row.lab_only;
    const labOnlyLine = labOnly ? labOnlySummary(row) : null;
    // Trust the floor's own pipeline once it is done, rather than falling
    // back to HealthRay's mirrored case (`hrlab`/`tests`) which only updates
    // as the HealthRay sync polls — paused sync leaves it looking permanently
    // unreported even after the report has actually been uploaded locally.
    const locallySettled = (row.lab_orders_today ?? 0) > 0 && (row.reports_outstanding ?? 0) === 0;
    return {
      id: row.id,
      patientId: row.patient_id,
      name: row.patient_name,
      fileNo: row.file_no,
      age: row.age,
      sex: row.sex,
      visitNumber: row.visit_number,
      journey: journeyProgress(row.journey_steps, row.current_status, row.resume_status),
      status: row.current_status,
      statusLabel: STATUS_LABEL[row.current_status] || row.current_status,
      category: row.category,
      resultsStatus: row.results_status,
      blockedReason: row.blocked_reason,
      // Carried to the card so the client can tell, before a drag starts, which
      // columns this patient may legally be dropped on.
      resumeStatus: row.resume_status,
      paused,
      pausedAt: paused ? new Date(row.paused_at).toISOString() : null,
      pausedReason: row.paused_reason || null,
      pausedMinutes: Math.round(Number(row.paused_ms_total || 0) / 60000),
      priority: row.priority,
      priorityReason: row.priority_reason,
      // A manual position belongs to the queue it was set in. advanceStatus
      // clears it on every move, but a status written by any other path — the
      // demo seeder, a backfill, a manual UPDATE — would otherwise leave a
      // position behind that pins the patient to the top of a column they have
      // already left (BQ-06). Trusting the stored column rather than the
      // clearing makes that impossible by construction.
      queuePosition:
        row.queue_column && row.queue_column === columnForStatus(row.current_status)
          ? row.queue_position
          : null,
      // What HealthRay says about this patient, when the floor has not caught up
      // (39-HYBRID-FLOOR-PLAN.md §5.4). Present only when a desk is actually
      // behind, so a card carries the warning or nothing at all — never a
      // reassuring "in agreement" badge nobody needs to read.
      behind: row.behind_station
        ? {
            station: row.behind_station,
            label: BEHIND_STATION_LABEL[row.behind_station] || row.behind_station,
            healthrayLabel: STATUS_LABEL[healthrayChainStatus(row.healthray_status)] || null,
            minutes: minutesSince(row.healthray_status_at, now),
          }
        : null,
      // Waiting on the lab, not on a person. Shown only while they are short of
      // the doctor — past that point the reports are in by definition.
      awaitingReports:
        row.reports_outstanding - (row.unpaid_orders ?? 0) > 0 &&
        isChainStatus(row.current_status) &&
        chainIndex(row.current_status) < chainIndex("sd_pending")
          ? row.reports_outstanding - (row.unpaid_orders ?? 0)
          : 0,
      unpaidTests: row.unpaid_tests || [],
      labOnly,
      // Nothing left for the lab to do. Used to retire a finished patient from
      // the lab track: a sample that was never collected is still worth showing
      // after they leave, a report that is already back is not. Covers both the
      // HealthRay-only path (hrlab has dropped them, no active local record) and
      // Gini Flow's own lab pipeline (all of today's local orders are uploaded).
      labSettled:
        ((row.lab_all_cases ?? 0) > 0 &&
          (row.lab_all_reported ?? 0) >= row.lab_all_cases &&
          !row.lab_sample_status) ||
        locallySettled,
      labTests: row.lab_test_names || [],
      assignedDoctorId: labOnly ? null : row.assigned_doctor_id,
      assignedDoctorName: labOnly ? null : row.doctor_name || row.doctor_full_name || null,
      subtitle: subtitleFor(row),
      hint: heldForTests
        ? row.unpaid_tests?.length
          ? `${row.unpaid_tests.join(", ")} — payment pending at reception`
          : "Waiting for test reports"
        : hintFor(row),
      hintIcon: heldForTests ? (row.unpaid_tests?.length ? "💳" : "🧪") : hintIconFor(row),
      heldForTests,
      finished,
      statusSince: waitSince ? new Date(waitSince).toISOString() : null,
      journeyStartedAt: row.journey_started_at
        ? new Date(row.journey_started_at).toISOString()
        : null,
      statusMinutes,
      statusBudget: budget,
      statusColour: finished ? "green" : budgetColour(statusMinutes ?? 0, budget),
      totalMinutes,
      totalBudget: budgets.total_journey ?? null,
      totalOver: totalMinutes !== null && totalMinutes > (budgets.total_journey ?? Infinity),
      lab: row.lab_sample_status
        ? {
            since: row.lab_since ? new Date(row.lab_since).toISOString() : null,
            sampleStatus: row.lab_sample_status,
            paymentStatus: row.lab_payment_status,
            testCount: row.lab_test_count,
            subtitle: LAB_SUBTITLE[row.lab_sample_status] || row.lab_sample_status,
            minutes: minutesSince(row.lab_since, now),
            budget: budgets.lab_total ?? null,
            colour: budgetColour(minutesSince(row.lab_since, now) ?? 0, budgets.lab_total ?? null),
            hint: LAB_HINT[row.lab_sample_status] || null,
            hintIcon: row.lab_sample_status === "payment_pending" ? "💰" : "📤",
            blocking: row.lab_sample_status === "payment_pending",
            source: "giniflow",
            collected: DRAWN_STATUSES.includes(row.lab_sample_status),
            atLab: DRAWN_STATUSES.includes(row.lab_sample_status),
          }
        : row.hr_lab_cases && !locallySettled
          ? {
              since: row.hr_lab_since ? new Date(row.hr_lab_since).toISOString() : null,
              sampleStatus: row.hr_lab_at_lab
                ? "processing"
                : row.hr_lab_collected
                  ? "sample_collected"
                  : "paid",
              paymentStatus: null,
              testCount: row.hr_lab_tests ?? 0,
              subtitle: row.hr_lab_at_lab
                ? LAB_SUBTITLE.processing
                : row.hr_lab_collected
                  ? LAB_SUBTITLE.sample_collected
                  : "Awaiting collection",
              minutes: minutesSince(row.hr_lab_since, now),
              budget: null,
              colour: "grey",
              hint: row.hr_lab_at_lab || row.hr_lab_collected ? null : LAB_HINT.paid,
              hintIcon: "🧪",
              blocking: false,
              source: "healthray",
              caseCount: row.hr_lab_cases,
              // Drawn and at the analyzer are two different facts. The card said
              // "Left without giving a sample" whenever the lab had not RECEIVED
              // the tube, which is true of every sample drawn in the last hour.
              collected: !!row.hr_lab_all_collected || !!row.hr_lab_at_lab,
              atLab: !!row.hr_lab_at_lab,
            }
          : labOnlyLine
            ? {
                since: row.journey_started_at
                  ? new Date(row.journey_started_at).toISOString()
                  : null,
                // Derived, never assumed. Hardcoding results_ready/atLab:false
                // told the card the patient had left without giving a sample
                // while the row beside it read "Reports ready" — a report
                // cannot exist without a sample.
                sampleStatus: !row.lab_all_cases
                  ? "paid"
                  : (row.lab_all_reported ?? 0) >= row.lab_all_cases
                    ? "results_ready"
                    : "processing",
                paymentStatus: null,
                testCount: (row.lab_test_names || []).length,
                subtitle: labOnlyLine.subtitle,
                minutes: minutesSince(row.journey_started_at, clock),
                budget: null,
                colour: "grey",
                hint: labOnlyLine.hint,
                hintIcon: "🧪",
                blocking: false,
                source: "healthray",
                caseCount: row.lab_all_cases ?? 0,
                // A case that exists is a sample that was given.
                atLab: (row.lab_all_cases ?? 0) > 0,
              }
            : null,
    };
  }

  const onFloor = cards.filter((c) => !OFF_BOARD_STATUSES.includes(c.status));

  // Admin-toggleable (floorSettings.js, /settings/flow): whether samples-only
  // patients show on this board at all. Off by default. When it's back on,
  // this restores exactly where they used to live — the lab track while
  // active, the Done column once exited, reachable for a coordinator to
  // assign a real consultant — not a redesigned version of it.
  const chainAllowsLabOnly = (col) => !hideLabOnly && col.key === "done";
  const shown = hideLabOnly ? onFloor.filter((c) => !c.labOnly) : onFloor;

  const columns = BOARD_COLUMNS.map((col) => {
    const items =
      col.key === "lab"
        ? // A finished patient stays in the lab track only while the lab still
          // holds something of theirs. Once the reports are back and they have
          // gone home there is nothing to work, and leaving them here is what
          // kept an exited patient sitting in the column all day.
          shown.filter(
            (c) =>
              c.placement === "lab" ||
              (!hideLabOnly && c.labOnly && c.lab && !(c.finished && c.labSettled)) ||
              (c.finished && !c.labOnly && c.lab && !c.labSettled),
          )
        : isMachineColumn(col.key)
          ? shown.filter((c) => c.placement === "machine" && c.machine.column === col.key)
          : onFloor.filter(
              (c) =>
                (!c.labOnly || chainAllowsLabOnly(col)) &&
                c.placement === "chain" &&
                col.statuses.includes(c.status),
            );
    const onMachines = isMachineColumn(col.key);
    const machineTimed = onMachines ? items.filter((c) => c.machine.budget) : [];
    const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    const budget = onMachines
      ? machineTimed.length
        ? mean(machineTimed.map((c) => c.machine.budget))
        : null
      : (budgets[col.slaKey] ?? null);
    // Blocked patients are excluded from the average: they are stuck on missing
    // reports, not on this station's throughput, and letting them skew it points
    // the bottleneck banner at the wrong station.
    const timedCards = items.filter((c) => !c.blockedReason && !c.heldForTests);
    const timed = onMachines
      ? machineTimed.map((c) => c.machine.minutes ?? 0)
      : col.key === "lab"
        ? timedCards.filter((c) => c.lab.budget).map((c) => c.lab.minutes ?? 0)
        : timedCards.map((c) => c.statusMinutes ?? 0);
    const avg = mean(timed);
    return {
      ...col,
      budgetMinutes: budget,
      count: items.length,
      avgMinutes: avg,
      hot: col.key !== "done" && !!budget && timed.length > 0 && avg > budget,
      // Sorted here rather than only in the component so every consumer of the
      // board — the day report, a future station screen — sees the same queue
      // the floor manager arranged.
      // The lab track is timed on its own clock against the lab_total budget, so
      // compareQueue's last tiebreak — statusMinutes — would order it by how long
      // the patient has been waiting somewhere else entirely (BQ-04). It keeps
      // the SQL's ordering, as Done does.
      cards:
        col.key === "done" || SIDE_TRACK_COLUMNS.includes(col.key)
          ? items
          : [...items].sort(compareQueue),
    };
  });

  return { cards, onFloor, columns };
}

// Server-side patient search across one day's board. Server-side because the
// floor can hold 100+ patients and the answer must not depend on which cards a
// column happened to have rendered — and because matching a phone number means
// normalising it the same way the rest of the repo does.
//
// Returns visit ids; the board filters itself to them. Scoped to the day, so it
// can never become a back-door patient directory.
export async function searchDayVisits(visitDate, query, db = pool) {
  const raw = String(query || "").trim();
  if (raw.length < 2) return [];

  const digits = toLocal10(raw);
  // A short numeric string is a partial phone or a file number, not a 10-digit
  // mobile — match it as a suffix so "1547" finds P_181547 and ...81547.
  const numeric = raw.replace(/\D/g, "");

  // LIKE patterns are built here rather than concatenated in SQL. Two untyped
  // operands make Postgres resolve `||` to ARRAY concatenation, which fails with
  // "malformed array literal" — and a complete parameter is clearer anyway.
  const like = `%${raw}%`;
  const phoneSuffix = digits.length === 10 ? `%${digits}` : null;
  const numericLike = numeric ? `%${numeric}%` : null;

  const { rows } = await db.query(
    `SELECT v.id, v.current_status, p.name, p.file_no, p.age, p.sex
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND (
          p.name ILIKE $2
          OR p.file_no ILIKE $2
          OR ($3::text IS NOT NULL AND regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE $3)
          OR ($4::text IS NOT NULL AND regexp_replace(COALESCE(p.phone, ''), '\\D', '', 'g') LIKE $4)
          -- alt_phone is text[], not text: a patient may carry several numbers.
          -- Match any element, digits-only, the same way the primary phone is matched.
          OR (
            $4::text IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM unnest(COALESCE(p.alt_phone, ARRAY[]::text[])) AS alt
               WHERE regexp_replace(alt, '\\D', '', 'g') LIKE $4
            )
          )
        )
      ORDER BY p.name
      LIMIT 50`,
    [visitDate, like, phoneSuffix, numericLike],
  );

  return rows.map((r) => ({
    visitId: r.id,
    name: r.name,
    fileNo: r.file_no,
    age: r.age,
    sex: r.sex,
    status: r.current_status,
  }));
}

export function getBottleneck(columns) {
  const candidates = columns
    .filter(
      (c) => c.key !== "done" && c.budgetMinutes && c.count > 0 && c.avgMinutes > c.budgetMinutes,
    )
    .map((c) => ({ column: c, overBy: c.avgMinutes - c.budgetMinutes }))
    .sort((a, b) => b.overBy - a.overBy);

  if (!candidates.length) return null;

  const { column } = candidates[0];
  const onMachines = isMachineColumn(column.key);
  const minutesOf = (c) => (onMachines ? c.machine?.minutes : c.statusMinutes) ?? 0;
  const longest = [
    ...column.cards.filter((c) => !c.blockedReason && (onMachines || !c.heldForTests)),
  ].sort((a, b) => minutesOf(b) - minutesOf(a))[0];

  const greenWaiting =
    column.key === "wait_doctor" &&
    column.cards.filter((c) => c.category === "in_control").length > 0;

  return {
    station: column.key,
    label: column.name,
    count: column.count,
    avgMinutes: column.avgMinutes,
    budgetMinutes: column.budgetMinutes,
    longest: longest ? { id: longest.id, name: longest.name, minutes: minutesOf(longest) } : null,
    suggestion: greenWaiting
      ? "SD closes green-category patients directly."
      : `Add capacity at ${column.name.toLowerCase()} or hold new check-ins.`,
  };
}

export async function getDayStats(visitDate, board, slaConfig, db = pool) {
  const budgets = budgetMap(slaConfig);
  // "of N booked" is the day's expected patients: scheduled appointments that
  // were not cancelled and did not no-show, excluding blocked patients the way
  // every other list in this repo does (GF-10).
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE a.status NOT IN ('cancelled', 'no_show'))::int AS booked,
            COUNT(*) FILTER (WHERE a.status = 'no_show')::int   AS no_show,
            COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled
       FROM appointments a
      WHERE a.appointment_date = $1::date
        AND NOT EXISTS (
              SELECT 1 FROM patients bp WHERE bp.id = a.patient_id AND bp.is_blocked
            )`,
    [visitDate],
  );
  const appts = rows[0] || { booked: 0, no_show: 0, cancelled: 0 };

  // Admin-toggleable (floorSettings.js): while samples-only patients are
  // hidden from the board's columns, these tiles hide them too, so a count
  // here never says "14" while every card on screen adds up to fewer.
  const hideLabOnly = await hideLabOnlyPatients(db);
  const inBuilding = board.onFloor.filter(
    (c) => (!hideLabOnly || !c.labOnly) && !["dispensed", "exited"].includes(c.status),
  );
  const done = board.cards.filter(
    (c) => (!hideLabOnly || !c.labOnly) && ["dispensed", "exited"].includes(c.status),
  );
  const journeys = done
    .filter((c) => !c.labOnly)
    .map((c) => c.totalMinutes)
    .filter((m) => m !== null);
  const avgJourney = journeys.length
    ? Math.round(journeys.reduce((a, b) => a + b, 0) / journeys.length)
    : null;

  // Samples-only patients are excluded: they hold a pre-consultation status
  // judged against the wait-for-SD budget, but they are not in that queue and
  // nobody is going to call them. Counting them made the tile read "7 need
  // attention" while With SD / MO showed 0, three of the seven waiting on
  // nothing. Their lab clock is the one that matters and it is timed separately.
  const overBudget = inBuilding.filter((c) => !c.labOnly && c.statusColour === "red").length;
  const blocked = board.onFloor.filter(
    (c) => !c.labOnly && (c.status === "blocked_reports" || c.blockedReason),
  ).length;
  // GF-21: this counted live cards, not transitions. Measure what the label says
  // — completed station-to-station hops today that finished inside their budget.
  const { rows: hops } = await db.query(
    `SELECT e.status,
            EXTRACT(EPOCH FROM (nxt.occurred_at - e.occurred_at)) / 60 AS minutes
       FROM giniflow_visit_events e
       JOIN giniflow_visits v ON v.id = e.visit_id AND v.visit_date = $1::date
       JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events n
          WHERE n.visit_id = e.visit_id AND n.occurred_at > e.occurred_at
            -- A marker is a fact, not the end of a hop. A report landing while
            -- a patient waited for the MO split one 90-minute wait into a
            -- 5-minute hop scored as within budget plus an untracked remainder.
            AND ${NOT_A_MARKER_SQL("n.status")}
          ORDER BY n.occurred_at LIMIT 1
       ) nxt ON TRUE
      WHERE NOT ${labOnlyPredicate("v", "$2")}
        AND ${NOT_A_MARKER_SQL("e.status")}`,
    [visitDate, LAB_ONLY_DOCTOR],
  );
  const budgeted = hops
    .map((h) => ({ minutes: Number(h.minutes), budget: budgets[slaKeyForStatus(h.status)] }))
    .filter((h) => h.budget);
  const withinSla = budgeted.length
    ? Math.round((budgeted.filter((h) => h.minutes <= h.budget).length / budgeted.length) * 100)
    : null;

  return {
    inBuilding: inBuilding.length,
    booked: appts.booked,
    noShow: appts.no_show,
    cancelled: appts.cancelled,
    completed: done.length,
    avgCompletedMinutes: avgJourney,
    overBudget,
    blocked,
    journeyTargetMinutes: budgets.total_journey ?? null,
    withinSlaPct: withinSla,
    slaTransitions: budgeted.length,
  };
}

// Today's average per station, for the footer strip. Reads closed transitions
// from the log rather than the live cards, so it reflects the whole day.
export async function getStationAverages(visitDate, slaConfig, db = pool) {
  const budgets = budgetMap(slaConfig);
  const { rows } = await db.query(
    `SELECT e.status,
            AVG(EXTRACT(EPOCH FROM (nxt.occurred_at - e.occurred_at)) / 60)::numeric(10,1) AS avg_minutes,
            COUNT(*)::int AS samples
       FROM giniflow_visit_events e
       JOIN giniflow_visits v ON v.id = e.visit_id AND v.visit_date = $1::date
       JOIN LATERAL (
         SELECT occurred_at FROM giniflow_visit_events n
          WHERE n.visit_id = e.visit_id AND n.occurred_at > e.occurred_at
            -- A marker is a fact, not the end of a hop. A report landing while
            -- a patient waited for the MO split one 90-minute wait into a
            -- 5-minute hop scored as within budget plus an untracked remainder.
            AND ${NOT_A_MARKER_SQL("n.status")}
          ORDER BY n.occurred_at LIMIT 1
       ) nxt ON TRUE
      -- Lab-only visits never walk these stations, so their hops must not
      -- define how the stations are performing. On 5 Sep three of the five
      -- closed check-in hops were lab-only, at 0m, 3m and 5m — the gap between
      -- check-in and the sync noticing a HealthRay vitals row, not a queue.
      -- They pulled the check-in average from 105m down to 44m and painted a
      -- badly lagging station green.
      WHERE NOT ${labOnlyPredicate("v", "$2")}
        AND ${NOT_A_MARKER_SQL("e.status")}
      GROUP BY e.status`,
    [visitDate, LAB_ONLY_DOCTOR],
  );

  const byStation = {};
  for (const row of rows) {
    const key = slaKeyForStatus(row.status);
    if (!key) continue;
    byStation[key] = byStation[key] || { minutes: 0, samples: 0 };
    byStation[key].minutes += Number(row.avg_minutes) * row.samples;
    byStation[key].samples += row.samples;
  }

  // Two budgets are not measured by a status dwell time and so never appear in
  // the query above: the lab track lives in its own table, and the journey total
  // spans the whole chain (GF-07).
  const [{ lab_minutes: labMinutes, lab_samples: labSamples }] = (
    await db.query(
      `SELECT AVG(mins)::numeric(10, 1) AS lab_minutes, COUNT(*)::int AS lab_samples
         FROM (
           SELECT EXTRACT(EPOCH FROM (o.uploaded_at - o.created_at)) / 60 AS mins
             FROM giniflow_lab_orders o
             JOIN giniflow_visits v ON v.id = o.visit_id AND v.visit_date = $1::date
            WHERE o.uploaded_at IS NOT NULL AND o.kind = 'lab'
           UNION ALL
           SELECT EXTRACT(
                    EPOCH FROM (
                      (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on')::timestamptz
                      - (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at')::timestamptz
                    )
                  ) / 60 AS mins
             FROM lab_cases lc
            WHERE lc.case_date = $1::date
              AND lc.raw_detail_json->>'reported_on' IS NOT NULL
              AND COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at' IS NOT NULL
         ) t
        WHERE mins >= 0`,
      [visitDate],
    )
  ).rows;

  const [{ journey_minutes: journeyMinutes, journey_samples: journeySamples }] = (
    await db.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (fin.occurred_at - start.occurred_at)) / 60)::numeric(10,1) AS journey_minutes,
              COUNT(*)::int AS journey_samples
         FROM giniflow_visits v
         JOIN LATERAL (
           -- Last check-in, matching the board above: the averages must not
           -- count a break the board already excludes.
           SELECT occurred_at FROM giniflow_visit_events e
            WHERE e.visit_id = v.id AND ${JOURNEY_START_SQL("e.status")}
            ORDER BY occurred_at DESC LIMIT 1
         ) start ON TRUE
         JOIN LATERAL (
           SELECT occurred_at FROM giniflow_visit_events e
            WHERE e.visit_id = v.id AND e.status IN ('exited', 'dispensed')
            ORDER BY occurred_at DESC LIMIT 1
         ) fin ON TRUE
        WHERE v.visit_date = $1::date
          AND NOT ${labOnlyPredicate("v", "$2")}`,
      [visitDate, LAB_ONLY_DOCTOR],
    )
  ).rows;

  if (labSamples)
    byStation.lab_total = { minutes: Number(labMinutes) * labSamples, samples: labSamples };
  if (journeySamples)
    byStation.total_journey = {
      minutes: Number(journeyMinutes) * journeySamples,
      samples: journeySamples,
    };

  return slaConfig.map((s) => {
    const agg = byStation[s.station];
    const actual = agg && agg.samples ? Math.round(agg.minutes / agg.samples) : null;
    return {
      station: s.station,
      label: s.label,
      budgetMinutes: s.budgetMinutes,
      actualMinutes: actual,
      samples: agg?.samples ?? 0,
      colour: actual === null ? "neutral" : budgetColour(actual, s.budgetMinutes),
      fillPct: actual === null ? 0 : Math.min(100, Math.round((actual / s.budgetMinutes) * 100)),
    };
  });
}
