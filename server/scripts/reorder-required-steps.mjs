import "../loadEnv.js";
import pool from "../config/db.js";
import { placeTestsBeforeDoctors } from "../services/giniflow/journey.js";

const apply = process.argv.includes("--apply");
const dateArg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const day = dateArg || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const { rows } = await pool.query(
  `SELECT DISTINCT s.visit_id, p.name, need.step_catalog_id AS step, s.step_catalog_id AS required
     FROM giniflow_visit_steps need
     JOIN flow_step_catalog c ON c.id = need.step_catalog_id AND c.machine_requires_before IS NOT NULL
     JOIN giniflow_visit_steps s
       ON s.visit_id = need.visit_id AND s.step_catalog_id = c.machine_requires_before
     JOIN giniflow_visits v ON v.id = need.visit_id
     JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_date = $1::date
      AND need.status = 'pending' AND s.status = 'pending'
      AND s.step_order > need.step_order`,
  [day],
);

console.log(`${day}: ${rows.length} journey(s) with a step before the one it requires`);
for (const r of rows) console.log(`  ${r.name}: ${r.step} is before ${r.required}`);

if (!apply) {
  console.log(rows.length ? "\nDry run — re-run with --apply to reorder." : "");
  await pool.end();
  process.exit(0);
}

let fixed = 0;
for (const visitId of new Set(rows.map((r) => r.visit_id))) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (await placeTestsBeforeDoctors(client, visitId)) fixed++;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`  ${visitId}: ${e.message}`);
  } finally {
    client.release();
  }
}
console.log(`\nReordered ${fixed} journey(s).`);
await pool.end();
