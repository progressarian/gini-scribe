// Removes the pending Lab Billing / Blood Sample steps a visit picked up from a
// HealthRay case that belongs to the patient's earlier lab-only (Dr. Hospital
// Admin) visit the same day. Rule: caseFromEarlierLabOnlyVisit in testsHold.js.
//
//   node scripts/drop-earlier-labonly-lab-steps.mjs [YYYY-MM-DD]           # dry run
//   node scripts/drop-earlier-labonly-lab-steps.mjs [YYYY-MM-DD] --apply
//
// ⚠️ DATABASE_URL is production.

import "../loadEnv.js";
import pool from "../config/db.js";
import { IST_TODAY } from "../services/giniflow/statusEngine.js";
import { LIVE_LAB_CASE_SQL, caseFromEarlierLabOnlyVisit } from "../services/giniflow/testsHold.js";
import { tidyLabSteps } from "../services/giniflow/testCancel.js";
import { placeTestsBeforeDoctors, syncLabStepsFromLab } from "../services/giniflow/journey.js";

const apply = process.argv.includes("--apply");
const date = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;

const { rows } = await pool.query(
  `SELECT v.id, p.name, p.file_no
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
    WHERE v.visit_date = COALESCE($1::date, ${IST_TODAY})
      AND v.merged_into_visit_id IS NULL
      AND EXISTS (SELECT 1 FROM giniflow_visit_steps s
                   WHERE s.visit_id = v.id AND s.status = 'pending'
                     AND s.step_catalog_id IN ('lab_billing', 'blood_sample'))
      AND NOT EXISTS (SELECT 1 FROM giniflow_lab_orders o
                       WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab')
      AND EXISTS (SELECT 1 FROM lab_cases lc
                   WHERE lc.case_date = v.visit_date AND lc.patient_id = v.patient_id
                     AND ${LIVE_LAB_CASE_SQL("lc")}
                     AND ${caseFromEarlierLabOnlyVisit("v")})`,
  [date],
);

for (const v of rows) {
  console.log(`${apply ? "fixing" : "would fix"}: ${v.name} (${v.file_no})`);
  if (!apply) continue;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [v.id]);
    await tidyLabSteps(client, v.id);
    await syncLabStepsFromLab(client, v.id);
    await placeTestsBeforeDoctors(client, v.id);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`  failed: ${e.message}`);
  } finally {
    client.release();
  }
}
console.log(`${rows.length} visit(s)${apply ? "" : " — dry run, pass --apply to change"}`);
await pool.end();
