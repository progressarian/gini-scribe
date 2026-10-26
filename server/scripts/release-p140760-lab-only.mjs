import "../loadEnv.js";
import pool from "../config/db.js";
import { followRebookingToLabOnly } from "../services/giniflow/labOnlyVisits.js";

const VISIT_ID = "27643150-ac4d-4e25-8f8b-492c6ca01ce8";
const APPOINTMENT_ID = 113670;
const BOOKED_DOCTOR = "Dr. Anil Bhansali";
const commit = process.argv.includes("--commit");

const snapshot = async (client) => {
  const { rows: visit } = await client.query(
    `SELECT v.current_status, v.assigned_doctor_id, v.appointment_time::text, v.planned_total_min,
            (SELECT name FROM doctors d WHERE d.id = v.assigned_doctor_id) AS doctor
       FROM giniflow_visits v WHERE v.id = $1`,
    [VISIT_ID],
  );
  const { rows: steps } = await client.query(
    `SELECT step_order, step_name, status FROM giniflow_visit_steps
      WHERE visit_id = $1 ORDER BY step_order`,
    [VISIT_ID],
  );
  return { visit: visit[0], steps };
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  console.log("before", JSON.stringify(await snapshot(client), null, 1));
  const released = await followRebookingToLabOnly(client, {
    appointmentId: APPOINTMENT_ID,
    previousDoctor: BOOKED_DOCTOR,
  });
  if (!released) throw new Error("Visit no longer matches — nothing changed");
  console.log("after", JSON.stringify(await snapshot(client), null, 1));
  await client.query(commit ? "COMMIT" : "ROLLBACK");
  console.log(commit ? "committed" : "dry run — rolled back (pass --commit to write)");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
