import pool from "../../config/db.js";
import { fetchPatientTransactions } from "../healthray/client.js";
import { transactionsToBilling } from "../healthray/billingExtractor.js";
import {
  insertLabStepsForOrder,
  insertMachineStepsForOrders,
  raiseOrdersFromSteps,
} from "./journey.js";
import { machineFor, MACHINES } from "../../../shared/machineStages.js";
import { machineCaseListOnly } from "../../../shared/manualFloor.js";
import { createLogger } from "../logger.js";
import { healthrayBlockedUntil } from "./healthrayRefresh.js";
import { IST_TODAY } from "./statusEngine.js";

const { log, error } = createLogger("Machine Sync");

const SCAN_BATCH = Number(process.env.SCRIBE_MACHINE_SCAN_BATCH || 12);
const RESCAN_MIN = Number(process.env.SCRIBE_MACHINE_RESCAN_MIN || 20);
const BILL_READ_RESCAN_MIN = Number(process.env.SCRIBE_MACHINE_BILL_READ_RESCAN_MIN || 60);
const NOT_ON_FLOOR = ["booked", "confirmed", "dispensed", "exited"];
const NEVER_ARRIVED = ["no_show", "cancelled"];
const FINISHED = ["dispensed", "exited"];

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

const machineLines = (txns, visit) =>
  (
    transactionsToBilling(txns, {
      appointmentId: visit.healthray_id,
      date: visit.visit_date,
    })?.billing.items || []
  )
    .filter((i) => i.category !== "consultation" && i.category !== "lab")
    .map((i) => ({ name: i.desc, amount: i.amount || 0, machines: machinesOnLine(i.desc) }))
    .filter((l) => l.machines.length);

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

async function raiseOrder(client, visitId, machineId, { amount }) {
  const testName = machineFor(machineId).tests[0];
  const price = amount > 0 ? amount : await catalogPrice(client, testName);
  const { rows } = await client.query(
    `INSERT INTO giniflow_lab_orders
       (visit_id, ordered_by, urgency, payment_status, amount_total,
        amount_paid, sample_status, kind)
     VALUES ($1, NULL, 'today', 'pending', $2, 0, 'payment_pending', 'machine')
     RETURNING id`,
    [visitId, price],
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
    [orderId, "pending"],
  );
  return orderId;
}

const LAB_CASE_PATIENT_ID = (visitDate, patientId, fileNo) => `
  LEFT JOIN LATERAL (
    SELECT lc.raw_list_json->'patient'->>'healthray_patient_id' AS healthray_patient_id
      FROM lab_cases lc
     WHERE lc.case_date = ${visitDate}
       AND (lc.patient_id = ${patientId}
            OR (lc.patient_id IS NULL
                AND lc.raw_list_json->'patient'->>'healthray_uid' = ${fileNo}))
       AND lc.raw_list_json->'patient'->>'healthray_patient_id' IS NOT NULL
     ORDER BY lc.patient_id NULLS LAST
     LIMIT 1
  ) lab ON TRUE`;

const TARGET_SELECT = `
     SELECT v.id AS visit_id,
            v.visit_date,
            v.current_status,
            a.healthray_id,
            COALESCE(a.healthray_patient_id, prior.healthray_patient_id, lab.healthray_patient_id)
              AS hr_patient_id,
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
       ${LAB_CASE_PATIENT_ID("v.visit_date", "v.patient_id", "p.file_no")}
      WHERE NOT COALESCE(p.is_blocked, FALSE)
        AND v.current_status <> ALL($1::text[])
        AND a.healthray_id IS NOT NULL
        AND COALESCE(a.healthray_patient_id, prior.healthray_patient_id, lab.healthray_patient_id)
            IS NOT NULL`;

async function scanTargets(visitDate, db, limit) {
  const { rows } = await db.query(
    `${TARGET_SELECT}
        AND v.visit_date = $2::date
        AND v.current_status <> ALL($5::text[])
        AND (v.machine_scan_at IS NULL
             OR v.machine_scan_at < NOW() - ((CASE
                  WHEN EXISTS (SELECT 1 FROM giniflow_lab_orders o WHERE o.visit_id = v.id)
                  THEN $6 ELSE $3 END) || ' minutes')::interval)
      ORDER BY v.machine_scan_at NULLS FIRST, v.created_at
      LIMIT $4`,
    [
      NEVER_ARRIVED,
      visitDate,
      String(RESCAN_MIN),
      limit,
      NOT_ON_FLOOR,
      String(BILL_READ_RESCAN_MIN),
    ],
  );
  return rows;
}

const labLinesBilled = (txns, visit) => {
  const items = transactionsToBilling(txns, {
    appointmentId: visit.healthray_id,
    date: visit.visit_date,
  })?.billing.items;
  const byName = new Map();
  for (const i of items || []) {
    if (i.category === "lab" && i.desc && !byName.has(i.desc)) byName.set(i.desc, i.amount || 0);
  }
  return [...byName].map(([name, amount]) => ({ name, amount }));
};

const notYetOrdered = async (client, visitId, lines) => {
  const { rows } = await client.query(
    `SELECT DISTINCT t.test_name
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'lab' AND t.test_name = ANY($2::text[])`,
    [visitId, lines.map((l) => l.name)],
  );
  return lines.filter((l) => !rows.some((r) => r.test_name === l.name));
};

export async function syncMachineOrdersForVisit(visit, db = pool) {
  const txns = await fetchPatientTransactions(visit.hr_patient_id);
  const lines = machineLines(txns, visit);
  const labLines = labLinesBilled(txns, visit);
  if (!lines.length && !labLines.length) return { raised: 0, lines: 0, labSteps: [] };

  const client = await db.connect();
  let raised = 0;
  let labSteps = [];
  try {
    await client.query("BEGIN");
    if (labLines.length && !FINISHED.includes(visit.current_status)) {
      const missing = await notYetOrdered(client, visit.visit_id, labLines);
      if (missing.length) {
        const r = await raiseOrdersFromSteps(client, visit.visit_id, [
          { catalogId: "blood_sample", billedIn: "healthray", billedTests: missing },
        ]);
        if (r.labOrderId) {
          raised++;
          log("lab", `${visit.name}: ${missing.length} billed lab test(s) awaiting reception`);
        }
      }
      labSteps = (await insertLabStepsForOrder(client, visit.visit_id)).added;
    }
    for (const line of lines) {
      for (const machineId of line.machines) {
        if (await alreadyRaised(client, visit.visit_id, machineId)) continue;
        await raiseOrder(client, visit.visit_id, machineId, {
          amount: line.machines.length > 1 ? 0 : line.amount,
        });
        raised++;
        log("raise", `${visit.name}: ${machineFor(machineId).name} (${line.name})`);
      }
    }
    const billedMachines = [...new Set(lines.flatMap((l) => l.machines))];
    if (billedMachines.length && !FINISHED.includes(visit.current_status)) {
      labSteps = [
        ...labSteps,
        ...(await insertMachineStepsForOrders(client, visit.visit_id, billedMachines)).added,
      ];
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { raised, lines: lines.length, labSteps };
}

export async function syncBillingForVisitId(visitId, db = pool) {
  if (await healthrayBlockedUntil(db)) return { raised: 0, lines: 0, labSteps: [], blocked: true };
  const { rows } = await db.query(`${TARGET_SELECT} AND v.id = $2`, [NEVER_ARRIVED, visitId]);
  const visit = rows.find((r) => r.hr_patient_id);
  if (!visit) return { raised: 0, lines: 0, labSteps: [] };
  const result = await syncMachineOrdersForVisit(visit, db);
  await db.query(`UPDATE giniflow_visits SET machine_scan_at = NOW() WHERE id = $1`, [visitId]);
  return result;
}

export async function runMachineSync(dateStr, { limit = SCAN_BATCH, db = pool } = {}) {
  if (!machineCaseListOnly()) {
    return { skipped: "SCRIBE_MACHINE_CASE_LIST=0", scanned: 0, raised: 0, failed: 0 };
  }
  const blockedUntil = await healthrayBlockedUntil(db);
  if (blockedUntil) {
    return { skipped: `HealthRay blocked until ${blockedUntil}`, scanned: 0, raised: 0, failed: 0 };
  }
  const visitDate = dateStr || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
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

const LAB_STEPS = ["lab_billing", "blood_sample"];

export async function healthrayBillSteps(patientId, { date = null, db = pool } = {}) {
  const blockedUntil = await healthrayBlockedUntil(db);
  if (blockedUntil)
    return { status: "blocked", blockedUntil, labTests: [], machines: [], steps: [] };

  const { rows } = await db.query(
    `SELECT a.healthray_id,
            COALESCE($2::date, ${IST_TODAY})::text AS visit_date,
            COALESCE(a.healthray_patient_id, prior.healthray_patient_id, lab.healthray_patient_id)
              AS hr_patient_id
       FROM (SELECT p.id AS patient_id, p.file_no FROM patients p WHERE p.id = $1::int) me
       LEFT JOIN LATERAL (
         SELECT healthray_id, healthray_patient_id FROM appointments
          WHERE patient_id = me.patient_id AND appointment_date = COALESCE($2::date, ${IST_TODAY})
            AND healthray_id IS NOT NULL
          ORDER BY id DESC LIMIT 1
       ) a ON TRUE
       LEFT JOIN LATERAL (
         SELECT healthray_patient_id FROM appointments
          WHERE patient_id = me.patient_id AND healthray_patient_id IS NOT NULL
          ORDER BY appointment_date DESC LIMIT 1
       ) prior ON TRUE
       ${LAB_CASE_PATIENT_ID(`COALESCE($2::date, ${IST_TODAY})`, "me.patient_id", "me.file_no")}`,
    [patientId, date],
  );
  const visit = rows[0];
  if (!visit?.hr_patient_id) return { status: "no_patient", labTests: [], machines: [], steps: [] };

  const txns = await fetchPatientTransactions(visit.hr_patient_id);
  const labLines = labLinesBilled(txns, visit);
  const labTests = labLines.map((l) => l.name);
  const machineIds = [...new Set(machineLines(txns, visit).flatMap((l) => l.machines))];
  const ids = [...(labTests.length ? LAB_STEPS : []), ...machineIds];
  if (!ids.length) return { status: "no_bill", labTests: [], machines: [], steps: [] };

  const { rows: catalog } = await db.query(
    `SELECT id, name, default_duration_min, station, assigned_role, chain_status
       FROM flow_step_catalog WHERE id = ANY($1) AND COALESCE(is_active, TRUE)`,
    [ids],
  );
  const steps = ids
    .map((id) => catalog.find((c) => c.id === id))
    .filter(Boolean)
    .map((c) => ({
      catalogId: c.id,
      name: c.name,
      minutes: c.default_duration_min,
      station: c.station,
      role: c.assigned_role,
      chainStatus: c.chain_status,
      billedIn: "healthray",
      ...(c.id === "blood_sample" ? { tests: labTests, billedTests: labLines } : {}),
    }));
  return {
    status: "ok",
    labTests,
    machines: machineIds.map((id) => machineFor(id).name),
    steps,
  };
}
