import "../loadEnv.js";
import pool from "../config/db.js";
import "../services/giniflow/board.js";
import { LAB_ONLY_DOCTOR, labOnlyPredicate } from "../services/giniflow/labOnlyVisits.js";
import { CONSULT_STATUSES } from "../../shared/labOnly.js";

const apply = process.argv.includes("--apply");
const days = 7;

const client = await pool.connect();
try {
  await client.query(apply ? "BEGIN" : "BEGIN READ ONLY");
  const { rows } = await client.query(
    `SELECT s.id, s.visit_id, v.visit_date, p.file_no, p.name, s.step_order, s.step_name, s.status
       FROM giniflow_visit_steps s
       JOIN giniflow_visits v ON v.id = s.visit_id
       JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - $3::int
        AND s.source = 'template'
        AND (s.chain_status = ANY($2::text[])
             OR s.step_catalog_id = 'billing'
             OR (s.step_catalog_id = 'lab_billing'
                 AND EXISTS (SELECT 1 FROM giniflow_visit_steps a
                              WHERE a.visit_id = s.visit_id AND a.id <> s.id
                                AND a.step_catalog_id = 'lab_billing' AND a.source = 'auto')))
        AND ${labOnlyPredicate("v", "$1")}
      ORDER BY v.visit_date, p.file_no, s.step_order`,
    [LAB_ONLY_DOCTOR, CONSULT_STATUSES, days],
  );
  console.table(rows.map(({ id, visit_id, ...r }) => r));
  const visits = new Set(rows.map((r) => `${r.visit_date} ${r.file_no}`)).size;
  console.log(`${rows.length} steps to remove on ${visits} lab-only visits`);
  if (!apply || !rows.length) {
    await client.query("ROLLBACK");
    console.log(apply ? "Nothing to remove." : "Dry run, nothing written. Re-run with --apply.");
  } else {
    const { rowCount } = await client.query(
      `DELETE FROM giniflow_visit_steps WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.id)],
    );
    await client.query(
      `UPDATE giniflow_visit_steps SET step_order = -step_order WHERE visit_id = ANY($1::uuid[])`,
      [[...new Set(rows.map((r) => r.visit_id))]],
    );
    await client.query(
      `UPDATE giniflow_visit_steps s SET step_order = o.n
         FROM (SELECT id, row_number() OVER (PARTITION BY visit_id ORDER BY -step_order) AS n
                 FROM giniflow_visit_steps WHERE visit_id = ANY($1::uuid[])) o
        WHERE s.id = o.id`,
      [[...new Set(rows.map((r) => r.visit_id))]],
    );
    await client.query("COMMIT");
    console.log(`Removed ${rowCount} steps.`);
  }
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
