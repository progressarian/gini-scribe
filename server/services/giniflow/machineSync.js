import pool from "../../config/db.js";
import { testPriceForVisit } from "../pricing.js";
import {
  insertLabStepsForOrder,
  insertMachineStepsForOrders,
  raiseOrdersFromSteps,
  sampleTakenBeforeVisit,
} from "./journey.js";
import { machineFor } from "../../../shared/machineStages.js";
import { getMachines } from "./machineCatalog.js";
import { billSuppressor, cancelDeadBillTests } from "./testCancel.js";
import { CANCELLABLE_ORDER_STATUSES } from "../../../shared/testCancelReasons.js";
import { machineCaseListOnly } from "../../../shared/manualFloor.js";
import { LAB_TEST_STEP_IDS } from "../../../shared/journeyOrder.js";
import { createLogger } from "../logger.js";
import { billReadsBlockedUntil } from "./healthrayRefresh.js";
import { BILL_MIN_GAP_MS } from "../healthray/client.js";
import { IST_TODAY } from "./statusEngine.js";
import {
  billedLabLines,
  billedMachineLines,
  priceOrdersFromBill,
  readPatientBill,
  repricePaidOrdersFromBill,
  syncBillCharges,
  reconcileTestSteps,
} from "./patientBill.js";

const { log, error } = createLogger("Machine Sync");

const SCAN_BATCH = Number(process.env.SCRIBE_MACHINE_SCAN_BATCH || 12);
const RESCAN_MIN = Number(process.env.SCRIBE_MACHINE_RESCAN_MIN || 20);
const BILL_READ_RESCAN_MIN = Number(process.env.SCRIBE_MACHINE_BILL_READ_RESCAN_MIN || 60);
const OPEN_TESTS_RESCAN_MIN = Number(process.env.SCRIBE_BILL_OPEN_TESTS_RESCAN_MIN || 15);
const UNCONFIRMED_TESTS_RESCAN_MIN = Number(process.env.SCRIBE_BILL_TESTS_RESCAN_MIN || 5);
const BILL_READS_PER_RUN = Number(process.env.SCRIBE_BILL_READS_PER_RUN || 4);

const REFUNDABLE_OPEN_SQL = `(
  EXISTS (SELECT 1 FROM giniflow_lab_orders ro
           WHERE ro.visit_id = v.id AND ro.urgency = 'today'
             AND ro.sample_status = ANY(ARRAY[${CANCELLABLE_ORDER_STATUSES.map((st) => `'${st}'`).join(", ")}]))
  OR EXISTS (SELECT 1 FROM giniflow_bill_charges rc
              WHERE rc.visit_id = v.id AND rc.payment_status = 'pending'))`;
const BILLED_SQL = `EXISTS (SELECT 1 FROM giniflow_patient_bills b
                             WHERE b.patient_id = v.patient_id AND b.bill_date = v.visit_date
                               AND b.status = 'billed')`;
const UNCONFIRMED_TESTS_SQL = `EXISTS (
  SELECT 1 FROM giniflow_visit_steps us
    LEFT JOIN flow_step_catalog uc ON uc.id = us.step_catalog_id
   WHERE us.visit_id = v.id AND us.status = 'pending' AND us.source IN ('template', 'added')
     AND (us.step_catalog_id = ANY(ARRAY[${LAB_TEST_STEP_IDS.map((id) => `'${id}'`).join(", ")}])
          OR COALESCE(uc.machine, FALSE)))`;
const BILL_TIER_SQL = `(CASE
  WHEN NOT ${BILLED_SQL} AND ${UNCONFIRMED_TESTS_SQL} THEN 'A'
  WHEN NOT ${BILLED_SQL} THEN 'B'
  WHEN ${REFUNDABLE_OPEN_SQL} THEN 'C'
  ELSE 'D' END)`;
const EXIT_GRACE_MIN = Number(process.env.SCRIBE_MACHINE_EXIT_GRACE_MIN || 0);
const NEVER_ON_FLOOR = ["booked", "confirmed"];
const NEVER_ARRIVED = ["no_show", "cancelled"];
const FINISHED = ["dispensed", "exited"];

const alreadyRaised = async (client, visitId, machine) => {
  const { rows } = await client.query(
    `SELECT 1 FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'machine' AND t.test_name = ANY($2::text[])
      LIMIT 1`,
    [visitId, machine.tests],
  );
  return rows.length > 0;
};

async function raiseOrder(client, visitId, machine, { amount }) {
  const testName = machine.tests[0];
  const price =
    amount > 0 ? amount : Number((await testPriceForVisit(visitId, testName, client)) ?? 0);
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
            v.patient_id,
            v.visit_date,
            v.current_status,
            COALESCE(a.healthray_id, sameday.healthray_id) AS healthray_id,
            COALESCE(a.healthray_patient_id, sameday.healthray_patient_id,
                     prior.healthray_patient_id, lab.healthray_patient_id) AS hr_patient_id,
            ${REFUNDABLE_OPEN_SQL} AS refundable_open,
            p.name,
            v.machine_scan_at,
            v.created_at AS visit_created_at
       FROM giniflow_visits v
       JOIN patients p ON p.id = v.patient_id
       LEFT JOIN appointments a ON a.id = v.appointment_id
       LEFT JOIN LATERAL (
         SELECT a1.healthray_id, a1.healthray_patient_id
           FROM appointments a1
          WHERE a1.patient_id = v.patient_id AND a1.appointment_date = v.visit_date
            AND a1.healthray_id IS NOT NULL
          ORDER BY a1.id DESC LIMIT 1
       ) sameday ON TRUE
       LEFT JOIN LATERAL (
         SELECT a2.healthray_patient_id
           FROM appointments a2
          WHERE a2.patient_id = v.patient_id AND a2.healthray_patient_id IS NOT NULL
          ORDER BY a2.appointment_date DESC LIMIT 1
       ) prior ON TRUE
       ${LAB_CASE_PATIENT_ID("v.visit_date", "v.patient_id", "p.file_no")}
      WHERE NOT COALESCE(p.is_blocked, FALSE)
        AND v.current_status <> ALL($1::text[])
        AND COALESCE(a.healthray_patient_id, sameday.healthray_patient_id,
                     prior.healthray_patient_id, lab.healthray_patient_id) IS NOT NULL`;

export async function scanTargets(visitDate, db, limit) {
  const { rows } = await db.query(
    `SELECT t.* FROM (
       SELECT due.*, ${BILL_TIER_SQL} AS bill_tier
         FROM (${TARGET_SELECT}
                 AND v.visit_date = $2::date
                 AND v.current_status <> ALL($5::text[])
                 AND (v.current_status <> ALL($7::text[])
                      OR v.updated_at > NOW() - ($8 || ' minutes')::interval)) due
         JOIN giniflow_visits v ON v.id = due.visit_id
     ) t
      WHERE t.machine_scan_at IS NULL
         OR t.machine_scan_at < NOW() - ((CASE t.bill_tier
              WHEN 'A' THEN $10
              WHEN 'B' THEN $3
              WHEN 'C' THEN $9
              ELSE $6 END) || ' minutes')::interval
      ORDER BY t.bill_tier, t.machine_scan_at NULLS FIRST, t.visit_created_at
      LIMIT $4`,
    [
      NEVER_ARRIVED,
      visitDate,
      String(RESCAN_MIN),
      limit,
      NEVER_ON_FLOOR,
      String(BILL_READ_RESCAN_MIN),
      FINISHED,
      String(EXIT_GRACE_MIN),
      String(OPEN_TESTS_RESCAN_MIN),
      String(UNCONFIRMED_TESTS_RESCAN_MIN),
    ],
  );
  return rows;
}

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

export async function syncMachineOrdersForVisit(visit, db = pool, { slotWaitMs } = {}) {
  const bill = await readPatientBill(
    {
      patientId: visit.patient_id,
      hrPatientId: visit.hr_patient_id,
      healthrayId: visit.healthray_id,
      date: visit.visit_date,
    },
    db,
    {
      ...(visit.refundable_open ? { maxAgeMin: OPEN_TESTS_RESCAN_MIN } : {}),
      slotWaitMs,
    },
  );
  if (bill.deferred) return { raised: 0, lines: 0, labSteps: [], removed: null, deferred: true };
  if (bill.status !== "billed") return { raised: 0, lines: 0, labSteps: [], removed: null };
  const machines = await getMachines(db);
  const lines = billedMachineLines(bill, machines);

  const client = await db.connect();
  let raised = 0;
  let labSteps = [];
  let removed = null;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM giniflow_visits WHERE id = $1 FOR UPDATE`, [visit.visit_id]);
    const skip = await billSuppressor(client, visit.visit_id);
    const liveLabLines = billedLabLines(bill, { skip });
    const liveLines = lines
      .map((l) => ({
        ...l,
        machines: l.machines.filter((m) => !skip({ kind: "machine", machineId: m, line: l.line })),
      }))
      .filter((l) => l.machines.length);
    if (
      liveLabLines.length &&
      !FINISHED.includes(visit.current_status) &&
      !(await sampleTakenBeforeVisit(client, visit.visit_id))
    ) {
      const missing = await notYetOrdered(client, visit.visit_id, liveLabLines);
      if (missing.length) {
        const r = await raiseOrdersFromSteps(client, visit.visit_id, [
          { catalogId: "blood_sample", billedIn: "healthray", billedTests: missing },
        ]);
        if (r.labOrderId) {
          raised++;
          log("lab", `${visit.name}: ${missing.length} billed lab test(s) awaiting reception`);
        }
      }
      await client.query(
        `UPDATE giniflow_visit_steps SET status = 'pending'
          WHERE visit_id = $1 AND status = 'skipped'
            AND step_catalog_id = ANY($2::text[])`,
        [visit.visit_id, [...LAB_STEPS, "lab_processing_2"]],
      );
      labSteps = (await insertLabStepsForOrder(client, visit.visit_id)).added;
    }
    for (const line of liveLines) {
      for (const machineId of line.machines) {
        const machine = machineFor(machines, machineId);
        if (!machine || (await alreadyRaised(client, visit.visit_id, machine))) continue;
        await raiseOrder(client, visit.visit_id, machine, {
          amount: line.amountOf[machineId],
        });
        raised++;
        log("raise", `${visit.name}: ${machine.name} (${line.name})`);
      }
    }
    const billedMachines = [...new Set(liveLines.flatMap((l) => l.machines))];
    if (billedMachines.length && !FINISHED.includes(visit.current_status)) {
      labSteps = [
        ...labSteps,
        ...(await insertMachineStepsForOrders(client, visit.visit_id, billedMachines)).added,
      ];
    }
    if (!FINISHED.includes(visit.current_status)) {
      const repriced = await priceOrdersFromBill(client, visit.visit_id, bill, machines);
      if (repriced)
        log("price", `${visit.name}: ${repriced} order(s) repriced to the HealthRay bill`);
      const paidReprice = await repricePaidOrdersFromBill(client, visit.visit_id, bill, machines);
      for (const r of paidReprice.repriced) {
        log(
          "price-paid",
          `${visit.name}: ${r.tests} — ₹${r.from} → ₹${r.to} (${r.lines.join("; ")})`,
        );
      }
      for (const r of paidReprice.wouldReprice) {
        log(
          "price-paid-dry",
          `${visit.name}: would reprice ${r.tests} — ₹${r.from} → ₹${r.to} (${r.lines.join("; ")})`,
        );
      }
      for (const r of paidReprice.refused) {
        log("price-paid-refused", `${visit.name}: ${r.tests} left as paid — ${r.reason}`);
      }
      if (await syncBillCharges(client, visit.visit_id, bill, machines, skip)) {
        log("charge", `${visit.name}: HealthRay charge(s) waiting at reception`);
      }
      const dead = await cancelDeadBillTests(client, visit.visit_id, bill, machines);
      if (dead.cancelled) {
        log("cancel", `${visit.name}: ${dead.cancelled} test(s) refunded or removed in HealthRay`);
      }
      for (const w of dead.wouldCancel) {
        log("cancel-dry", `${visit.name}: would cancel ${w.test} (${w.line}, ${w.reason})`);
      }
      for (const f of dead.failed) {
        error("cancel", `${visit.name}: could not cancel ${f.test} (${f.line}): ${f.error}`);
      }
      removed = await reconcileTestSteps(client, visit.visit_id, bill, machines);
      if (removed.removedSteps || removed.removedOrders) {
        log(
          "unbilled",
          `${visit.name}: cancelled ${removed.removedOrders} order(s), skipped ${removed.removedSteps} step(s) not on the bill`,
        );
      }
      for (const w of removed.wouldCancel) {
        log("unbilled-dry", `${visit.name}: would cancel ${w.test || w.step} (${w.reason})`);
      }
      for (const f of removed.failed) {
        error("unbilled", `${visit.name}: could not cancel ${f.test}: ${f.error}`);
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { raised, lines: lines.length, labSteps, removed };
}

export async function canReadBill(visitId, db = pool) {
  if (await billReadsBlockedUntil(db)) return false;
  const { rows } = await db.query(`${TARGET_SELECT} AND v.id = $2`, [NEVER_ARRIVED, visitId]);
  return rows.some((r) => r.hr_patient_id);
}

export async function syncBillingForVisitId(visitId, db = pool) {
  if (await billReadsBlockedUntil(db)) return { raised: 0, lines: 0, labSteps: [], blocked: true };
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
  const blockedUntil = await billReadsBlockedUntil(db);
  if (blockedUntil) {
    return { skipped: `HealthRay blocked until ${blockedUntil}`, scanned: 0, raised: 0, failed: 0 };
  }
  const visitDate = dateStr || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const targets = await scanTargets(visitDate, db, limit);
  let raised = 0;
  let failed = 0;
  let scanned = 0;
  const slotDeadline = Date.now() + Math.max(0, BILL_READS_PER_RUN - 1) * BILL_MIN_GAP_MS;
  for (const visit of targets) {
    try {
      const result = await syncMachineOrdersForVisit(visit, db, {
        slotWaitMs: Math.max(0, slotDeadline - Date.now()),
      });
      if (result.deferred) break;
      raised += result.raised;
    } catch (e) {
      failed++;
      error("scan", `${visit.name}: ${e.message}`);
    }
    scanned++;
    await db.query(`UPDATE giniflow_visits SET machine_scan_at = NOW() WHERE id = $1`, [
      visit.visit_id,
    ]);
  }
  const waiting = targets.length - scanned;
  if (targets.length) {
    const tiers = ["A", "B", "C", "D"]
      .map((t) => `${t} ${targets.filter((v) => v.bill_tier === t).length}`)
      .join(" · ");
    log(
      "run",
      `scanned ${scanned}, raised ${raised} order(s), ${failed} failed${waiting ? `, ${waiting} waiting for the next bill-read slot` : ""} (due: ${tiers})`,
    );
  }
  return { scanned, raised, failed, waiting };
}

const LAB_STEPS = ["lab_billing", "blood_sample"];

const visitIdFor = async (patientId, date, db) => {
  const { rows } = await db.query(
    `SELECT id FROM giniflow_visits WHERE patient_id = $1 AND visit_date = $2::date
      ORDER BY merged_into_visit_id NULLS FIRST LIMIT 1`,
    [patientId, date],
  );
  return rows[0]?.id ?? null;
};

const labDoneEarlierToday = async (patientId, date, db) => {
  const visitId = await visitIdFor(patientId, date, db);
  return !!visitId && sampleTakenBeforeVisit(db, visitId);
};

export async function healthrayBillSteps(patientId, { date = null, db = pool } = {}) {
  const { rows } = await db.query(
    `SELECT a.healthray_id, me.patient_id,
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

  const bill = await readPatientBill(
    {
      patientId: visit.patient_id,
      hrPatientId: visit.hr_patient_id,
      healthrayId: visit.healthray_id,
      date: visit.visit_date,
    },
    db,
  );
  const empty = { labTests: [], machines: [], steps: [], readAt: bill.readAt };
  if (bill.deferred && bill.status === "unknown") return { ...empty, status: "loading" };
  if (bill.status === "unknown") {
    return { ...empty, status: "blocked", blockedUntil: await billReadsBlockedUntil(db) };
  }
  if (bill.status === "no_bill") return { ...empty, status: "no_bill" };
  const visitId = await visitIdFor(visit.patient_id, visit.visit_date, db);
  const skip = visitId ? await billSuppressor(db, visitId) : () => false;
  const labLines = (await labDoneEarlierToday(visit.patient_id, visit.visit_date, db))
    ? []
    : billedLabLines(bill, { skip });
  const labTests = labLines.map((l) => l.name);
  const machines = await getMachines(db);
  const machineIds = [
    ...new Set(
      billedMachineLines(bill, machines).flatMap((l) =>
        l.machines.filter((m) => !skip({ kind: "machine", machineId: m, line: l.line })),
      ),
    ),
  ];
  const ids = [...(labTests.length ? LAB_STEPS : []), ...machineIds];
  if (!ids.length) return { ...empty, status: "no_tests" };

  const { rows: catalog } = await db.query(
    `SELECT id, name, default_duration_min, station, assigned_role, chain_status,
            COALESCE(machine, FALSE) AS machine
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
      machine: c.machine,
      billedIn: "healthray",
      ...(c.id === "blood_sample" ? { tests: labTests, billedTests: labLines } : {}),
    }));
  return {
    status: "ok",
    readAt: bill.readAt,
    labTests,
    machines: machineIds.map((id) => machineFor(machines, id)?.name || id),
    steps,
  };
}
