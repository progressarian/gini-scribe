import pool from "../../config/db.js";

export const DOCTOR_LEG_STATUSES = [
  "vitals_done",
  "sd_pending",
  "with_sd",
  "ready_for_doctor",
  "with_doctor",
];

const caseMatches = (v, p) =>
  `lc.case_date = ${v}.visit_date
     AND (lc.patient_id = ${v}.patient_id
          OR (lc.patient_id IS NULL
              AND lc.raw_list_json->'patient'->>'healthray_uid' = ${p}.file_no))`;

const caseDoneAt = `(SELECT min(a.created_at) FROM giniflow_lab_case_actions a
                      WHERE a.case_no = lc.case_no AND a.action = 'report_uploaded')`;

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
          AND ${caseDoneAt} IS NULL) AS tests_pending,
    GREATEST(
      (SELECT max(e.occurred_at) FROM giniflow_lab_order_events e
         JOIN giniflow_lab_orders o ON o.id = e.lab_order_id
        WHERE o.visit_id = ${v}.id AND o.urgency = 'today'
          AND e.track = 'sample' AND e.status IN ('uploaded', 'reported')),
      (SELECT max(${caseDoneAt}) FROM lab_cases lc
        WHERE ${caseMatches(v, p)} AND NOT ${caseWorkedAsOrder(v)})
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
