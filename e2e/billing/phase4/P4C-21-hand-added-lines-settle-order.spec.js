import { spawnSync } from "node:child_process";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs } from "../../helpers/auth.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const aliases = await import("../../../server/services/billing/serviceItemAliases.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const counter = await import("../../../server/services/billing/counterPatients.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");

const db = getPool();
const tag = newTag();
const SCRIPT = path.join(repoRoot, "server", "scripts", "link-paid-lines-to-orders.mjs");
const visits = {};
const cat = {};
const items = {};
let ids;
let autoBefore;

const TESTS = {
  creatinine: { catalogue: "Creatinine", ordered: `P4 C21 CREATININE ${tag}`, price: 100 },
  hba1c: { catalogue: "HbA1c", ordered: `P4 C21 HBA1C ${tag}`, price: 200 },
  lipid: { catalogue: "Lipid Profile", ordered: `P4 C21 LIPID PROFILE ${tag}`, price: 300 },
  uacr: {
    catalogue: "UACR",
    ordered: `P4 C21 Microalbumin/Creatinine Ratio ${tag}`,
    alias: true,
    price: 400,
  },
  tsh: {
    catalogue: "TSH",
    ordered: `P4 C21 Thyroid Stimulating Hormone (P4 C21 TSH ${tag})*`,
    price: 500,
  },
};
const ALL = Object.keys(TESTS);

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

async function order(visitId, keys, money = {}) {
  const total = keys.reduce((sum, key) => sum + TESTS[key].price, 0);
  const made = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', $2, $3, $4, $5, 'lab') RETURNING id`,
    [
      visitId,
      money.status ?? "pending",
      total,
      money.paid ?? 0,
      money.status === "paid" ? "paid" : "payment_pending",
    ],
  );
  for (const key of keys) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [made.id, TESTS[key].ordered, TESTS[key].price],
    );
  }
  return made.id;
}

const orderRow = (id) =>
  one(
    `SELECT payment_status, sample_status, amount_total::float, amount_paid::float
       FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

const liveLines = (visitId) =>
  query(
    `SELECT l.id, l.service_item_id, l.source, l.lab_order_id, b.status AS bill_status
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live
      ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

const lineOf = async (visitId, key) =>
  (await liveLines(visitId)).find((line) => line.service_item_id === items[key]);

async function addByHand(billId, key) {
  const api = await apiAs("reception");
  const response = await api.post(`/api/billing/bills/${billId}/lines`, {
    data: { item_id: items[key] },
  });
  const body = await response.json();
  await api.dispose();
  expect(response.status(), JSON.stringify(body)).toBe(200);
  return body;
}

async function finaliseAndPay(billId) {
  const { owed } = await one(
    `SELECT (patient_payable - paid_amount)::float AS owed FROM bills WHERE id = $1`,
    [billId],
  );
  const draft = await bills.readBill(billId, db);
  const paid = owed
    ? await payments.takePayments(
        billId,
        { version: draft.version, mode: "cash", amount: owed },
        desk,
        db,
      )
    : draft;
  const final = await bills.finaliseBill(billId, { version: paid.version }, desk, db);
  expect(final.status).toBe("final");
  return paid;
}

const payOnDraft = async (billId, amount) => {
  const bill = await bills.readBill(billId, db);
  return payments.takePayments(billId, { version: bill.version, mode: "cash", amount }, desk, db);
};

const pendingAtReception = async (orderId) =>
  (await reception.getPaymentQueue(ids.day, db)).pending.some((o) => o.orderId === orderId);

const counterRow = async (label) => {
  const listed = await counter.counterPatients(ids.day, tag, new Date(), db);
  const name = `P4 ${label} ${tag}`;
  const rows = [...listed.toBill, ...listed.billed, ...listed.waiting];
  return {
    row: rows.find((r) => r.name === name),
    group: listed.toBill.some((r) => r.name === name) ? "toBill" : "other",
  };
};

function runScript(args) {
  assertTestDatabase(process.env.DATABASE_URL);
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.join(repoRoot, "server"),
    env: process.env,
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  expect(run.stdout).toContain("localhost:5435/gini_scribe_test");
  return run.stdout;
}

const fileOf = (label) => `F4${label}-${tag}`;

test.describe.serial("P4C-21 hand-added test lines settle their order", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    for (const key of ALL) {
      const test = TESTS[key];
      cat[key] = (
        await one(
          `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, $2, 'lab')
           RETURNING id`,
          [`P4 C21 ${test.catalogue} ${tag}`, test.price],
        )
      ).id;
      items[key] = (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
           VALUES ($1, $2, $3, $4, 'test', $5) RETURNING id`,
          [
            `P4-C21${key}-${tag}`,
            `C21 ${test.catalogue} ${tag}`,
            ids.subgroup,
            test.price,
            cat[key],
          ],
        )
      ).id;
      if (test.alias) await aliases.addAlias(items[key], { name: test.ordered }, desk, db);
    }
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
    for (const label of [
      "C21Shape",
      "C21Reception",
      "C21Cancelled",
      "C21Part",
      "C21Release",
      "C21Adopt",
      "C21Script",
      "C21Twice",
    ]) {
      visits[label] = await extraVisit(ids, label);
    }
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      await tearDown(ids);
    } finally {
      await closeOpenShifts();
      await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(
        () => {},
      );
    }
  });

  test("1. five tests with other spellings, added by hand, settle their order when paid", async () => {
    const { visit } = visits.C21Shape;
    const orderId = await order(visit, ALL);
    const draft = await bills.openDraft(visit, desk, db);
    expect(draft.lines).toEqual([]);
    for (const key of ALL) await addByHand(draft.id, key);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);

    const lines = await liveLines(visit);
    expect(lines).toHaveLength(6);
    for (const key of ALL) {
      expect(await lineOf(visit, key)).toMatchObject({
        source: "lab_order",
        lab_order_id: orderId,
      });
    }
    expect(lines.find((line) => line.service_item_id === ids.brace)).toMatchObject({
      source: "added",
      lab_order_id: null,
    });
    expect(await pendingAtReception(orderId)).toBe(true);

    const paid = await finaliseAndPay(draft.id);
    expect(paid.orders).toEqual([expect.objectContaining({ lab_order_id: orderId })]);
    expect(await orderRow(orderId)).toEqual({
      payment_status: "paid",
      sample_status: "paid",
      amount_total: 1500,
      amount_paid: 1500,
    });
    expect(await pendingAtReception(orderId)).toBe(false);
    const { row, group } = await counterRow("C21Shape");
    expect(row.hints.tests).toBe(0);
    expect(group).toBe("other");
  });

  test("2. a hand-added test with no matching order stays unlinked", async () => {
    const { visit } = visits.C21Shape;
    const open = await bills.openDraft(visit, desk, db);
    await bills.addLine(open.id, { item_id: ids.abi }, desk, db);
    const abi = (await liveLines(visit)).find((line) => line.service_item_id === ids.abi);
    expect(abi).toMatchObject({ source: "added", lab_order_id: null });
    await bills.deleteDraft(open.id, {}, desk, db);
  });

  test("3. an order already paid at reception is not linked, so nothing is paid twice", async () => {
    const { visit } = visits.C21Reception;
    const orderId = await order(visit, ["hba1c"], { status: "paid", paid: 200 });
    const draft = await bills.openDraft(visit, desk, db);
    await addByHand(draft.id, "hba1c");
    expect(await lineOf(visit, "hba1c")).toMatchObject({ source: "added", lab_order_id: null });
    await finaliseAndPay(draft.id);
    expect(await orderRow(orderId)).toMatchObject({ payment_status: "paid", amount_paid: 200 });
  });

  test("4. a cancelled order test, or a cancelled order, is not linked", async () => {
    const { visit } = visits.C21Cancelled;
    const orderId = await order(visit, ["hba1c", "creatinine"]);
    await query(
      `UPDATE giniflow_lab_order_tests SET status = 'cancelled'
        WHERE lab_order_id = $1 AND test_name = $2`,
      [orderId, TESTS.hba1c.ordered],
    );
    const gone = await order(visit, ["lipid"]);
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'cancelled' WHERE id = $1`, [gone]);
    const draft = await bills.openDraft(visit, desk, db);
    await addByHand(draft.id, "hba1c");
    await addByHand(draft.id, "lipid");
    await addByHand(draft.id, "creatinine");
    expect(await lineOf(visit, "hba1c")).toMatchObject({ source: "added", lab_order_id: null });
    expect(await lineOf(visit, "lipid")).toMatchObject({ source: "added", lab_order_id: null });
    expect(await lineOf(visit, "creatinine")).toMatchObject({
      source: "lab_order",
      lab_order_id: orderId,
    });
    await bills.deleteDraft(draft.id, {}, desk, db);
  });

  test("5. partly covered: the order is part paid, and a second hand line on the same draft joins it", async () => {
    const { visit } = visits.C21Part;
    const orderId = await order(visit, ["hba1c", "creatinine", "lipid"]);
    const draft = await bills.openDraft(visit, desk, db);
    await addByHand(draft.id, "hba1c");
    await payOnDraft(draft.id, 200);
    expect(await orderRow(orderId)).toMatchObject({
      payment_status: "part_paid",
      amount_paid: 200,
    });
    expect(await pendingAtReception(orderId)).toBe(true);

    await addByHand(draft.id, "creatinine");
    expect(await lineOf(visit, "creatinine")).toMatchObject({
      source: "lab_order",
      lab_order_id: orderId,
    });
    expect(await orderRow(orderId)).toMatchObject({ payment_status: "pending", amount_paid: 0 });

    await finaliseAndPay(draft.id);
    expect(await orderRow(orderId)).toMatchObject({
      payment_status: "part_paid",
      amount_total: 600,
      amount_paid: 300,
    });
    expect(await pendingAtReception(orderId)).toBe(true);
    const { row } = await counterRow("C21Part");
    expect(row.hints.tests).toBe(1);
  });

  test("6. removing the lines, or deleting the draft, releases the order", async () => {
    const { visit } = visits.C21Release;
    const orderId = await order(visit, ["hba1c", "creatinine"]);
    const draft = await bills.openDraft(visit, desk, db);
    await addByHand(draft.id, "hba1c");
    await addByHand(draft.id, "creatinine");
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    await payOnDraft(draft.id, 300);
    expect(await orderRow(orderId)).toMatchObject({ payment_status: "paid", amount_paid: 300 });

    const creatinine = await lineOf(visit, "creatinine");
    await bills.removeLine(draft.id, creatinine.id, { reason: "declined" }, desk, db);
    expect(await orderRow(orderId)).toMatchObject({
      payment_status: "part_paid",
      amount_paid: 200,
    });
    const hba1c = await lineOf(visit, "hba1c");
    await bills.removeLine(draft.id, hba1c.id, { reason: "declined" }, desk, db);
    expect(await orderRow(orderId)).toMatchObject({ payment_status: "pending", amount_paid: 0 });

    const { visit: other } = await extraVisit(ids, "C21Delete");
    const otherOrder = await order(other, ["hba1c"]);
    const second = await bills.openDraft(other, desk, db);
    await addByHand(second.id, "hba1c");
    expect(await lineOf(other, "hba1c")).toMatchObject({ lab_order_id: otherOrder });
    const deleted = await bills.deleteDraft(second.id, {}, desk, db);
    expect(deleted.deleted).toBe(true);
    const linked = await query(`SELECT 1 FROM bill_lines WHERE lab_order_id = $1`, [otherOrder]);
    expect(linked.rows).toEqual([]);
    expect(await orderRow(otherOrder)).toMatchObject({ payment_status: "pending", amount_paid: 0 });
    expect(await pendingAtReception(otherOrder)).toBe(true);
  });

  test("7. an unlinked hand line on the draft is taken over when the order is raised later", async () => {
    const { visit } = visits.C21Adopt;
    const draft = await bills.openDraft(visit, desk, db);
    await addByHand(draft.id, "hba1c");
    expect(await lineOf(visit, "hba1c")).toMatchObject({ source: "added", lab_order_id: null });
    const orderId = await order(visit, ["hba1c"]);
    const raised = await visitLines.linesForOrder(
      visit,
      { labOrderId: orderId, testNames: [TESTS.hba1c.ordered] },
      desk,
      db,
    );
    expect(raised.added).toEqual([TESTS.hba1c.ordered]);
    const lines = await liveLines(visit);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: "lab_order", lab_order_id: orderId });
    await bills.deleteDraft(draft.id, {}, desk, db);
  });

  test("8. the repair script links paid lines: dry run changes nothing, --apply settles the order", async () => {
    const { visit } = visits.C21Script;
    const draft = await bills.openDraft(visit, desk, db);
    await addByHand(draft.id, "hba1c");
    await addByHand(draft.id, "tsh");
    await finaliseAndPay(draft.id);
    const orderId = await order(visit, ["hba1c", "tsh"]);
    expect(await lineOf(visit, "hba1c")).toMatchObject({ source: "added", lab_order_id: null });

    const twice = visits.C21Twice.visit;
    const other = await bills.openDraft(twice, desk, db);
    await addByHand(other.id, "hba1c");
    await finaliseAndPay(other.id);
    await order(twice, ["hba1c"]);
    await order(twice, ["hba1c"]);

    const dry = runScript([`--date=${ids.day}`, `--file=${fileOf("C21Script")}`]);
    expect(dry).toContain("Mode: dry run");
    expect(dry).toContain("Lines linked to their test order: 2");
    expect(dry).toContain(
      `order ${orderId}: pending (₹0.00 of ₹700.00) → paid (₹700.00 of ₹700.00)`,
    );
    expect(await lineOf(visit, "hba1c")).toMatchObject({ source: "added", lab_order_id: null });
    expect(await orderRow(orderId)).toMatchObject({ payment_status: "pending", amount_paid: 0 });

    const refusedRun = runScript([`--file=${fileOf("C21Twice")}`, "--apply"]);
    expect(refusedRun).toContain("Lines linked to their test order: 0");
    expect(refusedRun).toContain("Refused — ambiguous, left unlinked: 1");
    expect(await lineOf(twice, "hba1c")).toMatchObject({ source: "added", lab_order_id: null });

    const applied = runScript([`--date=${ids.day}`, `--file=${fileOf("C21Script")}`, "--apply"]);
    expect(applied).toContain("Saved.");
    for (const key of ["hba1c", "tsh"]) {
      expect(await lineOf(visit, key)).toMatchObject({
        source: "lab_order",
        lab_order_id: orderId,
      });
    }
    expect(await orderRow(orderId)).toMatchObject({ payment_status: "paid", amount_paid: 700 });
    expect(await pendingAtReception(orderId)).toBe(false);

    const again = runScript([`--file=${fileOf("C21Script")}`]);
    expect(again).toContain("Lines linked to their test order: 0");
  });
});
