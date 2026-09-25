import { LIVE_LAB_CASE_SQL } from "./testsHold.js";
import { syncLabStepsFromLab } from "./journey.js";
import { isSameLabTest } from "../billing/testNames.js";

const FOLLOWS_CASE_FROM = ["paid", "sample_collected"];

async function casesForVisit(client, visitId) {
  const { rows: visit } = await client.query(
    `SELECT v.patient_id, v.visit_date::text AS visit_date, p.file_no
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (!visit.length) return [];
  const { patient_id: patientId, visit_date: visitDate, file_no: fileNo } = visit[0];
  const { rows } = await client.query(
    `SELECT lc.case_no, lc.test_names,
            COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' AS reported_on
       FROM lab_cases lc
      WHERE lc.case_date = $1::date
        AND (lc.patient_id = $2
             OR (lc.patient_id IS NULL
                 AND lc.raw_list_json->'patient'->>'healthray_uid' = $3))
        AND ${LIVE_LAB_CASE_SQL("lc")}`,
    [visitDate, patientId, fileNo],
  );
  return rows;
}

async function moveOrder(client, visitId, order, to, caseNos) {
  await client.query(
    `UPDATE giniflow_lab_orders
        SET sample_status = $2,
            uploaded_at = CASE WHEN $2 = 'uploaded' THEN NOW() ELSE uploaded_at END,
            updated_at = NOW()
      WHERE id = $1`,
    [order.id, to],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
     VALUES ($1, 'sample', $2, 'system', NULL)`,
    [order.id, to],
  );
  await client.query(`UPDATE giniflow_lab_order_tests SET status = $2 WHERE lab_order_id = $1`, [
    order.id,
    to,
  ]);
  if (to !== "uploaded") return;
  await client.query(
    `UPDATE giniflow_visits v
        SET results_status = CASE
              WHEN EXISTS (
                SELECT 1 FROM giniflow_lab_orders o2
                 WHERE o2.visit_id = v.id AND o2.urgency = 'today' AND o2.id <> $2
                   AND o2.sample_status NOT IN ('uploaded', 'reported', 'cancelled')
              ) THEN 'partial'
              ELSE 'ready' END,
            updated_at = NOW()
      WHERE v.id = $1`,
    [visitId, order.id],
  );
  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, meta)
     VALUES ($1, 'results_received', 'system', NULL, $2)`,
    [visitId, { source: "healthray_case", lab_order_id: order.id, cases: caseNos }],
  );
}

export async function followHealthrayCases(client, visitId) {
  const { rows: orders } = await client.query(
    `SELECT o.id, o.sample_status, array_agg(t.test_name) AS tests
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'lab' AND o.urgency = 'today'
        AND o.ordered_by IS NULL
        AND o.payment_status IN ('paid', 'claim_approved')
        AND o.sample_status = ANY($2::text[])
      GROUP BY o.id`,
    [visitId, FOLLOWS_CASE_FROM],
  );
  if (!orders.length) return { collected: 0, reported: 0 };
  const cases = await casesForVisit(client, visitId);
  let collected = 0;
  let reported = 0;
  for (const order of orders) {
    const covering = order.tests.map((test) =>
      cases.find((c) => (c.test_names || []).some((name) => isSameLabTest(name, test))),
    );
    if (covering.some((c) => !c)) continue;
    const caseNos = [...new Set(covering.map((c) => c.case_no))];
    if (covering.every((c) => c.reported_on)) {
      await moveOrder(client, visitId, order, "uploaded", caseNos);
      reported++;
    } else if (order.sample_status === "paid") {
      await moveOrder(client, visitId, order, "sample_collected", caseNos);
      collected++;
    }
  }
  if (collected || reported) await syncLabStepsFromLab(client, visitId);
  return { collected, reported };
}
