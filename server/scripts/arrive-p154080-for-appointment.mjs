import "../loadEnv.js";
import pool from "../config/db.js";
import { arriveForAppointmentIn, defaultPlan } from "../services/giniflow/journey.js";
import { keepsForChoice } from "../../shared/directConsult.js";

const VISIT_ID = "79e3c86d-00fb-4659-ab50-7595a96494e7";
const VISIT_TYPE = "FU_APPT_TESTS";
const ADMIN_ID = 13;
const commit = process.argv.includes("--commit");

const stepsOf = async (client) =>
  (
    await client.query(
      `SELECT step_order, step_name, status FROM giniflow_visit_steps
        WHERE visit_id = $1 ORDER BY step_order`,
      [VISIT_ID],
    )
  ).rows.map((s) => `${s.step_order}. ${s.step_name} — ${s.status}`);

const visitOf = async (client) =>
  (
    await client.query(
      `SELECT v.current_status, v.planned_total_min,
              (SELECT name FROM doctors d WHERE d.id = v.assigned_doctor_id) AS doctor
         FROM giniflow_visits v WHERE v.id = $1`,
      [VISIT_ID],
    )
  ).rows[0];

const client = await pool.connect();
try {
  await client.query("BEGIN");
  console.log("before", await visitOf(client), await stepsOf(client));
  const plan = (await defaultPlan(VISIT_TYPE, client))
    .filter((s) => s.included && keepsForChoice(s, "chief"))
    .map(({ catalogId, name, minutes, station, role }) => ({
      catalogId,
      name,
      minutes,
      station,
      role,
    }));
  const result = await arriveForAppointmentIn(client, VISIT_ID, {
    visitTypeId: VISIT_TYPE,
    steps: plan,
    actorId: ADMIN_ID,
    actorRole: "admin",
  });
  console.log("added", result.added, "stops");
  console.log("after", await visitOf(client), await stepsOf(client));
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
