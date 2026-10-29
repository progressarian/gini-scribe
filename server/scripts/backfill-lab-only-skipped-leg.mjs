import "../loadEnv.js";
import pool from "../config/db.js";
import { labOnlyPredicate } from "../services/giniflow/labOnlyVisits.js";
import { addSkippedLabLeg } from "../services/giniflow/journey.js";
import { LAB_ONLY_DOCTOR } from "../../shared/labOnly.js";

const APPLY = process.argv.includes("--apply");

try {
  const { rows: visits } = await pool.query(
    `SELECT v.id, p.file_no, p.name, v.current_status
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND ${labOnlyPredicate("v", "$1")}
        AND EXISTS (SELECT 1 FROM giniflow_visit_steps s WHERE s.visit_id = v.id)
        AND (NOT EXISTS (SELECT 1 FROM giniflow_visit_steps s
                          WHERE s.visit_id = v.id AND s.step_catalog_id = 'blood_sample')
             OR NOT EXISTS (SELECT 1 FROM giniflow_visit_steps s
                             WHERE s.visit_id = v.id AND s.step_catalog_id = 'lab_processing_2'))
      ORDER BY p.file_no`,
    [LAB_ONLY_DOCTOR],
  );
  console.log(
    `${visits.length} tests-only visit(s) today missing Lab Collection / Lab Processing.`,
  );
  let done = 0;
  for (const v of visits) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { added } = await addSkippedLabLeg(client, v.id);
      await client.query(APPLY ? "COMMIT" : "ROLLBACK");
      done++;
      console.log(
        `${APPLY ? "added" : "would add"} [${added.join(", ") || "nothing"}] as skipped · ${v.file_no} ${v.name} (${v.current_status}) · ${done}/${visits.length}`,
      );
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`Stopped at ${v.file_no}: ${e.message}`);
      process.exitCode = 1;
      break;
    } finally {
      client.release();
    }
  }
  if (!APPLY) console.log("DRY RUN — nothing written. Re-run with --apply.");
} finally {
  await pool.end();
}
