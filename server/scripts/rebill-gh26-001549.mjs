import "../loadEnv.js";
import pool from "../config/db.js";
import { rebillFinalBill } from "../services/billing/rebill.js";

const APPLY = process.argv.includes("--apply");
const BILL_NO = "GH26-001549";
const DUPLICATE = "Ca15.3-Breast Cancer Marker";
const REASON =
  "Corrected to match HealthRay OPD/2627-19218: duplicate CA 15.3 line removed, Homa-B/Homa-IR not charged, HMCOL10 not applied to outsourced tests";
const rs = (paise) => (paise / 100).toFixed(2);

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: gurjot } = await client.query(
    `SELECT id, role FROM doctors WHERE id = 11 AND name = 'Gurjot' AND is_active`,
  );
  if (!gurjot.length) throw new Error("Gurjot (id 11) not found or inactive");
  const ctx = { actorId: 11, role: gurjot[0].role, ip: null };
  const { rows: bills } = await client.query(`SELECT id FROM bills WHERE bill_no = $1`, [BILL_NO]);
  const { rows: duplicate } = await client.query(
    `SELECT id FROM bill_lines
      WHERE bill_id = $1 AND is_live AND source = 'lab_case' AND bill_name = $2`,
    [bills[0].id, DUPLICATE],
  );
  if (duplicate.length !== 1) throw new Error("Duplicate line not found exactly once");

  const result = await rebillFinalBill(
    bills[0].id,
    { reason: REASON, drop_line_ids: [duplicate[0].id] },
    ctx,
    client,
  );
  const bill = result.bill;
  console.log(
    `credit note ${result.credit_note_no}: ₹${rs(result.refunded)} paid back in HealthRay`,
  );
  console.log(`new bill ${bill.bill_no} (${bill.status}), ${bill.lines.length} lines`);
  console.table(
    bill.lines.map((l) => ({
      test: l.bill_name,
      rate: rs(l.rate),
      discount: rs(l.discount),
      pays: rs(l.patient_payable),
    })),
  );
  const { rows: paid } = await client.query(
    `SELECT mode, amount FROM payments WHERE bill_id = $1 AND direction = 'in'`,
    [bill.id],
  );
  console.log({
    total: rs(bill.totals.payable ?? bill.totals.patient_payable),
    discount: rs(bill.totals.discount),
    paid: paid.map((p) => `${p.mode} ₹${p.amount}`).join(", "),
  });

  if (APPLY) {
    await client.query("COMMIT");
    console.log("COMMITTED");
  } else {
    await client.query("ROLLBACK");
    console.log("DRY RUN — rolled back, nothing saved. Pass --apply to write.");
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("ROLLED BACK:", error.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
