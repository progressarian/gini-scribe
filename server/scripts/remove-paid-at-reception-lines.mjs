import "../loadEnv.js";
import pool from "../config/db.js";
import { ORDER_STATE } from "../../shared/billingVocab.js";
import { removeLine } from "../services/billing/bills.js";
import { orderStatesOn } from "../services/billing/payments.js";

const APPLY = process.argv.includes("--apply");
const REASON = "Paid at reception";
const EXTRA = [
  {
    file_no: "P_176605",
    bill_name: "PHOSPHORUS",
    why: "lab-report copy of PHOSPHOROUS paid at reception",
  },
];

const { rows: drafts } = await pool.query(
  `SELECT b.id, p.file_no, p.name FROM bills b JOIN patients p ON p.id = b.patient_id
    WHERE b.status = 'draft' AND b.bill_type = 'invoice' AND b.visit_id IS NOT NULL
    ORDER BY p.file_no`,
);
const todo = [];
for (const bill of drafts) {
  const states = await orderStatesOn(pool, bill.id);
  const { rows: lines } = await pool.query(
    `SELECT id, bill_name FROM bill_lines WHERE bill_id = $1 AND is_live`,
    [bill.id],
  );
  for (const line of lines) {
    const paid = states.get(line.id) === ORDER_STATE.PAID_AT_RECEPTION;
    const extra = EXTRA.find((e) => e.file_no === bill.file_no && e.bill_name === line.bill_name);
    if (paid || extra) todo.push({ bill, line, why: extra?.why ?? "paid at reception" });
  }
}
console.log(`${todo.length} line(s) on ${new Set(todo.map((t) => t.bill.id)).size} draft(s):`);
for (const { bill, line, why } of todo)
  console.log(`  ${bill.file_no} ${bill.name} — ${line.bill_name} (${why})`);
if (APPLY) {
  let done = 0;
  for (const { bill, line } of todo) {
    try {
      await removeLine(bill.id, line.id, { reason: REASON }, { actorId: null, role: "admin" });
      done += 1;
    } catch (error) {
      console.log("  SKIPPED", bill.file_no, line.bill_name, "—", error.message);
    }
  }
  console.log(`removed ${done} of ${todo.length}`);
}
await pool.end();
