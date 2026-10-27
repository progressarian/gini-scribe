import "../loadEnv.js";
import pool from "../config/db.js";
import { billSuppressor } from "../services/giniflow/testCancel.js";
import { storedBill, billedMachineLines } from "../services/giniflow/patientBill.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import { syncBillingForVisitId } from "../services/giniflow/machineSync.js";

const VISIT_ID = "4d2bee70-42f0-4a44-a57d-0984252bf493";
const PATIENT_ID = 54009;
const ADMIN_ID = 13;
const commit = process.argv.includes("--commit");

const RESTORE_SQL = `
  UPDATE giniflow_test_cancellations
     SET restored_at = clock_timestamp(), restored_by = $2, restored_role = 'admin'
   WHERE visit_id = $1 AND kind = 'machine' AND reason = 'billed_by_mistake'
     AND bill_line IS NULL AND restored_at IS NULL
  RETURNING test_name`;

const machinesFree = async (db, lines) => {
  const skip = await billSuppressor(db, VISIT_ID);
  return lines.flatMap((l) =>
    l.machines.filter((m) => !skip({ kind: "machine", machineId: m, line: l.line })),
  );
};

const orders = async () =>
  (
    await pool.query(
      `SELECT o.payment_status, string_agg(t.test_name, ', ') AS tests
         FROM giniflow_lab_orders o JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
        WHERE o.visit_id = $1 GROUP BY o.id ORDER BY o.created_at`,
      [VISIT_ID],
    )
  ).rows;

const steps = async () =>
  (
    await pool.query(
      `SELECT step_name, status FROM giniflow_visit_steps WHERE visit_id = $1 ORDER BY step_order`,
      [VISIT_ID],
    )
  ).rows.map((s) => `${s.step_name} — ${s.status}`);

const bill = await storedBill(
  PATIENT_ID,
  (await pool.query(`SELECT visit_date::text AS d FROM giniflow_visits WHERE id = $1`, [VISIT_ID]))
    .rows[0].d,
);
const lines = billedMachineLines(bill, await getMachines(pool));
console.log(
  "HealthRay machine lines:",
  lines.map((l) => `${l.name} (${l.line.invoice}) → ${l.machines.join(", ")}`),
);
console.log("not blocked before:", await machinesFree(pool, lines));

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const restored = (await client.query(RESTORE_SQL, [VISIT_ID, ADMIN_ID])).rows;
  console.log(
    "cancels restored:",
    restored.map((r) => r.test_name),
  );
  console.log("not blocked after:", await machinesFree(client, lines));
  await client.query(commit ? "COMMIT" : "ROLLBACK");
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(e.message);
  process.exitCode = 1;
} finally {
  client.release();
}

if (commit && !process.exitCode) {
  const result = await syncBillingForVisitId(VISIT_ID, pool);
  console.log("sync:", { raised: result.raised, blocked: !!result.blocked });
  console.log("orders:", await orders());
  console.log("steps:", await steps());
  console.log(
    "committed — reception now clears ABI, VPT, Fundus on the Payments tab (paid in HealthRay OPD/2627-17530)",
  );
} else if (!process.exitCode) {
  console.log("dry run — rolled back (pass --commit to restore and run the sync)");
}
await pool.end();
