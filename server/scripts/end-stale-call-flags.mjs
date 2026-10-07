import "../loadEnv.js";
import fs from "node:fs";
import path from "node:path";
import pool from "../config/db.js";

const APPLY = process.argv.includes("--apply");
const TTL = "10 minutes";

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const flags = await client.query(
    `SELECT id, patient_id, calling_by, calling_by_id, calling_since
       FROM appointments
      WHERE calling_since IS NOT NULL
        AND calling_since <= NOW() - INTERVAL '${TTL}'
      FOR UPDATE`,
  );
  const sessions = await client.query(
    `SELECT id, appointment_id, started_at, ended_at, duration_secs
       FROM call_claim_sessions
      WHERE ended_reason = 'expired'
        AND duration_secs > EXTRACT(EPOCH FROM INTERVAL '${TTL}')::int
      FOR UPDATE`,
  );

  const byCaller = {};
  for (const f of flags.rows)
    byCaller[f.calling_by || "?"] = (byCaller[f.calling_by || "?"] || 0) + 1;
  console.log(`Open call flags older than ${TTL}: ${flags.rows.length}`, byCaller);
  console.log(`Expired call sessions longer than ${TTL}: ${sessions.rows.length}`);

  if (!APPLY) {
    await client.query("ROLLBACK");
    console.log("Dry run — nothing changed. Re-run with --apply.");
  } else {
    const backupDir =
      process.argv.find((a) => a.startsWith("--backup-dir="))?.split("=")[1] || process.cwd();
    const backup = path.resolve(
      backupDir,
      `end-stale-call-flags-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    fs.writeFileSync(
      backup,
      JSON.stringify({ flags: flags.rows, sessions: sessions.rows }, null, 1),
    );
    console.log(`Backup written: ${backup}`);

    const ended = await client.query(
      `WITH ended AS (
         UPDATE appointments a
            SET calling_by = NULL, calling_by_id = NULL, calling_since = NULL
           FROM (SELECT id, patient_id, calling_by, calling_by_id, calling_since
                   FROM appointments WHERE id = ANY($1::int[])) old
          WHERE a.id = old.id
         RETURNING old.*
       )
       INSERT INTO call_claim_sessions
         (appointment_id, patient_id, called_by, called_by_id, started_at, ended_at,
          duration_secs, ended_reason)
       SELECT id, patient_id, calling_by, calling_by_id, calling_since,
              calling_since + INTERVAL '${TTL}',
              EXTRACT(EPOCH FROM INTERVAL '${TTL}')::int, 'expired'
         FROM ended`,
      [flags.rows.map((f) => f.id)],
    );
    const capped = await client.query(
      `UPDATE call_claim_sessions
          SET ended_at = started_at + INTERVAL '${TTL}',
              duration_secs = EXTRACT(EPOCH FROM INTERVAL '${TTL}')::int
        WHERE id = ANY($1::int[])`,
      [sessions.rows.map((s) => s.id)],
    );
    await client.query("COMMIT");
    console.log(`Ended ${ended.rowCount} flags, capped ${capped.rowCount} sessions.`);
  }
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
  await pool.end();
}
