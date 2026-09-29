import "../loadEnv.js";
import pool from "../config/db.js";
import { deleteDraft } from "../services/billing/bills.js";

const apply = process.argv.includes("--apply");
const { rows } = await pool.query(
  `SELECT b.id, b.visit_id, b.bill_type, b.created_at,
          (SELECT count(*) FROM bill_lines l WHERE l.bill_id = b.id)::int AS lines
     FROM bills b WHERE b.status = 'draft' ORDER BY b.created_at`,
);
console.log(`${rows.length} draft bill(s)`);
for (const bill of rows) console.log(bill.id, bill.visit_id, bill.bill_type, bill.lines, bill.created_at);
if (apply) {
  for (const bill of rows) {
    try {
      const result = await deleteDraft(bill.id, { reason: "Cleared all draft bills on request" }, {});
      console.log("deleted", bill.id, result.removed.length, "lines,", result.released, "released");
    } catch (err) {
      console.log("skipped", bill.id, err.status ?? "", err.message);
    }
  }
}
await pool.end();
