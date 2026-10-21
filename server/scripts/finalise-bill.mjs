import "../loadEnv.js";
import pool from "../config/db.js";
import { finaliseBill } from "../services/billing/bills.js";

const billId = process.argv.slice(2).find((a) => !a.startsWith("--"));
const apply = process.argv.includes("--apply");
const actorId = Number(process.argv.find((a) => a.startsWith("--actor="))?.split("=")[1]) || null;
if (!billId || !actorId) {
  console.error("Usage: node scripts/finalise-bill.mjs <bill id> --actor=<staff id> [--apply]");
  process.exit(1);
}

try {
  const { rows: actors } = await pool.query(
    `SELECT id, name, role FROM doctors WHERE id = $1 AND is_active IS NOT FALSE`,
    [actorId],
  );
  if (!actors.length) throw new Error(`No active staff member with id ${actorId}`);

  const { rows: bills } = await pool.query(
    `SELECT b.id, b.status, b.version, b.bill_no, p.name AS patient, p.file_no,
            b.scheme_code AS category
       FROM bills b JOIN patients p ON p.id = b.patient_id
      WHERE b.id = $1`,
    [billId],
  );
  if (!bills.length) throw new Error("No bill with that id");
  console.table(bills);
  const { rows: lines } = await pool.query(
    `SELECT bill_name, patient_payable, is_live FROM bill_lines WHERE bill_id = $1 ORDER BY line_no`,
    [billId],
  );
  console.table(lines);
  if (bills[0].status !== "draft") throw new Error(`Bill is ${bills[0].status}, not a draft`);

  if (!apply) {
    console.log(`Dry run. --apply will finalise it as ${actors[0].name}`);
  } else {
    const done = await finaliseBill(
      billId,
      { version: bills[0].version },
      { actorId: actors[0].id, role: actors[0].role },
    );
    const bill = done.bill ?? done;
    console.log(`Finalised: ${bill.bill_no ?? "(see bill)"} · status ${bill.status ?? "final"}`);
  }
} finally {
  await pool.end();
}
