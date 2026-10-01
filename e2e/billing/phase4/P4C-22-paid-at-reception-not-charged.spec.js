import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  newTag,
  setUp,
  subCategory,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const labCaseLines = await import("../../../server/services/billing/labCaseLines.js");
const counter = await import("../../../server/services/billing/counterPatients.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");

const db = getPool();
const tag = newTag();
const RECEPTION = "/giniflow/station/reception";
const REASON = "Paid at reception";
const visits = {};
const items = {};
let ids;
let autoBefore;
let labCaseBefore;

const TESTS = {
  hba1c: 350,
  lipid: 450,
  tsh: 300,
  cbc: 200,
  creatinine: 150,
  uacr: 500,
  vitd: 352,
};
const SEVEN = Object.keys(TESTS);
const nameOf = (key) => `P4 C22 ${key.toUpperCase()} ${tag}`;
const itemName = (key) => `C22 ${key} ${tag}`;
const totalOf = (keys) => keys.reduce((sum, key) => sum + TESTS[key], 0);

const closeOpenShifts = () =>
  query(
    `UPDATE cash_shifts
        SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
            difference = 0
      WHERE closed_at IS NULL AND user_id = $1`,
    [USERS.reception.id],
  );

async function order(visitId, keys) {
  const made = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      amount_paid, sample_status, kind)
     VALUES ($1, 'today', 'pending', $2, 0, 'payment_pending', 'lab') RETURNING id`,
    [visitId, totalOf(keys)],
  );
  for (const key of keys) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [made.id, nameOf(key), TESTS[key]],
    );
  }
  return made.id;
}

const clear = (orderId, extra = {}) =>
  reception.clearPayment(
    orderId,
    { method: "paid", actorId: USERS.reception.id, confirmNotOnBill: true, ...extra },
    db,
  );

const orderRow = (id) =>
  one(
    `SELECT payment_status, amount_total::float, amount_paid::float, amount_claimed::float,
            claim_state
       FROM giniflow_lab_orders WHERE id = $1`,
    [id],
  );

const liveLines = (visitId) =>
  query(
    `SELECT l.id, l.service_item_id, l.source, l.lab_order_id, l.bill_id, b.status AS bill_status
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.is_live
      ORDER BY l.line_no`,
    [visitId],
  ).then((r) => r.rows);

const itemsOn = async (visitId) => (await liveLines(visitId)).map((line) => line.service_item_id);

async function call(method, url, data) {
  const api = await apiAs("reception");
  const response = await api[method](url, data === undefined ? undefined : { data });
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

const openAtDesk = async (visitId) => {
  const opened = await call("post", `/api/billing/visits/${visitId}/bills`, {});
  expect(opened.status, JSON.stringify(opened.body)).toBe(200);
  return opened.body;
};

const rereadAtDesk = async (billId) => {
  const read = await call("get", `/api/billing/bills/${billId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body;
};

const paidAt = async (visitId) => {
  const read = await call("get", `/api/billing/paid-at-reception?visit_id=${visitId}`);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  return read.body;
};

const removedAudit = (billId) =>
  query(
    `SELECT before ->> 'service_item_id' AS item, after ->> 'reason' AS reason
       FROM billing_audit
      WHERE entity = 'bill_lines' AND action = 'delete' AND before ->> 'bill_id' = $1`,
    [billId],
  ).then((r) => r.rows);

async function payAndFinalise(billId) {
  const draft = await bills.readBill(billId, db);
  const owed = draft.totals.payable - draft.totals.paid;
  const paid = owed
    ? await payments.takePayments(
        billId,
        { version: draft.version, mode: "cash", amount: owed / 100 },
        desk,
        db,
      )
    : draft;
  return bills.finaliseBill(billId, { version: paid.version }, desk, db);
}

async function sevenOnADraft(visitId) {
  const draft = await bills.openDraft(visitId, desk, db);
  await bills.addLine(draft.id, { item_id: ids.consultNew }, desk, db);
  const orderId = await order(visitId, SEVEN);
  const raised = await visitLines.linesForOrder(
    visitId,
    { labOrderId: orderId, testNames: SEVEN.map(nameOf) },
    desk,
    db,
  );
  expect(raised.added).toHaveLength(7);
  await clear(orderId);
  return { billId: draft.id, orderId };
}

const counterRow = async (label) => {
  const listed = await counter.counterPatients(ids.day, tag, new Date(), db);
  const name = `P4 ${label} ${tag}`;
  const rows = [...listed.toBill, ...listed.billed, ...listed.waiting];
  return {
    row: rows.find((r) => r.name === name),
    toBill: listed.toBill.some((r) => r.name === name),
  };
};

const queueRow = async (orderId) => {
  const queue = await reception.getPaymentQueue(ids.day, db);
  return [...queue.pending, ...queue.awaitingSample, ...queue.cleared].find(
    (o) => o.orderId === orderId,
  );
};

test.describe.serial("P4C-22 paid at reception shown, not charged", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    labCaseBefore = (await one(`SELECT auto_add_lab_case_tests FROM billing_settings`))
      .auto_add_lab_case_tests;
    await query(`UPDATE billing_settings SET auto_add_lab_case_tests = TRUE`);
    for (const key of SEVEN) {
      const catalogId = (
        await one(
          `INSERT INTO giniflow_test_catalog (test_name, price, category) VALUES ($1, $2, 'lab')
           RETURNING id`,
          [nameOf(key), TESTS[key]],
        )
      ).id;
      items[key] = (
        await one(
          `INSERT INTO service_items (code, name, subgroup_id, base_price, kind, test_catalog_id)
           VALUES ($1, $2, $3, $4, 'test', $5) RETURNING id`,
          [`P4-C22${key}-${tag}`, itemName(key), ids.subgroup, TESTS[key], catalogId],
        )
      ).id;
    }
    await closeOpenShifts();
    ids.shift = (await shifts.openShift({ opening_cash: 0 }, desk, db)).id;
    for (const label of [
      "C22Shape",
      "C22Paths",
      "C22Part",
      "C22Claim",
      "C22Own",
      "C22Final",
      "C22Phone",
    ]) {
      visits[label] = await extraVisit(ids, label);
    }
  });

  test.afterAll(async () => {
    try {
      if (autoBefore !== undefined) await autoConsultation(autoBefore);
      if (labCaseBefore !== undefined) {
        await query(`UPDATE billing_settings SET auto_add_lab_case_tests = $1`, [labCaseBefore]);
      }
      await tearDown(ids);
    } finally {
      await closeOpenShifts();
      await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(
        () => {},
      );
    }
  });

  test("1. P_179901: opening the draft removes the 7 reception-paid tests; only the consultation is charged", async () => {
    const { visit } = visits.C22Shape;
    const { billId, orderId } = await sevenOnADraft(visit);
    const before = await bills.readBill(billId, db);
    expect(before.lines).toHaveLength(8);
    expect(before.lines.filter((line) => line.order_state === "paid_at_reception")).toHaveLength(7);

    const opened = await openAtDesk(visit);
    expect(opened.id).toBe(billId);
    expect(opened.lines.map((line) => line.service_item_id)).toEqual([ids.consultNew]);
    expect(opened.totals.payable).toBe(150000);
    const audit = await removedAudit(billId);
    expect(audit).toHaveLength(7);
    expect(audit.every((row) => row.reason === REASON)).toBe(true);

    const card = await paidAt(visit);
    expect(card.orders).toHaveLength(1);
    expect(card.orders[0]).toMatchObject({
      lab_order_id: orderId,
      paid: totalOf(SEVEN) * 100,
      still_due: 0,
      claim: null,
    });
    expect([...card.orders[0].tests].sort()).toEqual(SEVEN.map(nameOf).sort());
    expect(card.orders[0].paid_at).toBeTruthy();
    expect(card.total_paid).toBe(230200);

    const final = await payAndFinalise(billId);
    expect(final.status).toBe("final");
    expect(final.totals.payable).toBe(150000);
    expect(await orderRow(orderId)).toMatchObject({
      payment_status: "paid",
      amount_paid: totalOf(SEVEN),
    });
  });

  test("2. the Payments tab, the card and the Bill tab list agree", async () => {
    const { visit } = visits.C22Shape;
    const card = await paidAt(visit);
    const queued = await queueRow(card.orders[0].lab_order_id);
    expect(queued.paymentStatus).toBe("paid");
    expect(queued.collectible * 100).toBe(card.orders[0].still_due);
    expect(Math.round(queued.paid * 100)).toBe(card.orders[0].paid);
    const { row, toBill } = await counterRow("C22Shape");
    expect(row.hints.tests).toBe(0);
    expect(toBill).toBe(false);
  });

  test("3. every add path skips a test paid at reception: prefill, lab case, HealthRay, desk add", async () => {
    const { visit, patient } = visits.C22Paths;
    const orderId = await order(visit, ["hba1c", "lipid"]);
    await clear(orderId);
    await query(
      `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, patient_id,
                              test_names, case_date, case_status, raw_list_json)
       VALUES ($1, $1, $1, $2, $3, $4, $5::date, 'Registered', '{}'::jsonb)`,
      [`P4C22-${tag}`, 991000, patient, [nameOf("hba1c")], ids.day],
    );
    await query(
      `INSERT INTO giniflow_patient_bills (patient_id, bill_date, status, items)
       VALUES ($1, $2::date, 'billed', $3::jsonb)`,
      [
        patient,
        ids.day,
        JSON.stringify([
          { desc: itemName("hba1c"), amount: 350, category: "lab" },
          { desc: `Ankle brace ${tag}`, amount: 800, category: "procedure" },
        ]),
      ],
    );

    const opened = await openAtDesk(visit);
    expect(opened.lines).toEqual([]);
    const labCase = await labCaseLines.labCaseTestsForDesk(visit, desk, db);
    expect(labCase.added).toEqual([]);

    const explicit = await visitLines.linesForOrder(
      visit,
      { labOrderId: orderId, testNames: [nameOf("hba1c")] },
      desk,
      db,
    );
    expect(explicit.added).toEqual([]);
    expect(await itemsOn(visit)).toEqual([]);

    const healthray = await call("get", `/api/billing/healthray-bill-lines?bill_id=${opened.id}`);
    expect(healthray.status).toBe(200);
    expect(healthray.body.lines.map((line) => line.item_id)).toEqual([ids.brace]);

    const refusedAdd = await call("post", `/api/billing/bills/${opened.id}/lines`, {
      item_id: items.hba1c,
    });
    expect(refusedAdd.status).toBe(409);
    expect(refusedAdd.body.error).toBe(
      `${itemName("hba1c")} was already paid at reception — it's listed under Paid at reception and isn't charged on this bill`,
    );
    const other = await call("post", `/api/billing/bills/${opened.id}/lines`, {
      item_id: items.tsh,
    });
    expect(other.status).toBe(200);
    expect(await itemsOn(visit)).toEqual([items.tsh]);
  });

  test("4. part paid at reception: the card shows what is still due there, and the tests stay off the bill", async () => {
    const { visit } = visits.C22Part;
    const draft = await bills.openDraft(visit, desk, db);
    const orderId = await order(visit, ["hba1c", "lipid"]);
    await visitLines.linesForOrder(
      visit,
      { labOrderId: orderId, testNames: [nameOf("hba1c"), nameOf("lipid")] },
      desk,
      db,
    );
    expect(await itemsOn(visit)).toHaveLength(2);
    await clear(orderId, { amountPaid: 300 });

    const reread = await rereadAtDesk(draft.id);
    expect(reread.lines).toEqual([]);
    const card = await paidAt(visit);
    expect(card.orders[0]).toMatchObject({ paid: 30000, still_due: 50000 });
    expect(card.still_due).toBe(50000);
    const queued = await queueRow(orderId);
    expect(queued.paymentStatus).toBe("part_paid");
    expect(queued.collectible * 100).toBe(card.still_due);

    for (const key of ["hba1c", "lipid"]) {
      const refusedAdd = await call("post", `/api/billing/bills/${draft.id}/lines`, {
        item_id: items[key],
      });
      expect(refusedAdd.status).toBe(409);
      expect(refusedAdd.body.code ?? "paid_at_reception").toBe("paid_at_reception");
    }
    const { row } = await counterRow("C22Part");
    expect(row.hints.tests).toBe(0);
  });

  test("5. a claim at reception is listed with its insurer and never charged", async () => {
    const { visit } = visits.C22Claim;
    const orderId = await order(visit, ["tsh"]);
    await clear(orderId, { method: "insurance_claim", insurer: `Star Health ${tag}` });
    const draft = await bills.openDraft(visit, desk, db);
    const refusedAdd = await call("post", `/api/billing/bills/${draft.id}/lines`, {
      item_id: items.tsh,
    });
    expect(refusedAdd.status).toBe(409);
    expect(refusedAdd.body.error).toContain("has its insurance claim at reception");
    const card = await paidAt(visit);
    expect(card.orders[0]).toMatchObject({
      paid: 0,
      claim: { state: "submitted", amount: 30000, insurer: `Star Health ${tag}` },
      still_due: 0,
    });
    expect(card.total_claimed).toBe(30000);
  });

  test("6. an order paid only by this same bill stays billable", async () => {
    const { visit } = visits.C22Own;
    const orderId = await order(visit, ["hba1c", "cbc"]);
    const draft = await bills.openDraft(visit, desk, db);
    const first = await call("post", `/api/billing/bills/${draft.id}/lines`, {
      item_id: items.hba1c,
    });
    expect(first.status).toBe(200);
    const bill = await bills.readBill(draft.id, db);
    await payments.takePayments(
      draft.id,
      { version: bill.version, mode: "cash", amount: 350 },
      desk,
      db,
    );
    expect(await orderRow(orderId)).toMatchObject({ amount_paid: 350 });
    expect((await paidAt(visit)).orders).toEqual([]);

    const second = await call("post", `/api/billing/bills/${draft.id}/lines`, {
      item_id: items.cbc,
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const reread = await rereadAtDesk(draft.id);
    expect(reread.lines.map((line) => line.service_item_id)).toEqual([items.hba1c, items.cbc]);
    expect((await removedAudit(draft.id)).filter((row) => row.reason === REASON)).toEqual([]);
    const final = await payAndFinalise(draft.id);
    expect(final.status).toBe("final");
    expect(await orderRow(orderId)).toMatchObject({ payment_status: "paid", amount_paid: 550 });
  });

  test("7. a final bill is never touched", async () => {
    const { visit } = visits.C22Final;
    const later = await subCategory(ids, "Later", { allow_pay_later: true });
    const orderId = await order(visit, ["creatinine"]);
    const draft = await bills.openDraft(visit, desk, db);
    await bills.setCategory(draft.id, { category: later }, desk, db);
    await visitLines.linesForOrder(
      visit,
      { labOrderId: orderId, testNames: [nameOf("creatinine")] },
      desk,
      db,
    );
    const ready = await bills.readBill(draft.id, db);
    const final = await bills.finaliseBill(
      draft.id,
      { version: ready.version, pay_later: true },
      desk,
      db,
    );
    expect(final.status).toBe("final");
    await clear(orderId);

    const reread = await rereadAtDesk(draft.id);
    expect(reread.status).toBe("final");
    expect(reread.lines.map((line) => line.service_item_id)).toEqual([items.creatinine]);
    expect(reread.lines[0].order_state).toBe("paid_at_reception");
    expect(reread.version).toBe(final.version);
    expect(await removedAudit(draft.id)).toEqual([]);
  });

  test("8. the counter shows the Paid at reception card at phone width, and Finalise works", async ({
    page,
  }) => {
    const { visit } = visits.C22Phone;
    await sevenOnADraft(visit);
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, "reception");
    const card = () => page.getByRole("region", { name: "Paid at reception" });
    await gotoReady(page, `${RECEPTION}?tab=bill&visit=${visit}`, card);
    await expect(card()).toContainText(nameOf("hba1c"));
    await expect(card()).toContainText("₹2,302 · Paid");
    await expect(card()).toContainText("₹2,302 paid at reception — not part of this bill");
    await expect(card()).not.toContainText("still due");
    const lines = page.getByRole("region", { name: "Bill lines" });
    await expect(lines).toContainText(`Consultation New ${tag}`);
    await expect(lines).not.toContainText(itemName("hba1c"));
    await expect(lines).not.toContainText("Paid at reception");
    await expect(lines.getByRole("note")).toHaveCount(0);
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(wide).toBeLessThanOrEqual(1);
    const box = await card().boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(391);

    const draft = (await liveLines(visit))[0];
    const final = await payAndFinalise(draft.bill_id);
    expect(final.totals.payable).toBe(150000);
  });
});
