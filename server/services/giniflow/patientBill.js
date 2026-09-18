import pool from "../../config/db.js";
import { fetchPatientTransactions } from "../healthray/client.js";
import { transactionsToBilling } from "../healthray/billingExtractor.js";
import { healthrayBlockedUntil } from "./healthrayRefresh.js";
import { machineFor, machineForTest, machinesOnBillLine } from "../../../shared/machineStages.js";
import {
  LAB_TEST_STEP_IDS,
  dropUnbilledTestSteps,
  isTestStep,
} from "../../../shared/journeyOrder.js";
import { paise, rupeesFromPaise } from "../../../shared/labPayment.js";

export const BILL_MAX_AGE_MIN = Number(process.env.SCRIBE_BILL_MAX_AGE_MIN || 60);
export const NO_BILL_MAX_AGE_MIN = Number(process.env.SCRIBE_NO_BILL_MAX_AGE_MIN || 20);

const UNKNOWN = { status: "unknown", items: [], invoiceNo: null, readAt: null };

const shape = (row) =>
  row
    ? {
        status: row.status,
        items: row.items || [],
        invoiceNo: row.invoice_no,
        readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
      }
    : null;

export async function storedBill(patientId, date, db = pool) {
  const { rows } = await db.query(
    `SELECT status, items, invoice_no, read_at FROM giniflow_patient_bills
      WHERE patient_id = $1 AND bill_date = $2::date`,
    [patientId, date],
  );
  return shape(rows[0]);
}

const itemKey = (i) =>
  `${i.category}|${String(i.desc || "")
    .trim()
    .toLowerCase()}`;

const lineKey = (i) => (i.itemId != null ? `id:${i.itemId}` : `key:${itemKey(i)}`);

const stampDeath = (item, previous, at) => {
  if (isLiveBillItem(item)) {
    if (!item.deadSince) return item;
    const { deadSince, ...alive } = item;
    return alive;
  }
  const since = previous && !isLiveBillItem(previous) ? previous.deadSince : null;
  return { ...item, deadSince: since || item.deadSince || at };
};

export const mergeBillItems = (before = [], now = [], at = new Date().toISOString()) => {
  const current = now || [];
  const invoicesRead = new Set(current.map((i) => i.invoice).filter(Boolean));
  const byKey = new Map(current.map((i) => [lineKey(i), i]));
  const byName = new Map();
  for (const i of current) if (!byName.has(itemKey(i))) byName.set(itemKey(i), i);
  const used = new Set();
  const merged = [];
  for (const old of before || []) {
    const legacy = old.itemId == null && old.invoice == null;
    const match = byKey.get(lineKey(old)) || (legacy ? byName.get(itemKey(old)) : null);
    if (match && !used.has(lineKey(match))) {
      used.add(lineKey(match));
      merged.push(stampDeath(match, old, at));
    } else if (old.invoice && invoicesRead.has(old.invoice)) {
      merged.push(stampDeath({ ...old, removed: true }, old, at));
    } else if (!match) {
      merged.push(old);
    }
  }
  for (const i of current) if (!used.has(lineKey(i))) merged.push(stampDeath(i, null, at));
  return merged;
};

export const keepEverySeenItem = mergeBillItems;

const ageMinutes = (bill) =>
  bill?.readAt ? (Date.now() - new Date(bill.readAt).getTime()) / 60000 : Infinity;

export async function readPatientBill(
  { patientId, hrPatientId, healthrayId = null, date },
  db = pool,
  { maxAgeMin = BILL_MAX_AGE_MIN, noBillMaxAgeMin = NO_BILL_MAX_AGE_MIN } = {},
) {
  const stored = await storedBill(patientId, date, db);
  const fresh = stored?.status === "billed" ? maxAgeMin : noBillMaxAgeMin;
  if (stored && ageMinutes(stored) < fresh) return stored;
  if (!hrPatientId || (await healthrayBlockedUntil(db))) return stored || UNKNOWN;

  let txns;
  try {
    txns = await fetchPatientTransactions(hrPatientId);
  } catch (e) {
    if (stored) return stored;
    throw e;
  }
  const billing = transactionsToBilling(txns, {
    appointmentId: healthrayId,
    date,
    wholeDay: true,
  })?.billing;
  const items = mergeBillItems(stored?.items, billing?.items);
  const billed = !!billing || stored?.status === "billed";
  const { rows } = await db.query(
    `INSERT INTO giniflow_patient_bills (patient_id, bill_date, status, items, invoice_no, read_at)
     VALUES ($1, $2::date, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (patient_id, bill_date) DO UPDATE
        SET status = EXCLUDED.status, items = EXCLUDED.items,
            invoice_no = EXCLUDED.invoice_no, read_at = EXCLUDED.read_at
     RETURNING status, items, invoice_no, read_at`,
    [
      patientId,
      date,
      billed ? "billed" : "no_bill",
      JSON.stringify(items),
      billing?.invoice_no ?? stored?.invoiceNo ?? null,
    ],
  );
  return shape(rows[0]);
}

export const isLiveBillItem = (i) =>
  !i.cancelled &&
  !i.removed &&
  !(Number(i.amount) > 0 && Number(i.refunded || 0) >= Number(i.amount));

export const billLineRef = (i) => ({
  itemId: i.itemId ?? null,
  invoice: i.invoice ?? null,
  desc: i.desc,
  amount: Number(i.amount) || 0,
});

const itemsOf = (bill, { includeDead = false } = {}) =>
  (bill?.items || []).filter((i) => includeDead || isLiveBillItem(i));

export const billedLabLines = (bill, opts = {}) => {
  const byName = new Map();
  for (const i of itemsOf(bill, opts)) {
    if (i.category !== "lab" || !i.desc || byName.has(i.desc)) continue;
    if (opts.skip?.({ kind: "lab", testName: i.desc, line: billLineRef(i) })) continue;
    byName.set(i.desc, i);
  }
  return [...byName].map(([name, i]) => ({
    name,
    amount: i.amount || 0,
    discount: i.discount || 0,
    line: billLineRef(i),
  }));
};

export const splitBillAmount = (amount, count) => {
  const total = paise(amount);
  const unit = total % 100 === 0 ? 100 : 1;
  const units = total / unit;
  const base = Math.floor(units / count);
  const extra = units - base * count;
  return Array.from({ length: count }, (_, i) =>
    rupeesFromPaise((base + (i < extra ? 1 : 0)) * unit),
  );
};

const sharesByMachine = (machineIds, amount) => {
  const parts = splitBillAmount(amount, machineIds.length);
  return Object.fromEntries(machineIds.map((id, i) => [id, parts[i]]));
};

export const billedMachineLines = (bill, machines, opts) =>
  itemsOf(bill, opts)
    .filter((i) => i.category !== "consultation" && i.category !== "lab")
    .map((i) => {
      const onLine = machinesOnBillLine(machines, i.desc);
      return {
        name: i.desc,
        amount: i.amount || 0,
        discount: i.discount || 0,
        machines: onLine,
        amountOf: sharesByMachine(onLine, i.amount || 0),
        discountOf: sharesByMachine(onLine, i.discount || 0),
        line: billLineRef(i),
      };
    })
    .filter((l) => l.machines.length);

const CHARGE_CATEGORIES = ["imaging", "machine"];

export const billedChargeLines = (bill, machines) => {
  const byName = new Map();
  for (const i of itemsOf(bill)) {
    if (!CHARGE_CATEGORIES.includes(i.category) || !i.desc) continue;
    if (machinesOnBillLine(machines, i.desc).length) continue;
    byName.set(i.desc, i);
  }
  return [...byName].map(([name, i]) => ({ name, amount: i.amount || 0, line: billLineRef(i) }));
};

export async function syncBillCharges(client, visitId, bill, machines, skip = () => false) {
  if (bill?.status !== "billed") return 0;
  const lines = billedChargeLines(bill, machines).filter(
    (l) => !skip({ kind: "charge", testName: l.name, line: l.line }),
  );
  if (!lines.length) return 0;
  const { rowCount } = await client.query(
    `INSERT INTO giniflow_bill_charges (visit_id, item_name, amount)
     SELECT $1, * FROM UNNEST($2::text[], $3::numeric[])
     ON CONFLICT (visit_id, item_name) DO UPDATE
        SET amount = EXCLUDED.amount, updated_at = NOW()
      WHERE giniflow_bill_charges.payment_status = 'pending'
        AND giniflow_bill_charges.amount <> EXCLUDED.amount`,
    [visitId, lines.map((l) => l.name), lines.map((l) => l.amount)],
  );
  return rowCount;
}

export const billedStepIds = (bill, machines, opts) =>
  new Set([
    ...(billedLabLines(bill, opts).length ? LAB_TEST_STEP_IDS : []),
    ...billedMachineLines(bill, machines, opts).flatMap((l) => l.machines),
  ]);

export const stepsAllowedByBill = (steps, bill, machines) =>
  bill?.status === "billed"
    ? dropUnbilledTestSteps(steps, billedStepIds(bill, machines), {
        machineOf: (s) => s.machine ?? !!machineFor(machines, s.catalogId),
      })
    : steps;

const nameKey = (v) =>
  String(v || "")
    .trim()
    .toLowerCase();

const billLineFor = (bill, machines) => {
  const lab = new Map(billedLabLines(bill).map((l) => [nameKey(l.name), l]));
  const machine = new Map(
    billedMachineLines(bill, machines)
      .sort((a, b) => b.machines.length - a.machines.length)
      .flatMap((l) =>
        l.machines.map((id) => [id, { amount: l.amountOf[id], discount: l.discountOf[id] }]),
      ),
  );
  return (kind, testName) =>
    kind === "lab"
      ? lab.get(nameKey(testName))
      : machine.get(machineForTest(machines, testName)?.id);
};

export const combinedBillLineOf = (bill, machines) => {
  const lines = billedMachineLines(bill, machines);
  const ownLine = new Set(lines.filter((l) => l.machines.length === 1).map((l) => l.machines[0]));
  const byMachine = new Map(
    lines
      .filter((l) => l.machines.length > 1)
      .flatMap((l) => l.machines.filter((id) => !ownLine.has(id)).map((id) => [id, l.name])),
  );
  return (testName) => byMachine.get(machineForTest(machines, testName)?.id) || null;
};

export const billDiscountOn = (bill, machines) => {
  const lineOf = billLineFor(bill, machines);
  return (kind, testNames) =>
    testNames.reduce((sum, name) => sum + (lineOf(kind, name)?.discount || 0), 0);
};

export async function priceOrdersFromBill(client, visitId, bill, machines) {
  if (bill?.status !== "billed") return 0;
  const lineOf = billLineFor(bill, machines);
  const { rows: orders } = await client.query(
    `SELECT o.id, o.kind,
            json_agg(json_build_object('id', t.id, 'name', t.test_name, 'price', t.price)) AS tests
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.urgency = 'today'
        AND o.payment_status = 'pending'
        AND COALESCE(o.amount_paid, 0) = 0
        AND COALESCE(o.claim_state, 'none') = 'none'
      GROUP BY o.id`,
    [visitId],
  );
  let repriced = 0;
  for (const order of orders) {
    const changed = order.tests
      .map((t) => ({ ...t, billed: lineOf(order.kind, t.name)?.amount }))
      .filter((t) => t.billed !== undefined && Number(t.billed) !== Number(t.price));
    if (!changed.length) continue;
    await client.query(
      `UPDATE giniflow_lab_order_tests AS t SET price = c.price
         FROM UNNEST($1::uuid[], $2::numeric[]) AS c(id, price)
        WHERE t.id = c.id`,
      [changed.map((t) => t.id), changed.map((t) => t.billed)],
    );
    await client.query(
      `UPDATE giniflow_lab_orders
          SET amount_total = (SELECT COALESCE(sum(price), 0) FROM giniflow_lab_order_tests
                               WHERE lab_order_id = $1),
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1`,
      [order.id],
    );
    repriced++;
  }
  return repriced;
}

export async function reconcileTestSteps(client, visitId, bill, machines) {
  if (bill?.status !== "billed") return { removedSteps: 0, removedOrders: 0 };
  const billed = billedStepIds(bill, machines, { includeDead: true });
  const labBilled = billedLabLines(bill, { includeDead: true }).length > 0;

  const { rows: orders } = await client.query(
    `SELECT o.id, o.kind, o.payment_status, o.sample_status,
            COALESCE(o.amount_paid, 0) AS amount_paid,
            o.created_at = (SELECT min(s.created_at) FROM giniflow_visit_steps s
                             WHERE s.visit_id = o.visit_id
                               AND s.source IN ('template', 'added')) AS from_checkin,
            EXISTS (SELECT 1 FROM giniflow_lab_order_events e
                     WHERE e.lab_order_id = o.id AND e.track = 'sample') AS started,
            COALESCE((SELECT array_agg(t.test_name) FROM giniflow_lab_order_tests t
                       WHERE t.lab_order_id = o.id), '{}') AS tests
       FROM giniflow_lab_orders o
      WHERE o.visit_id = $1 AND o.urgency = 'today'
        AND o.sample_status NOT IN ('uploaded', 'reported')`,
    [visitId],
  );

  const idsOf = (o) =>
    o.kind === "lab"
      ? LAB_TEST_STEP_IDS
      : o.tests.map((n) => machineForTest(machines, n)?.id).filter(Boolean);
  const unbilled = (o) => (o.kind === "lab" ? !labBilled : idsOf(o).every((id) => !billed.has(id)));
  const removable = orders.filter(
    (o) =>
      o.from_checkin &&
      o.payment_status === "pending" &&
      Number(o.amount_paid) === 0 &&
      ["ordered", "payment_pending"].includes(o.sample_status) &&
      !o.started &&
      unbilled(o),
  );
  const kept = new Set(orders.filter((o) => !removable.includes(o)).flatMap(idsOf));

  const { rows: steps } = await client.query(
    `SELECT s.id, s.step_catalog_id, COALESCE(c.machine, FALSE) AS machine
       FROM giniflow_visit_steps s
       LEFT JOIN flow_step_catalog c ON c.id = s.step_catalog_id
      WHERE s.visit_id = $1 AND s.status = 'pending' AND s.source IN ('template', 'added')`,
    [visitId],
  );
  const stale = steps.filter(
    (s) =>
      isTestStep(s.step_catalog_id, s.machine) &&
      !billed.has(s.step_catalog_id) &&
      !kept.has(s.step_catalog_id),
  );

  if (removable.length) {
    await client.query(`DELETE FROM giniflow_lab_orders WHERE id = ANY($1::uuid[])`, [
      removable.map((o) => o.id),
    ]);
  }
  if (stale.length) {
    await client.query(`DELETE FROM giniflow_visit_steps WHERE id = ANY($1::uuid[])`, [
      stale.map((s) => s.id),
    ]);
  }
  return { removedSteps: stale.length, removedOrders: removable.length };
}
