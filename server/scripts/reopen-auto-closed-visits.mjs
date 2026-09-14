import "../loadEnv.js";
import pool from "../config/db.js";
import { returnToQueue } from "../services/giniflow/statusEngine.js";

const apply = process.argv.includes("--apply");

const LAB_ONLY_NEVER_CHECKED_IN = [
  "P_10060",
  "P_102610",
  "P_118860",
  "P_129280",
  "P_175844",
  "P_176735",
  "P_177036",
  "P_179052",
  "P_179470",
  "P_181685",
  "P_181722",
  "P_181732",
  "P_82450",
];

const plan = [
  ["P_181092", "no_show", "checked_in", "healthray_no_show_after_checkin"],
  ["P_70170", "no_show", "checked_in", "healthray_no_show_after_checkin"],
  ["P_181113", "exited", "checked_in", "lab_only_auto_exit"],
  ...LAB_ONLY_NEVER_CHECKED_IN.map((f) => [f, "exited", "booked", "lab_only_auto_exit"]),
];

for (const [fileNo, expect, to, reason] of plan) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT v.id, v.current_status FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
        WHERE p.file_no = $1 AND v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        FOR UPDATE OF v`,
      [fileNo],
    );
    if (rows.length !== 1 || rows[0].current_status !== expect) {
      await client.query("ROLLBACK");
      console.log(fileNo, "skipped — now", rows[0]?.current_status);
      continue;
    }
    if (!apply) {
      await client.query("ROLLBACK");
      console.log(fileNo, expect, "→", to, "(dry run)");
      continue;
    }
    await returnToQueue(client, {
      visitId: rows[0].id,
      toStatus: to,
      actorRole: "system",
      meta: { reopened: reason, from: expect },
    });
    await client.query("COMMIT");
    console.log(fileNo, expect, "→", to);
  } catch (e) {
    await client.query("ROLLBACK");
    console.log(fileNo, "error", e.message);
  } finally {
    client.release();
  }
}
await pool.end();
