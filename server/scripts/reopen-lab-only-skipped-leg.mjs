import "../loadEnv.js";
import pool from "../config/db.js";
import { labOnlyPredicate } from "../services/giniflow/labOnlyVisits.js";
import { SAMPLE_TAKEN_BEFORE_VISIT_SQL } from "../services/giniflow/journey.js";
import { LIVE_LAB_CASE_SQL } from "../services/giniflow/testsHold.js";
import { LAB_ONLY_DOCTOR } from "../../shared/labOnly.js";
import { TERMINAL_STATUSES } from "../../shared/giniflowStatus.js";

const APPLY = process.argv.includes("--apply");
const LEG = ["blood_sample", "lab_processing_2"];

try {
  const { rows: visits } = await pool.query(
    `SELECT v.id, p.file_no, p.name, v.current_status,
            array_agg(s.step_catalog_id ORDER BY s.step_order) AS skipped
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       JOIN giniflow_visit_steps s
         ON s.visit_id = v.id AND s.status = 'skipped' AND s.step_catalog_id = ANY($2::text[])
      WHERE v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND v.current_status <> ALL($3::text[])
        AND v.current_status NOT IN ('no_show', 'cancelled', 'left')
        AND ${labOnlyPredicate("v", "$1")}
        AND v.lab_site IS DISTINCT FROM 'home'
        AND NOT ${SAMPLE_TAKEN_BEFORE_VISIT_SQL()}
        AND (EXISTS (SELECT 1 FROM giniflow_lab_orders o
                      WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab'
                        AND o.sample_status <> 'cancelled')
             OR EXISTS (SELECT 1 FROM lab_cases lc
                         WHERE lc.case_date = v.visit_date
                           AND (lc.patient_id = v.patient_id
                                OR (lc.patient_id IS NULL
                                    AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
                           AND ${LIVE_LAB_CASE_SQL("lc")}))
      GROUP BY v.id, p.file_no, p.name, v.current_status
      ORDER BY p.file_no`,
    [LAB_ONLY_DOCTOR, LEG, TERMINAL_STATUSES],
  );
  console.log(`${visits.length} tests-only visit(s) on the floor with lab steps wrongly skipped.`);
  let done = 0;
  for (const v of visits) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE giniflow_visit_steps SET status = 'pending'
          WHERE visit_id = $1 AND status = 'skipped' AND step_catalog_id = ANY($2::text[])`,
        [v.id, LEG],
      );
      await client.query(APPLY ? "COMMIT" : "ROLLBACK");
      done++;
      console.log(
        `${APPLY ? "reopened" : "would reopen"} ${rowCount} step(s) [${v.skipped.join(", ")}] · ${v.file_no} ${v.name} (${v.current_status}) · ${done}/${visits.length}`,
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
