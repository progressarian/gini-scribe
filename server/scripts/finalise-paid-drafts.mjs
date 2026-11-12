import "../loadEnv.js";
import pool from "../config/db.js";
import { finaliseBill } from "../services/billing/bills.js";
import { PAID_DRAFT_SQL } from "../services/billing/labCaseLines.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const apply = process.argv.includes("--apply");
const keepGoing = process.argv.includes("--keep-going");
const actorName = arg("as", "gurjot");
const from = arg("from", null);
const to = arg("to", null);
if (!from || !to) throw new Error("Pass --from=YYYY-MM-DD --to=YYYY-MM-DD");

const { rows: actors } = await pool.query(
  `SELECT id, name, role FROM doctors WHERE name ILIKE $1 AND is_active IS NOT FALSE ORDER BY id`,
  [`%${actorName}%`],
);
if (actors.length !== 1) {
  console.log("Need exactly one user for --as:", actors);
  await pool.end();
  process.exit(1);
}
const actor = actors[0];
const ctx = { actorId: actor.id, ip: null, role: actor.role };

const { rows: bills } = await pool.query(
  `SELECT b.id, b.version, b.bill_date::text AS bill_date, b.patient_payable, b.paid_amount,
          p.name AS patient, p.file_no
     FROM bills b JOIN patients p ON p.id = b.patient_id
    WHERE ${PAID_DRAFT_SQL("b")} AND b.bill_type = 'invoice'
      AND b.bill_date BETWEEN $1 AND $2
    ORDER BY b.bill_date, p.name, b.id`,
  [from, to],
);
const total = bills.reduce((sum, b) => sum + Number(b.patient_payable), 0);
console.log(
  `${apply ? "APPLY" : "DRY RUN"} as ${actor.name} (#${actor.id}) — ${bills.length} bills, ₹${total}`,
);

let done = 0;
let failed = 0;
for (const bill of bills) {
  const label = `${bill.bill_date}  ${bill.patient} · ${bill.file_no}  ₹${bill.patient_payable}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const made = await finaliseBill(bill.id, { version: bill.version }, ctx, client);
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    done += 1;
    console.log(`  ok   ${label}  -> ${made.bill_no}${apply ? "" : " (rolled back)"}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    failed += 1;
    console.log(`  FAIL ${label}  — ${error.message}`);
    if (apply && !keepGoing) break;
  } finally {
    client.release();
  }
}
console.log(`${done} finalised${apply ? "" : " (dry run)"}, ${failed} failed`);
await pool.end();
