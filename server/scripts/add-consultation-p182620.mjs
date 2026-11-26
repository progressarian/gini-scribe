import "../loadEnv.js";
import pool from "../config/db.js";
import { consultationForDesk } from "../services/billing/visitLines.js";

const VISIT_ID = "ccf620ca-5e9e-4c85-bbe2-e0b6ad3a4b68";
const commit = process.argv.includes("--commit");

const linesOf = (client) =>
  client.query(
    `SELECT b.bill_no, b.status, l.line_no, l.source, l.bill_name, l.patient_payable
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live
      ORDER BY b.created_at, l.line_no`,
    [VISIT_ID],
  );

const client = await pool.connect();
try {
  await client.query("BEGIN");
  console.table((await linesOf(client)).rows);
  const result = await consultationForDesk(VISIT_ID, { actorId: null }, client);
  console.log("result", result);
  if (!result.ok || !result.added?.length) throw new Error("Nothing added — stopping");
  const { rows: draft } = await client.query(
    `SELECT id, status, actual_amount, patient_payable, paid_amount
       FROM bills WHERE id = $1`,
    [result.bill_id],
  );
  console.table((await linesOf(client)).rows);
  console.table(draft);
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
