import "../loadEnv.js";
import pool from "../config/db.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";

const APPLY = process.argv.includes("--apply");

const DUPLICATE_VISIT = "56a17fac-a872-4012-9f32-ed1e0967c9d1";
const REAL_VISIT = "8f02f788-a041-40ee-894c-4c4e193b53d0";
const REAL_PATIENT = 52760;
const REPORTED_FUNDUS_ORDER = "9c4b7754-a0b7-4383-bd60-4924957e0e46";
const FUNDUS_REPORT_DOC = 95048;
const REAL_FUNDUS_STEP = "c0d7fdae-52fa-4510-a170-36ed83da0e0b";

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const { rows: undone } = await client.query(
    `SELECT id FROM giniflow_lab_orders
      WHERE visit_id = $1 AND kind = 'machine' AND id <> $2
        AND sample_status NOT IN ('uploaded', 'reported')
        AND EXISTS (SELECT 1 FROM giniflow_lab_order_tests t
                     WHERE t.lab_order_id = giniflow_lab_orders.id AND t.test_name = 'Fundus')`,
    [REAL_VISIT, REPORTED_FUNDUS_ORDER],
  );
  if (undone.length !== 1)
    throw new Error(`expected one undone Fundus on the real visit, found ${undone.length}`);
  const undoneFundus = undone[0].id;

  const { rows: times } = await client.query(
    `SELECT min(occurred_at) FILTER (WHERE status = 'in_progress') AS started,
            max(occurred_at) FILTER (WHERE status = 'reported') AS reported
       FROM giniflow_lab_order_events WHERE lab_order_id = $1 AND track = 'sample'`,
    [REPORTED_FUNDUS_ORDER],
  );

  await client.query(
    `UPDATE giniflow_lab_orders SET visit_id = $1, updated_at = NOW() WHERE id = $2 AND visit_id = $3`,
    [REAL_VISIT, REPORTED_FUNDUS_ORDER, DUPLICATE_VISIT],
  );
  await client.query(
    `UPDATE giniflow_lab_orders SET visit_id = $1, updated_at = NOW() WHERE id = $2`,
    [DUPLICATE_VISIT, undoneFundus],
  );
  await client.query(`UPDATE documents SET patient_id = $1 WHERE id = $2`, [
    REAL_PATIENT,
    FUNDUS_REPORT_DOC,
  ]);
  await client.query(
    `UPDATE giniflow_visit_steps
        SET status = 'done', started_at = COALESCE(started_at, $2), completed_at = COALESCE(completed_at, $3)
      WHERE id = $1 AND visit_id = $4`,
    [REAL_FUNDUS_STEP, times[0].started, times[0].reported, REAL_VISIT],
  );

  await advanceStatus(client, {
    visitId: DUPLICATE_VISIT,
    toStatus: "cancelled",
    actorRole: "system",
    allowSkip: true,
    meta: {
      source: "remove-duplicate-visit-kulwant-2026-09-17",
      reason:
        "duplicate patient record GNI-00070 for P_181777; ABI/VPT were template tests not on the bill",
      merged_into_visit: REAL_VISIT,
      fundus_order_moved: REPORTED_FUNDUS_ORDER,
      duplicate_fundus_order_parked: undoneFundus,
    },
  });
  await client.query(
    `UPDATE giniflow_visits SET merged_into_visit_id = $2, updated_at = NOW() WHERE id = $1`,
    [DUPLICATE_VISIT, REAL_VISIT],
  );

  const { rows: after } = await client.query(
    `SELECT v.id, v.current_status, v.merged_into_visit_id,
            (SELECT array_agg(t.test_name || ':' || o.sample_status ORDER BY t.test_name)
               FROM giniflow_lab_orders o JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
              WHERE o.visit_id = v.id) AS tests,
            (SELECT status FROM giniflow_visit_steps s WHERE s.visit_id = v.id AND s.step_catalog_id = 'fundus') AS fundus_step
       FROM giniflow_visits v WHERE v.id = ANY($1)`,
    [[DUPLICATE_VISIT, REAL_VISIT]],
  );
  console.table(after);
  const doc = await client.query(`SELECT id, patient_id FROM documents WHERE id = $1`, [
    FUNDUS_REPORT_DOC,
  ]);
  console.log("report now on patient", doc.rows[0].patient_id);

  await client.query(APPLY ? "COMMIT" : "ROLLBACK");
  console.log(APPLY ? "APPLIED" : "DRY RUN — rolled back. Re-run with --apply.");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("failed, nothing written:", e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
