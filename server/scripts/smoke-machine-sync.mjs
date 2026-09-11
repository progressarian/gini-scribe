import "../loadEnv.js";
import pool from "../config/db.js";
import { fetchPatientTransactions } from "../services/healthray/client.js";
import { runMachineSync } from "../services/giniflow/machineSync.js";
import { machineCaseListOnly, machineShowsHealthrayReports } from "../../shared/manualFloor.js";
import { getMachineQueue, getMachineReconciliation } from "../services/giniflow/machineStation.js";
import { machineForTest } from "../../shared/machineStages.js";

const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const apply = process.argv.includes("--apply");

const line = (s) => console.log(s);

line(`Machine case list: ${machineCaseListOnly() ? "ON" : "OFF"}`);
line(`HealthRay reports shown: ${machineShowsHealthrayReports() ? "YES" : "NO"}`);
line("");

const { rows: targets } = await pool.query(
  `SELECT v.id, p.name, a.healthray_id,
          COALESCE(a.healthray_patient_id, prior.healthray_patient_id) AS hr_patient_id
     FROM giniflow_visits v
     JOIN patients p ON p.id = v.patient_id
     LEFT JOIN appointments a ON a.id = v.appointment_id
     LEFT JOIN LATERAL (
       SELECT a2.healthray_patient_id FROM appointments a2
        WHERE a2.patient_id = v.patient_id AND a2.healthray_patient_id IS NOT NULL
        ORDER BY a2.appointment_date DESC LIMIT 1
     ) prior ON TRUE
    WHERE v.visit_date = $1::date AND a.healthray_id IS NOT NULL
    ORDER BY v.created_at`,
  [date],
);
const reachable = targets.filter((t) => t.hr_patient_id);
line(`${date}: ${targets.length} visits, ${reachable.length} with a HealthRay patient id`);

if (!apply) {
  let found = 0;
  for (const t of reachable.slice(0, Number(process.env.SMOKE_LIMIT || 8))) {
    const txns = await fetchPatientTransactions(t.hr_patient_id);
    const items = (txns || [])
      .filter((x) => String(x.appointment_id) === String(t.healthray_id))
      .flatMap((x) => x.billing_items || [])
      .filter((b) => /machine/i.test(b.category_type || b.charge_category || ""));
    for (const b of items) {
      found++;
      const ids = String(b.name)
        .split(/[,/+&]/)
        .map((n) => machineForTest(n.trim())?.id || `UNMATCHED(${n.trim()})`);
      line(`  ${t.name}: ${b.category_type} | ${b.name} | Rs ${b.net_price ?? b.price} -> ${ids.join(", ")}`);
    }
  }
  line(`\nDRY RUN — ${found} machine line(s) seen. Re-run with --apply to raise orders.`);
} else {
  const r = await runMachineSync(date, { limit: Number(process.env.SMOKE_LIMIT || 200) });
  line(`\nscanned ${r.scanned}, raised ${r.raised}, failed ${r.failed}`);
}

const queue = await getMachineQueue(date);
line(`\nQueue now: ${queue.total} order(s)`);
for (const m of queue.machines || []) {
  line(`  ${m.name}: ${m.busy ? "BUSY" : "free"} · ${m.ahead ?? 0} waiting`);
}
for (const bucket of ["ordered", "in_progress", "done", "reported"]) {
  for (const row of queue[bucket] || []) {
    line(`  [${bucket}] ${row.name} · ${row.machine || "?"} · ${row.blockedReason || "ACTIONABLE"}`);
  }
}
const recon = await getMachineReconciliation(date);
line(`Reconciliation rows: ${recon.length} (expected 0 while the case list is on)`);

process.exit(0);
