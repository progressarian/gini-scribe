import "../loadEnv.js";
import pool from "../config/db.js";
import { getMachines } from "../services/giniflow/machineCatalog.js";
import { machineFor } from "../../shared/machineStages.js";
import { insertMachineStepsForOrders } from "../services/giniflow/journey.js";
import { clearPayment } from "../services/giniflow/receptionStation.js";

const FILE_NO = "P_181774";
const BILL_NO = "OPD/2627-14183";
const BILLED_AMOUNT = 1100;
const UNWANTED = ["abi", "vpt", "fundus"];
const apply = process.argv.includes("--apply");

const { rows: visits } = await pool.query(
  `SELECT v.id, v.current_status, p.name
     FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
    WHERE p.file_no = $1 AND v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
  [FILE_NO],
);
if (visits.length !== 1) {
  console.error(`Expected one visit today for ${FILE_NO}, found ${visits.length}`);
  process.exit(1);
}
const visit = visits[0];
const catalogue = await getMachines(pool);
const echo = machineFor(catalogue, "echo");
const unwantedNames = UNWANTED.flatMap((id) => machineFor(catalogue, id).tests);

const { rows: unwantedOrders } = await pool.query(
  `SELECT o.id, t.test_name, o.payment_status, o.sample_status,
          EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                   WHERE e.lab_order_id = o.id AND e.track = 'sample') AS started
     FROM giniflow_lab_orders o
     JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
    WHERE o.visit_id = $1 AND o.kind = 'machine' AND t.test_name = ANY($2::text[])`,
  [visit.id, unwantedNames],
);
const unsafe = unwantedOrders.filter(
  (o) => o.payment_status !== "pending" || o.sample_status !== "payment_pending" || o.started,
);
if (unsafe.length) {
  console.error("Refusing: these orders are paid or started —", unsafe);
  process.exit(1);
}
const { rows: unwantedSteps } = await pool.query(
  `SELECT id, step_catalog_id, status FROM giniflow_visit_steps
    WHERE visit_id = $1 AND step_catalog_id = ANY($2::text[]) AND status = 'pending'`,
  [visit.id, UNWANTED],
);

const { rows: existing } = await pool.query(
  `SELECT o.id FROM giniflow_lab_orders o
     JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
    WHERE o.visit_id = $1 AND o.kind = 'machine' AND t.test_name = ANY($2::text[])`,
  [visit.id, echo.tests],
);
console.log(`${visit.name} (${FILE_NO}) · ${visit.current_status}`);
console.log(
  `Will remove orders: ${unwantedOrders.map((o) => o.test_name).join(", ") || "none"} · steps: ${
    unwantedSteps.map((s) => s.step_catalog_id).join(", ") || "none"
  }`,
);
console.log(
  existing.length
    ? `Echo order already exists (${existing[0].id}) — not adding another`
    : `Will add: ${echo.tests[0]} · ₹${BILLED_AMOUNT} · paid in HealthRay (${BILL_NO})`,
);
if (!apply) {
  console.log("Dry run — re-run with --apply.");
  await pool.end();
  process.exit(0);
}

const client = await pool.connect();
let orderId = null;
try {
  await client.query("BEGIN");
  await client.query(`DELETE FROM giniflow_lab_orders WHERE id = ANY($1::uuid[])`, [
    unwantedOrders.map((o) => o.id),
  ]);
  await client.query(`DELETE FROM giniflow_visit_steps WHERE id = ANY($1::uuid[])`, [
    unwantedSteps.map((s) => s.id),
  ]);
  if (existing.length) {
    await client.query("COMMIT");
    console.log(`Removed ${unwantedOrders.length} order(s), ${unwantedSteps.length} step(s).`);
    await pool.end();
    process.exit(0);
  }
  const { rows } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, ordered_by, urgency, payment_status, amount_total,
        amount_paid, sample_status, kind)
     VALUES ($1, NULL, 'today', 'pending', $2, 0, 'payment_pending', 'machine')
     RETURNING id`,
    [visit.id, BILLED_AMOUNT],
  );
  orderId = rows[0].id;
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
    [orderId, echo.tests[0], BILLED_AMOUNT],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
     VALUES ($1, 'payment', 'pending', 'system', NULL)`,
    [orderId],
  );
  await insertMachineStepsForOrders(client, visit.id, ["echo"]);
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}

const paid = await clearPayment(orderId, {
  method: "paid",
  amountPaid: BILLED_AMOUNT,
  actorRole: "reception",
  note: `Paid in HealthRay — ${BILL_NO}`,
});
console.log(`Removed ${unwantedOrders.length} order(s), ${unwantedSteps.length} step(s).`);
console.log(
  `Added Echo order ${orderId} · payment ${paid.paymentStatus} · outstanding ₹${paid.outstanding}`,
);
await pool.end();
