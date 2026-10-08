import "../loadEnv.js";
import pool from "../config/db.js";

const fileNo = process.argv[2];
const date = process.argv[3];
if (!fileNo || !date) {
  console.error("usage: node scripts/diag-vitals-step.mjs <file_no> <YYYY-MM-DD>");
  process.exit(1);
}

const IST = (col) => `to_char(${col} AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH12:MI:SS am')`;
const NAME = (d) => `COALESCE(NULLIF(TRIM(${d}.short_name), ''), ${d}.name)`;

const client = await pool.connect();
try {
  await client.query("BEGIN READ ONLY");
  const show = async (label, sql, params) =>
    console.log(label, JSON.stringify((await client.query(sql, params)).rows, null, 1));

  const visit = (
    await client.query(
      `SELECT v.id FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
        WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
      [fileNo, date],
    )
  ).rows[0];
  if (!visit) throw new Error("No Gini Flow visit for that file no and date");

  await show(
    "vitals step",
    `SELECT step_name, status, assigned_staff_name,
            ${IST("started_at")} AS started_ist, ${IST("completed_at")} AS completed_ist
       FROM giniflow_visit_steps WHERE visit_id = $1 AND step_catalog_id = 'vitals'`,
    [visit.id],
  );
  await show(
    "vitals readings",
    `SELECT ${IST("g.recorded_at")} AS recorded_ist, ${NAME("d")} AS recorded_by, d.role,
            g.source, g.weight, g.height, g.bp_sys, g.bp_dia, g.pulse, g.spo2, g.temp
       FROM giniflow_vitals g LEFT JOIN doctors d ON d.id = g.recorded_by
      WHERE g.visit_id = $1 ORDER BY g.recorded_at`,
    [visit.id],
  );
  await show(
    "visit events",
    `SELECT ${IST("e.occurred_at")} AS at_ist, e.status, e.actor_role, ${NAME("d")} AS actor,
            e.meta
       FROM giniflow_visit_events e LEFT JOIN doctors d ON d.id = e.actor_id
      WHERE e.visit_id = $1 ORDER BY e.occurred_at`,
    [visit.id],
  );
  await client.query("ROLLBACK");
} catch (e) {
  await client.query("ROLLBACK");
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
