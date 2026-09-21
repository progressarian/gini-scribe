import "../loadEnv.js";
import pool from "../config/db.js";
import { fetchPatientTransactions } from "../services/healthray/client.js";
import { transactionsToBilling } from "../services/healthray/billingExtractor.js";
import { readPatientBill } from "../services/giniflow/patientBill.js";
import { syncMachineOrdersForVisit } from "../services/giniflow/machineSync.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const [date, ...fileNos] = args;
const apply = process.argv.includes("--apply");
if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !fileNos.length) {
  console.error(
    "Usage: node scripts/refresh-patient-bills.mjs <YYYY-MM-DD> <file_no>... [--apply]",
  );
  process.exit(1);
}

const visitFor = async (fileNo) => {
  const { rows } = await pool.query(
    `SELECT v.id AS visit_id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
            p.name, p.file_no,
            COALESCE(a.healthray_id, sameday.healthray_id) AS healthray_id,
            COALESCE(a.healthray_patient_id, sameday.healthray_patient_id,
                     prior.healthray_patient_id) AS hr_patient_id
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
       LEFT JOIN LATERAL (
         SELECT healthray_id, healthray_patient_id FROM appointments
          WHERE patient_id = v.patient_id AND appointment_date = v.visit_date
            AND healthray_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
       ) sameday ON TRUE
       LEFT JOIN LATERAL (
         SELECT healthray_patient_id FROM appointments
          WHERE patient_id = v.patient_id AND healthray_patient_id IS NOT NULL
          ORDER BY appointment_date DESC LIMIT 1
       ) prior ON TRUE
      WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
    [fileNo, date],
  );
  return rows;
};

const testSummary = async (visitId) => {
  const { rows: steps } = await pool.query(
    `SELECT string_agg(s.step_catalog_id || ':' || s.status, ', ' ORDER BY s.step_order) AS s
       FROM giniflow_visit_steps s LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
      WHERE s.visit_id = $1
        AND (s.step_catalog_id IN ('lab_billing', 'blood_sample', 'lab_processing_2')
             OR COALESCE(c.machine, FALSE))`,
    [visitId],
  );
  const { rows: orders } = await pool.query(
    `SELECT o.kind, o.payment_status,
            (SELECT string_agg(t.test_name, ', ') FROM giniflow_lab_order_tests t
              WHERE t.lab_order_id = o.id) AS tests
       FROM giniflow_lab_orders o WHERE o.visit_id = $1 ORDER BY o.created_at`,
    [visitId],
  );
  return {
    steps: steps[0].s || "none",
    orders: orders.map((o) => `${o.kind} ${o.payment_status}: ${o.tests}`),
  };
};

for (const fileNo of fileNos) {
  const visits = await visitFor(fileNo);
  if (visits.length !== 1) {
    console.log(`${fileNo}: expected one visit on ${date}, found ${visits.length}; skipped`);
    continue;
  }
  const visit = visits[0];
  console.log(`\n=== ${fileNo} ${visit.name} [${visit.current_status}]`);
  if (!visit.hr_patient_id) {
    console.log("  not linked to HealthRay; skipped");
    continue;
  }
  console.log("  before:", JSON.stringify(await testSummary(visit.visit_id)));

  if (!apply) {
    const txns = await fetchPatientTransactions(visit.hr_patient_id, { slotWaitMs: 20000 });
    const billing = transactionsToBilling(txns, {
      appointmentId: visit.healthray_id,
      date,
      wholeDay: true,
    })?.billing;
    for (const i of billing?.items || [])
      console.log(
        `  bill ${i.invoice} [${i.category}] ${i.desc} ₹${i.amount}${i.cancelled ? " CANCELLED" : ""}`,
      );
    if (!billing) console.log("  no HealthRay bill for this day yet");
    continue;
  }

  const bill = await readPatientBill(
    {
      patientId: visit.patient_id,
      hrPatientId: visit.hr_patient_id,
      healthrayId: visit.healthray_id,
      date,
    },
    pool,
    { maxAgeMin: 0, noBillMaxAgeMin: 0, slotWaitMs: 20000 },
  );
  console.log(`  bill read: ${bill.status}, ${bill.items?.length || 0} line(s)`);
  if (bill.status !== "billed") continue;
  const r = await syncMachineOrdersForVisit({ ...visit, refundable_open: false }, pool);
  await pool.query(`UPDATE giniflow_visits SET machine_scan_at = NOW() WHERE id = $1`, [
    visit.visit_id,
  ]);
  console.log(`  sync: ${r.raised} order(s) raised`);
  console.log("  after:", JSON.stringify(await testSummary(visit.visit_id)));
}
if (!apply) console.log("\nPreview only. Re-run with --apply to store the bills and sync.");
await pool.end();
