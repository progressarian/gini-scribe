import "../loadEnv.js";
import pool from "../config/db.js";
import { advanceStatus } from "../services/giniflow/statusEngine.js";

const VISIT_ID = "be4b3ef4-bffb-49cc-ab22-5e13e6527f88";
const ADMIN_ID = 13;
const commit = process.argv.includes("--commit");
const ORDER = [
  "check_in",
  "lab_billing",
  "blood_sample",
  "lab_processing_2",
  "report_upload",
  "vitals",
  "wait_chief",
  "mo_assessment",
  "rx_explain",
  "pharmacy",
];

const show = async (db) => {
  const { rows } = await db.query(
    `SELECT s.step_order, s.step_name, s.status,
            to_char(s.completed_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS at,
            v.current_status
       FROM giniflow_visit_steps s JOIN giniflow_visits v ON v.id = s.visit_id
      WHERE s.visit_id = $1 ORDER BY s.step_order`,
    [VISIT_ID],
  );
  console.log(`status: ${rows[0]?.current_status}`);
  for (const r of rows)
    console.log(`  ${r.step_order}. ${r.step_name} — ${r.status}${r.at ? ` ${r.at}` : ""}`);
};

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: steps } = await client.query(
    `SELECT id, step_catalog_id FROM giniflow_visit_steps WHERE visit_id = $1 FOR UPDATE`,
    [VISIT_ID],
  );
  const ids = ORDER.map((c) => steps.find((s) => s.step_catalog_id === c)?.id);
  if (ids.includes(undefined) || steps.length !== ORDER.length)
    throw new Error("The journey changed since this script was written — stop and recheck");
  await client.query(`SET CONSTRAINTS giniflow_visit_steps_order DEFERRED`);
  for (let i = 0; i < ids.length; i++)
    await client.query(`UPDATE giniflow_visit_steps SET step_order = $2 WHERE id = $1`, [
      ids[i],
      i + 1,
    ]);
  await client.query(
    `UPDATE giniflow_visit_steps lp
        SET started_at = ru.completed_at, completed_at = ru.completed_at
       FROM giniflow_visit_steps ru
      WHERE lp.visit_id = $1 AND lp.step_catalog_id = 'lab_processing_2'
        AND ru.visit_id = $1 AND ru.step_catalog_id = 'report_upload'
        AND ru.completed_at < lp.completed_at`,
    [VISIT_ID],
  );
  const { rows: vitals } = await client.query(
    `SELECT 1 FROM vitals WHERE appointment_id = 114551 AND source = 'healthray'
        AND bp_sys IS NOT NULL AND weight IS NOT NULL`,
  );
  const { rows: now } = await client.query(
    `SELECT current_status FROM giniflow_visits WHERE id = $1`,
    [VISIT_ID],
  );
  if (vitals.length && now[0].current_status === "checked_in")
    await advanceStatus(client, {
      visitId: VISIT_ID,
      toStatus: "sd_pending",
      actorRole: "admin",
      actorId: ADMIN_ID,
      allowSkip: true,
      meta: { reason: "vitals_recorded_in_healthray", after: "checked_in" },
    });
  await show(client);
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
