import "../loadEnv.js";
import pool from "../config/db.js";
import { arriveForAppointmentIn, defaultPlan } from "../services/giniflow/journey.js";
import { keepsForChoice } from "../../shared/directConsult.js";

const ADMIN_ID = 13;
const commit = process.argv.includes("--commit");
const visitIds = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const describe = async (client, visitId) => {
  const { rows } = await client.query(
    `SELECT p.file_no, p.name, v.current_status, v.planned_total_min,
            (SELECT name FROM doctors d WHERE d.id = v.assigned_doctor_id) AS doctor,
            array(SELECT s.step_order || '. ' || s.step_name || ' — ' || s.status
                    FROM giniflow_visit_steps s WHERE s.visit_id = v.id ORDER BY s.step_order) AS steps
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`,
    [visitId],
  );
  return rows[0];
};

const planFor = async (client, visitId) => {
  const { rows } = await client.query(
    `SELECT v.visit_type_id,
            COALESCE((SELECT d.chief_step FROM doctors d WHERE d.id = v.assigned_doctor_id), FALSE)
              AS chief_step
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId],
  );
  const { visit_type_id: visitTypeId, chief_step: chiefStep } = rows[0];
  const steps = (await defaultPlan(visitTypeId, client))
    .filter((s) => s.included && keepsForChoice(s, chiefStep ? "chief" : "consultant"))
    .map(({ catalogId, name, minutes, station, role }) => ({
      catalogId,
      name,
      minutes,
      station,
      role,
    }));
  return { visitTypeId, steps };
};

if (!visitIds.length) {
  console.error("usage: node scripts/arrive-lab-only-for-appointment.mjs <visitId>... [--commit]");
  process.exit(1);
}

for (const visitId of visitIds) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await describe(client, visitId);
    const { visitTypeId, steps } = await planFor(client, visitId);
    const result = await arriveForAppointmentIn(client, visitId, {
      visitTypeId,
      steps,
      actorId: ADMIN_ID,
      actorRole: "admin",
    });
    const after = await describe(client, visitId);
    console.log(
      `\n${before.file_no} ${before.name}: ${before.current_status} → ${after.current_status}`,
    );
    console.log(
      `  ${after.doctor} · ${before.planned_total_min}m → ${after.planned_total_min}m · +${result.added} stops`,
    );
    for (const line of after.steps) console.log(`  ${line}`);
    await client.query(commit ? "COMMIT" : "ROLLBACK");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`\n${visitId}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
}
console.log(commit ? "\ncommitted" : "\ndry run — rolled back (pass --commit to write)");
await pool.end();
