import "../loadEnv.js";
import fs from "node:fs";
import pool from "../config/db.js";
import { fetchPatientTransactions } from "../services/healthray/client.js";
import { transactionsToBilling } from "../services/healthray/billingExtractor.js";
import { mergeBillItems, storedBill, billedLabLines } from "../services/giniflow/patientBill.js";
import { syncMachineOrdersForVisit } from "../services/giniflow/machineSync.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const DAY = arg("date", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
const GAP_MS = Number(arg("gap-ms", 20000));
const CACHE = arg("cache", `/tmp/bill-catchup-${DAY}.json`);
const apply = process.argv.includes("--apply");
const OFF_FLOOR = ["booked", "confirmed", "no_show", "cancelled", "dispensed", "exited"];

const { rows: visits } = await pool.query(
  `SELECT v.id AS visit_id, v.patient_id, v.visit_date::text AS visit_date, v.current_status,
          p.name, p.file_no,
          COALESCE(a.healthray_id, sameday.healthray_id) AS healthray_id,
          COALESCE(a.healthray_patient_id, sameday.healthray_patient_id, prior.healthray_patient_id)
            AS hr_patient_id,
          ARRAY(SELECT s.step_catalog_id FROM giniflow_visit_steps s
                 WHERE s.visit_id = v.id ORDER BY s.step_order) AS steps,
          ARRAY(SELECT DISTINCT t.test_name FROM giniflow_lab_orders o
                  JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
                 WHERE o.visit_id = v.id) AS ordered
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
    WHERE v.visit_date = $1::date AND v.merged_into_visit_id IS NULL
      AND v.current_status <> ALL($2::text[])
    ORDER BY v.created_at`,
  [DAY, OFF_FLOOR],
);

const describe = (billing) =>
  (billing?.items || [])
    .filter((i) => i.category !== "consultation")
    .map((i) => `${i.desc} ₹${i.amount}${i.cancelled || i.refunded ? " (cancelled/refunded)" : ""}`)
    .join(", ") || "consultation only";

const readAll = async () => {
  const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  console.log(
    `${visits.length} visit(s) on the floor on ${DAY}; one bill read every ${GAP_MS / 1000}s`,
  );
  for (const v of visits) {
    if (cache[v.visit_id]) continue;
    if (!v.hr_patient_id) {
      console.log(`- ${v.file_no} ${v.name}: not linked to HealthRay, skipped`);
      continue;
    }
    try {
      const txns = await fetchPatientTransactions(v.hr_patient_id, { slotWaitMs: GAP_MS });
      const billing =
        transactionsToBilling(txns, { appointmentId: v.healthray_id, date: DAY, wholeDay: true })
          ?.billing || null;
      cache[v.visit_id] = { readAt: new Date().toISOString(), billing };
      fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));
      console.log(`- ${v.file_no} ${v.name}: ${billing ? describe(billing) : "no bill yet"}`);
    } catch (e) {
      console.log(`- ${v.file_no} ${v.name}: READ FAILED — ${e.message}`);
      if (e.healthrayBlocked) {
        console.log("HealthRay refused this machine too; stopping.");
        break;
      }
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return cache;
};

const report = (cache) => {
  console.log("\nMissing from the journey:");
  let any = false;
  for (const v of visits) {
    const billing = cache[v.visit_id]?.billing;
    if (!billing) continue;
    const labs = billedLabLines({ items: billing.items }).map((l) => l.name);
    const missingLabs = labs.filter((n) => !v.ordered.includes(n));
    const others = billing.items.filter(
      (i) => !["consultation", "lab"].includes(i.category) && !i.cancelled,
    );
    if (!missingLabs.length && !others.length) continue;
    any = true;
    console.log(
      `- ${v.file_no} ${v.name} [${v.current_status}]` +
        (missingLabs.length ? ` labs not ordered: ${missingLabs.join(", ")}` : "") +
        (others.length ? ` | other billed lines: ${others.map((i) => i.desc).join(", ")}` : ""),
    );
  }
  if (!any) console.log("  nothing");
};

const applyAll = async (cache) => {
  console.log("\nApplying:");
  for (const v of visits) {
    const read = cache[v.visit_id];
    if (!read) continue;
    const stored = await storedBill(v.patient_id, DAY);
    const items = mergeBillItems(stored?.items, read.billing?.items, read.readAt);
    const billed = !!read.billing || stored?.status === "billed";
    await pool.query(
      `INSERT INTO giniflow_patient_bills (patient_id, bill_date, status, items, invoice_no, read_at)
       VALUES ($1, $2::date, $3, $4::jsonb, $5, $6)
       ON CONFLICT (patient_id, bill_date) DO UPDATE
          SET status = EXCLUDED.status, items = EXCLUDED.items,
              invoice_no = EXCLUDED.invoice_no, read_at = EXCLUDED.read_at`,
      [
        v.patient_id,
        DAY,
        billed ? "billed" : "no_bill",
        JSON.stringify(items),
        read.billing?.invoice_no ?? stored?.invoiceNo ?? null,
        read.readAt,
      ],
    );
    if (!billed) continue;
    try {
      const r = await syncMachineOrdersForVisit({ ...v, refundable_open: false });
      await pool.query(`UPDATE giniflow_visits SET machine_scan_at = NOW() WHERE id = $1`, [
        v.visit_id,
      ]);
      console.log(
        `- ${v.file_no} ${v.name}: ${r.raised} order(s) raised, steps added: ${r.labSteps.join(", ") || "none"}` +
          (r.removed?.removedSteps || r.removed?.removedOrders
            ? `, not on bill: ${r.removed.removedOrders} order(s) cancelled, ${r.removed.removedSteps} step(s) skipped`
            : ""),
      );
    } catch (e) {
      console.log(`- ${v.file_no} ${v.name}: SYNC FAILED — ${e.message}`);
    }
  }
};

const cache =
  apply && fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : await readAll();
report(cache);
if (apply) await applyAll(cache);
else
  console.log(`\nRead only. Bills cached in ${CACHE}; re-run with --apply to store them and sync.`);
await pool.end();
