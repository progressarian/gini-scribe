import "../loadEnv.js";
import pool from "../config/db.js";
import { SAMPLE_TAKEN_BEFORE_VISIT_SQL } from "../services/giniflow/journey.js";

const fileNos = process.argv.slice(2);
const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  for (const fileNo of fileNos) {
    const { rows: visits } = await client.query(
      `SELECT v.id, v.visit_date::text, v.current_status, v.created_at,
              ${SAMPLE_TAKEN_BEFORE_VISIT_SQL()} AS sample_taken_before_visit
         FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
        WHERE p.file_no = $1 AND v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [fileNo],
    );
    console.log(`\n=== ${fileNo} ===`);
    console.table(visits);
    for (const v of visits) {
      const { rows: steps } = await client.query(
        `SELECT step_order, step_catalog_id, step_name, status
           FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
        [v.id],
      );
      console.table(steps);
      const { rows: events } = await client.query(
        `SELECT status, to_char(occurred_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS at
           FROM giniflow_visit_events WHERE visit_id = $1 ORDER BY occurred_at`,
        [v.id],
      );
      console.table(events);
    }
    const { rows: cases } = await client.query(
      `SELECT lc.case_no, lc.test_names
         FROM lab_cases lc JOIN patients p ON p.id = lc.patient_id
        WHERE p.file_no = $1 AND lc.case_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [fileNo],
    );
    console.table(cases);
  }
  await client.query("ROLLBACK");
} finally {
  client.release();
  await pool.end();
}
