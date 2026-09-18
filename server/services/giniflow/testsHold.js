import { CANCELLABLE_ORDER_STATUSES } from "../../../shared/testCancelReasons.js";
import pool from "../../config/db.js";

export const DOCTOR_LEG_STATUSES = [
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
];

export const LIVE_LAB_CASE_SQL = (lc = "lc") =>
  `(NOT EXISTS (SELECT 1 FROM giniflow_lab_case_actions cx
                 WHERE cx.case_no = ${lc}.case_no AND cx.action = 'cancelled')
    AND lower(COALESCE(${lc}.case_status, ${lc}.raw_list_json->>'case_status', '')) <> 'cancelled')`;

const CASE_STARTED_ACTIONS = [
  "drawing_started",
  "sample_taken",
  "sample_sent",
  "sample_received",
  "processing",
  "results_ready",
  "report_uploaded",
];

export const ORDER_OUTPUT_SQL = (o) => `(
  ${o}.report_file_url IS NOT NULL
  OR EXISTS (SELECT 1 FROM documents d WHERE d.giniflow_lab_order_id = ${o}.id)
  OR EXISTS (SELECT 1 FROM lab_results r WHERE r.lab_order_id = ${o}.id))`;

export const CASE_STARTED_SQL = (lc) => `COALESCE((
  EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
           WHERE a.case_no = ${lc}.case_no
             AND a.action = ANY(ARRAY[${CASE_STARTED_ACTIONS.map((a) => `'${a}'`).join(", ")}]))
  OR ${lc}.raw_list_json->>'phlebotomy_status' = 'Completed'
  OR COALESCE(${lc}.raw_detail_json, ${lc}.raw_list_json)->>'collected_on' IS NOT NULL
  OR COALESCE(${lc}.raw_detail_json, ${lc}.raw_list_json)->>'received_on' IS NOT NULL
  OR COALESCE(${lc}.raw_detail_json, ${lc}.raw_list_json)->>'reported_on' IS NOT NULL
  OR COALESCE(${lc}.results_synced, FALSE)
  OR EXISTS (SELECT 1 FROM lab_results r WHERE r.lab_case_no = ${lc}.case_no)), FALSE)`;

export const ORDER_CANCELLABLE_SQL = (o) =>
  `(${o}.sample_status = ANY(ARRAY[${CANCELLABLE_ORDER_STATUSES.map((s) => `'${s}'`).join(", ")}])
    AND NOT ${ORDER_OUTPUT_SQL(o)})`;

export const CASE_CANCELLABLE_SQL = (lc) =>
  `(${LIVE_LAB_CASE_SQL(lc)} AND NOT ${CASE_STARTED_SQL(lc)})`;

const caseMatches = (v, p) =>
  `lc.case_date = ${v}.visit_date
     AND (lc.patient_id = ${v}.patient_id
          OR (lc.patient_id IS NULL
              AND lc.raw_list_json->'patient'->>'healthray_uid' = ${p}.file_no))`;

const caseDoneAt = `(SELECT min(a.created_at) FROM giniflow_lab_case_actions a
                      WHERE a.case_no = lc.case_no AND a.action = 'report_uploaded')`;

const caseTime = (field) =>
  `(COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'${field}')::timestamptz`;

const visitArrival = (v) =>
  `COALESCE((SELECT min(fe.occurred_at) FROM giniflow_visit_events fe
              WHERE fe.visit_id = ${v}.id), NOW())`;

export const caseReportedBeforeVisit = (v) =>
  `COALESCE(${caseTime("reported_on")} < ${visitArrival(v)}, FALSE)`;

export const caseSampledBeforeVisit = (v) =>
  `COALESCE(LEAST(${caseTime("collected_on")}, ${caseTime("received_on")}, ${caseTime("reported_on")})
            < ${visitArrival(v)}, FALSE)`;

const caseWorkedAsOrder = (v) =>
  `EXISTS (SELECT 1 FROM giniflow_lab_orders lo
            WHERE lo.visit_id = ${v}.id AND lo.urgency = 'today' AND lo.kind = 'lab')`;

export const TESTS_HOLD_SQL = (v = "v", p = "p") => `
  SELECT
    (SELECT count(*)::int FROM giniflow_lab_orders o
      WHERE o.visit_id = ${v}.id AND o.urgency = 'today'
        AND o.sample_status NOT IN ('uploaded', 'reported'))
    + (SELECT count(*)::int FROM lab_cases lc
        WHERE ${caseMatches(v, p)}
          AND NOT ${caseWorkedAsOrder(v)}
          AND NOT ${caseReportedBeforeVisit(v)}
          AND ${LIVE_LAB_CASE_SQL("lc")}
          AND ${caseDoneAt} IS NULL) AS tests_pending,
    GREATEST(
      (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
         JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
        WHERE o.visit_id = ${v}.id AND o.urgency = 'today'
          AND e.track = 'sample' AND e.status IN ('uploaded', 'reported')),
      (SELECT max(${caseDoneAt}) FROM lab_cases lc
        WHERE ${caseMatches(v, p)} AND NOT ${caseWorkedAsOrder(v)}
          AND ${LIVE_LAB_CASE_SQL("lc")})
    ) AS tests_ready_at`;

export const chiefWaitClock = (row) => {
  if (!DOCTOR_LEG_STATUSES.includes(row.current_status)) {
    return { heldForTests: false, since: row.status_since };
  }
  const heldForTests = row.tests_pending > 0;
  const readyLater =
    !heldForTests &&
    row.tests_ready_at &&
    row.status_since &&
    new Date(row.tests_ready_at) > new Date(row.status_since);
  return { heldForTests, since: readyLater ? row.tests_ready_at : row.status_since };
};

export async function getTestsHold(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT h.tests_pending, h.tests_ready_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       CROSS JOIN LATERAL (${TESTS_HOLD_SQL()}) h
      WHERE v.id = $1`,
    [visitId],
  );
  const row = rows[0];
  return {
    pending: row?.tests_pending > 0,
    count: row?.tests_pending ?? 0,
    readyAt: row?.tests_ready_at ? new Date(row.tests_ready_at) : null,
  };
}

export async function testsOpenInScribe(db, visitId) {
  return (await getTestsHold(visitId, db)).count;
}
