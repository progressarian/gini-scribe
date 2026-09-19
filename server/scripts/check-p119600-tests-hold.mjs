import "../loadEnv.js";
import pool from "../config/db.js";
import { TESTS_HOLD_SQL, LIVE_LAB_CASE_SQL } from "../services/giniflow/testsHold.js";
import { syncBillingForVisitId } from "../services/giniflow/machineSync.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILE_NO = args[0] || "P_119600";
const DAY = args[1] || "2026-09-19";
const readBill = process.argv.includes("--read-bill");

const { rows: visits } = await pool.query(
  `SELECT v.id, v.current_status, p.id AS patient_id, p.name, h.tests_pending
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
     CROSS JOIN LATERAL (${TESTS_HOLD_SQL("v", "p")}) h
    WHERE p.file_no = $1 AND v.visit_date = $2::date`,
  [FILE_NO, DAY],
);
console.table(visits);
const visit = visits[0];
if (!visit) process.exit(1);
if (readBill) console.log("bill read:", await syncBillingForVisitId(visit.id));

const { rows: cases } = await pool.query(
  `SELECT lc.case_no, lc.case_status, lc.test_names,
          COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'registered_at' AS registered_at,
          COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' AS reported_on,
          ${LIVE_LAB_CASE_SQL("lc")} AS counts_as_live
     FROM lab_cases lc
    WHERE lc.case_date = $2::date AND lc.patient_id = $1`,
  [visit.patient_id, DAY],
);
console.table(cases);

const { rows: bills } = await pool.query(
  `SELECT status, invoice_no, read_at, items FROM giniflow_patient_bills
    WHERE patient_id = $1 AND bill_date = $2::date`,
  [visit.patient_id, DAY],
);
for (const b of bills) {
  console.log({ status: b.status, invoice: b.invoice_no, readAt: b.read_at });
  console.table(
    (b.items || []).map((i) => ({
      desc: i.desc,
      category: i.category,
      amount: i.amount,
      cancelled: !!i.cancelled,
      removed: !!i.removed,
    })),
  );
}
if (!bills.length) console.log("No bill stored yet for this day");
await pool.end();
