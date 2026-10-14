import { TEST_MATCHES_SQL } from "./testMatch.js";
import { VISIT_LAB_CASE_TESTS_SQL } from "./visitLabCases.js";

const CONSULT_STARTED = [
  "with_doctor",
  "doctor_done",
  "rx_pending",
  "with_rx",
  "pharmacy_pending",
  "dispensed",
  "exited",
  "back_for_tests",
];

export const CONSULT_STARTED_AT_SQL = (visitId) =>
  `(SELECT min(ce.occurred_at) FROM giniflow_visit_events ce
     WHERE ce.visit_id = ${visitId}
       AND ce.status IN (${CONSULT_STARTED.map((status) => `'${status}'`).join(", ")}))`;

export const ORDERED_AFTER_CONSULT_SQL = (visitId, orderedAt) =>
  `COALESCE(${CONSULT_STARTED_AT_SQL(visitId)} <= ${orderedAt}, FALSE)`;

export const LINE_ORDERED_AT_SQL = ({ line, visit, catalog, matches }) => `
  CASE WHEN ${line}.lab_order_id IS NOT NULL
       THEN (SELECT lo.created_at FROM giniflow_lab_orders lo WHERE lo.id = ${line}.lab_order_id)
       ELSE COALESCE(
         (SELECT min(vc.registered_at)
            FROM (${VISIT_LAB_CASE_TESTS_SQL(visit)}) vc
            JOIN ${matches} vm ON vm.test_name = vc.test_name
           WHERE vm.catalog_id = ${catalog}),
         CASE WHEN ${line}.source = 'lab_case' THEN NULL ELSE ${line}.created_at END)
  END`;

const TESTS_AFTER_CONSULT_SQL = `
  WITH v AS (
    SELECT gv.id, gv.patient_id, gv.visit_date, gv.appointment_id, p.file_no
      FROM bills b
      JOIN giniflow_visits gv ON gv.id = b.visit_id
      JOIN patients p ON p.id = gv.patient_id
     WHERE b.id = $1),
  started AS (SELECT ${CONSULT_STARTED_AT_SQL("v.id")} AS at FROM v),
  case_matches AS MATERIALIZED (
    ${TEST_MATCHES_SQL(`ARRAY(SELECT x.test_name FROM v CROSS JOIN LATERAL (${VISIT_LAB_CASE_TESTS_SQL("v")}) x)`)}),
  timed AS (
    SELECT l.id,
           ${LINE_ORDERED_AT_SQL({ line: "l", visit: "v", catalog: "i.test_catalog_id", matches: "case_matches" })}
             AS ordered_at,
           COALESCE(orderer.name, adder.name) AS ordered_by_name
      FROM bill_lines l
      CROSS JOIN v
      JOIN service_items i ON i.id = l.service_item_id
      LEFT JOIN giniflow_lab_orders o ON o.id = l.lab_order_id
      LEFT JOIN doctors orderer ON orderer.id = o.ordered_by
      LEFT JOIN doctors adder ON adder.id = l.created_by
     WHERE l.bill_id = $1 AND l.is_live AND i.kind = 'test')
  SELECT t.id, t.ordered_at, t.ordered_by_name
    FROM timed t CROSS JOIN started s
   WHERE s.at IS NOT NULL AND t.ordered_at >= s.at`;

export async function testsAfterConsult(client, billId) {
  const { rows } = await client.query(TESTS_AFTER_CONSULT_SQL, [billId]);
  return new Map(
    rows.map((row) => [
      row.id,
      { ordered_at: row.ordered_at, ordered_by_name: row.ordered_by_name },
    ]),
  );
}
