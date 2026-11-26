import "../loadEnv.js";
import pool from "../config/db.js";
import { markDraftSaved } from "../services/billing/draftSaves.js";

const BILL_ID = "028cb66f-20b8-49e5-9a65-b9dc5b3308f2";
const commit = process.argv.includes("--commit");

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(
    `SELECT id, status, saved_at, patient_payable, paid_amount,
            (SELECT string_agg(bill_name, ', ') FROM bill_lines WHERE bill_id = $1 AND is_live) AS lines
       FROM bills WHERE id = $1 FOR UPDATE`,
    [BILL_ID],
  );
  console.table(rows);
  if (rows[0]?.status !== "draft" || rows[0].saved_at)
    throw new Error("Not an unsaved draft — stopping");
  await markDraftSaved(client, BILL_ID, { actorId: null });
  const { rows: after } = await client.query(
    `SELECT id, status, saved_at, jsonb_array_length(saved_snapshot->'lines') AS snapshot_lines FROM bills WHERE id = $1`,
    [BILL_ID],
  );
  console.table(after);
  await client.query(commit ? "COMMIT" : "ROLLBACK");
  console.log(commit ? "COMMITTED" : "DRY RUN — rolled back");
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("Stopped:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
