import "../loadEnv.js";
import pool from "../config/db.js";
import { deleteDraft } from "../services/billing/bills.js";

const BILL_ID = "72956ca0-ef4f-4359-a7db-53c9ed8ffc63";
const apply = process.argv.includes("--apply");

try {
  const { rows } = await pool.query(
    `SELECT b.status, b.patient_payable, b.paid_amount, p.file_no,
            (SELECT count(*)::int FROM bill_lines l WHERE l.bill_id = b.id) AS lines
       FROM bills b JOIN patients p ON p.id = b.patient_id WHERE b.id = $1`,
    [BILL_ID],
  );
  const bill = rows[0];
  console.log(bill || "bill not found");
  if (
    !bill ||
    bill.file_no !== "GNI-00120" ||
    bill.status !== "draft" ||
    bill.lines !== 0 ||
    Number(bill.paid_amount) !== 0
  ) {
    throw new Error("Not the empty GNI-00120 draft; nothing changed");
  }
  if (!apply) {
    console.log("Dry run. Re-run with --apply to delete this empty draft.");
  } else {
    await deleteDraft(
      BILL_ID,
      { reason: "Empty draft on duplicate chart GNI-00120 (same patient as P_182105)" },
      { actorId: null, actorRole: "system" },
    );
    console.log(
      "Deleted. Now: node scripts/fix-obt-shell-duplicates.mjs GNI-00120=P_182105 --allow-phone-mismatch --apply",
    );
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
