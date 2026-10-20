import "../loadEnv.js";
import pool from "../config/db.js";
import { finaliseBill } from "../services/billing/bills.js";
const COMMIT = process.argv.includes("--commit");
const BILL = "f720ef6c-06e8-4027-a871-f9bb1f65a67e";
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows } = await client.query(`SELECT status, version, patient_id FROM bills WHERE id = $1 FOR UPDATE`, [BILL]);
  console.log("before:", rows[0]);
  if (rows[0].status !== "draft" || rows[0].patient_id !== 53544) throw new Error("bill is not the expected draft");
  const out = await finaliseBill(BILL, { version: rows[0].version }, { role: "admin", actorId: 13 }, client);
  const { rows: after } = await client.query(`SELECT bill_no, status, patient_payable, paid_amount, consultant_id FROM bills WHERE id = $1`, [BILL]);
  console.log("after:", after[0]);
  await client.query(COMMIT ? "COMMIT" : "ROLLBACK");
  console.log(COMMIT ? "COMMITTED" : "DRY RUN — rolled back");
} catch (e) {
  await client.query("ROLLBACK");
  console.error("FAILED, rolled back:", e.status ?? "", e.message);
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
