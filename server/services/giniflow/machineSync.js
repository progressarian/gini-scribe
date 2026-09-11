import pool from "../../config/db.js";
import { fetchPatientTransactions } from "../healthray/client.js";
import { machineFor, MACHINES } from "../../../shared/machineStages.js";
import { machineCaseListOnly } from "../../../shared/manualFloor.js";
import { PAYMENT_STATUS } from "../../../shared/labPayment.js";
import { createLogger } from "../logger.js";

const { log, error } = createLogger("Machine Sync");

const MACHINE_CATEGORY = /machine|radiolog|imaging/i;
const SCAN_BATCH = Number(process.env.SCRIBE_MACHINE_SCAN_BATCH || 12);
const RESCAN_MIN = Number(process.env.SCRIBE_MACHINE_RESCAN_MIN || 20);
const NEVER_ARRIVED = ["no_show", "cancelled"];

const flatten = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const MACHINE_BY_TOKEN = new Map(MACHINES.flatMap((m) => m.tests.map((t) => [flatten(t), m.id])));

const machinesOnLine = (name) => {
  const ids = [];
  for (const token of String(name || "").split(/[^A-Za-z0-9]+/)) {
    const id = MACHINE_BY_TOKEN.get(flatten(token));
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

const machineLines = (txns, healthrayApptId) =>
  (txns || [])
    .filter((t) => String(t.appointment_id) === String(healthrayApptId))
    .flatMap((t) =>
      (t.billing_items || [])
        .filter((b) => MACHINE_CATEGORY.test(b.category_type || b.charge_category || ""))
        .map((b) => ({
          name: b.name,
          amount: Number(b.net_price ?? b.price) || 0,
          due: Number(t.due_amount) || 0,
          machines: machinesOnLine(b.name),
        })),
    );

const paymentFor = (due) => (due > 0 ? PAYMENT_STATUS.PENDING : PAYMENT_STATUS.PAID);

const alreadyRaised = async (client, visitId, machineId) => {
  const { rows } = await client.query(
    `SELECT 1 FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'machine' AND t.test_name = ANY($2::text[])
      LIMIT 1`,
    [visitId, machineFor(machineId).tests],
  );
  return rows.length > 0;
};

const catalogPrice = async (client, testName) => {
  const { rows } = await client.query(
    `SELECT price FROM giniflow_test_catalog
      WHERE UPPER(test_name) = UPPER($1) AND COALESCE(is_active, TRUE)`,
    [testName],
  );
  return Number(rows[0]?.price ?? 0);
};

async function raiseOrder(client, visitId, machineId, { payment, amount }) {
  const testName = machineFor(machineId).tests[0];
  const price = amount > 0 ? amount : await catalogPrice(client, testName);
  const paid = payment === PAYMENT_STATUS.PAID;
  const { rows } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, ordered_by, urgency, payment_status, amount_total,
        amount_paid, sample_status, kind)
     VALUES ($1, NULL, 'today', $2, $3, $4, $5, 'machine')
     RETURNING id`,
    [visitId, payment, price, paid ? price : 0, paid ? "paid" : "payment_pending"],
  );
  const orderId = rows[0].id;
  await client.query(
    `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price)
     VALUES ($1, $2, $3)`,
    [orderId, testName, price],
  );
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
     VALUES ($1, 'payment', $2, 'system', NULL)`,
    [orderId, paid ? "paid" : "pending"],
  );
  return orderId;
}

async function scanTargets(visitDate, db, limit) {
  const { rows } = await db.query(
    `SELECT v.id AS visit_id,
            a.healthray_id,
            COALESCE(a.healthray_patient_id, prior.healthray_patient_id) AS hr_patient_id,
            p.name
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
       LEFT JOIN LATERAL (
         SELECT a2.healthray_patient_id
           FROM appointments a2
          WHERE a2.patient_id = v.patient_id AND a2.healthray_patient_id IS NOT NULL
          ORDER BY a2.appointment_date DESC LIMIT 1
       ) prior ON TRUE
      WHERE v.visit_date = $1::date
        AND NOT COALESCE(p.is_blocked, FALSE)
        AND v.current_status <> ALL($2::text[])
        AND a.healthray_id IS NOT NULL
        AND (v.machine_scan_at IS NULL OR v.machine_scan_at < NOW() - ($3 || ' minutes')::interval)
      ORDER BY v.machine_scan_at NULLS FIRST, v.created_at
      LIMIT $4`,
    [visitDate, NEVER_ARRIVED, String(RESCAN_MIN), limit],
  );
  return rows.filter((r) => r.hr_patient_id);
}

export async function syncMachineOrdersForVisit(visit, db = pool) {
  const txns = await fetchPatientTransactions(visit.hr_patient_id);
  const lines = machineLines(txns, visit.healthray_id);
  if (!lines.length) return { raised: 0, lines: 0 };

  const client = await db.connect();
  let raised = 0;
  try {
    await client.query("BEGIN");
    for (const line of lines) {
      for (const machineId of line.machines) {
        if (await alreadyRaised(client, visit.visit_id, machineId)) continue;
        await raiseOrder(client, visit.visit_id, machineId, {
          payment: paymentFor(line.due),
          amount: line.machines.length > 1 ? 0 : line.amount,
        });
        raised++;
        log("raise", `${visit.name}: ${machineFor(machineId).name} (${line.name})`);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { raised, lines: lines.length };
}

export async function runMachineSync(dateStr, { limit = SCAN_BATCH, db = pool } = {}) {
  if (!machineCaseListOnly()) {
    return { skipped: "SCRIBE_MACHINE_CASE_LIST=0", scanned: 0, raised: 0, failed: 0 };
  }
  const visitDate = dateStr || new Date().toISOString().slice(0, 10);
  const targets = await scanTargets(visitDate, db, limit);
  let raised = 0;
  let failed = 0;
  for (const visit of targets) {
    try {
      raised += (await syncMachineOrdersForVisit(visit, db)).raised;
    } catch (e) {
      failed++;
      error("scan", `${visit.name}: ${e.message}`);
    }
    await db.query(`UPDATE giniflow_visits SET machine_scan_at = NOW() WHERE id = $1`, [
      visit.visit_id,
    ]);
  }
  if (targets.length) {
    log("run", `scanned ${targets.length}, raised ${raised} order(s), ${failed} failed`);
  }
  return { scanned: targets.length, raised, failed };
}
