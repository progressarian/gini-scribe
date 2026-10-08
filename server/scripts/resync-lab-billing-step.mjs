import "../loadEnv.js";
import pool from "../config/db.js";

await import("../services/giniflow/board.js");
const { syncLabStepsFromLab } = await import("../services/giniflow/journey.js");

const fileNo = process.argv[2];
const date = process.argv[3];
if (!fileNo || !date) {
  console.error("usage: node scripts/resync-lab-billing-step.mjs <file_no> <YYYY-MM-DD>");
  process.exit(1);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT v.id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
    [fileNo, date],
  );
  if (rows.length !== 1) throw new Error(`Expected one visit, found ${rows.length}`);
  console.log(await syncLabStepsFromLab(client, rows[0].id));
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
