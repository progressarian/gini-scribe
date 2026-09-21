import "../loadEnv.js";
import pool from "../config/db.js";
import { readPatientBill, billedLabLines, storedBill } from "../services/giniflow/patientBill.js";
import { syncBillingForVisitId } from "../services/giniflow/machineSync.js";

const FILE_NO = "P_128670";
const DAY = "2026-09-21";
const apply = process.argv.includes("--apply");

const { rows: visits } = await pool.query(
  `SELECT v.id, v.current_status, v.machine_scan_at, p.name, p.id AS patient_id,
          COALESCE(a.healthray_patient_id, sameday.healthray_patient_id) AS hr_patient_id,
          COALESCE(a.healthray_id, sameday.healthray_id) AS healthray_id
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
     LEFT JOIN appointments a ON a.id = v.appointment_id
     LEFT JOIN LATERAL (
       SELECT healthray_id, healthray_patient_id FROM appointments
        WHERE patient_id = v.patient_id AND appointment_date = v.visit_date
          AND healthray_patient_id IS NOT NULL
        ORDER BY id DESC LIMIT 1
     ) sameday ON TRUE
    WHERE p.file_no = $1 AND v.visit_date = $2::date AND v.merged_into_visit_id IS NULL`,
  [FILE_NO, DAY],
);
if (visits.length !== 1) {
  console.error(`Expected one visit for ${FILE_NO} on ${DAY}, found ${visits.length}`);
  process.exit(1);
}
const visit = visits[0];

const showState = async (label) => {
  const { rows: steps } = await pool.query(
    `SELECT step_order, step_catalog_id, step_name, status, source
       FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
    [visit.id],
  );
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.kind, o.payment_status, o.amount_total,
            array_agg(t.test_name ORDER BY t.test_name) AS tests
       FROM giniflow_lab_orders o
       LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1
      GROUP BY o.id ORDER BY o.id`,
    [visit.id],
  );
  const bill = await storedBill(visit.patient_id, DAY);
  console.log(`\n=== ${label}`);
  console.log(
    `Stored bill: ${bill ? `${bill.status}, read ${bill.readAt}, ${bill.items.length} line(s)` : "none"}`,
  );
  for (const i of bill?.items || []) console.log(`  [${i.category}] ${i.desc} ₹${i.amount}`);
  console.log("Steps:");
  for (const s of steps)
    console.log(`  ${s.step_order}. ${s.step_catalog_id} — ${s.status} (${s.source})`);
  console.log("Orders:");
  if (!orders.length) console.log("  none");
  for (const o of orders)
    console.log(
      `  #${o.id} ${o.kind} ${o.payment_status} ₹${o.amount_total}: ${o.tests.join(", ")}`,
    );
};

console.log(
  `${visit.name} (${FILE_NO}) visit ${visit.id}, status ${visit.current_status}, HealthRay patient ${visit.hr_patient_id || "not linked"}`,
);
await showState("Before");

if (!apply) {
  console.log(
    "\nDry run. Re-run with --apply to re-read the HealthRay bill and add the billed tests.",
  );
  await pool.end();
  process.exit(0);
}
if (["booked", "confirmed", "no_show", "cancelled"].includes(visit.current_status)) {
  console.error(
    `Visit is ${visit.current_status}, not on the floor. Check the patient in first; nothing changed.`,
  );
  await pool.end();
  process.exit(1);
}
if (!visit.hr_patient_id) {
  console.error("No HealthRay patient id on this visit; cannot read the bill.");
  process.exit(1);
}

const bill = await readPatientBill(
  {
    patientId: visit.patient_id,
    hrPatientId: visit.hr_patient_id,
    healthrayId: visit.healthray_id,
    date: DAY,
  },
  pool,
  { maxAgeMin: 0, noBillMaxAgeMin: 0, slotWaitMs: 30000 },
);
console.log(
  `\nFresh bill read: ${bill.status}${bill.deferred ? " (deferred: bill slot busy)" : ""}`,
);
const labLines = billedLabLines(bill);
console.log(`Lab lines on bill: ${labLines.map((l) => l.name).join(", ") || "none"}`);
if (bill.status !== "billed" || !labLines.length) {
  console.error("Bill not read as billed with lab lines; nothing changed. Try again in a minute.");
  await pool.end();
  process.exit(1);
}

const result = await syncBillingForVisitId(visit.id);
console.log(
  `Sync: ${result.raised} order(s) raised, steps added: ${(result.labSteps || []).join(", ") || "none"}${result.blocked ? " (bill reads blocked)" : ""}`,
);
await showState("After");
await pool.end();
