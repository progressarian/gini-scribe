import "../loadEnv.js";
import pool from "../config/db.js";

const apply = process.argv.includes("--apply");
const BATCH = 100;
const PAUSE_MS = 500;

const STILL_NEW = `appointment_is_new_type(a.visit_type)
  AND a.patient_id IS NOT NULL AND a.appointment_date IS NOT NULL
  AND appointment_patient_came_before(a.patient_id, a.appointment_date)`;

const { rows: summary } = await pool.query(
  `SELECT COALESCE(NULLIF(btrim(a.visit_type), ''), '(blank)') AS visit_type,
          CASE WHEN a.appointment_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
               THEN 'today or later' ELSE 'past' END AS period,
          COUNT(*)::int AS bookings
     FROM appointments a
    WHERE ${STILL_NEW}
    GROUP BY 1, 2 ORDER BY 2, 3 DESC`,
);
const total = summary.reduce((n, r) => n + r.bookings, 0);
console.log(
  `${apply ? "APPLY" : "DRY RUN"}: ${total} booking(s) typed New for a patient who came before`,
);
console.table(summary);

if (apply) {
  let done = 0;
  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE appointments SET visit_type = 'Follow-Up', updated_at = NOW()
          WHERE id IN (SELECT a.id FROM appointments a WHERE ${STILL_NEW} ORDER BY a.id LIMIT ${BATCH})`,
      );
      await client.query("COMMIT");
      client.release();
      if (!rowCount) break;
      done += rowCount;
      console.log(`  ${done}/${total} done`);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      console.error(`stopped after ${done}:`, error.message);
      await pool.end();
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }
  console.log({ updated: done });
}

await pool.end();
