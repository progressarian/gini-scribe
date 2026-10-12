import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const visitLines = await import("../../../server/services/billing/visitLines.js");
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const reports = await import("../../../server/services/billing/reports.js");
const carry = await import("../../../server/services/giniflow/carryOver.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");
const arrival = await import("../../../server/services/billing/arrivalBill.js");
const { counterPatients } = await import("../../../server/services/billing/counterPatients.js");

const db = getPool();
const tag = newTag();
let ids;

const TEST_PRICE = 100;

async function orderFor(visit, tests, urgency) {
  const order = await one(
    `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                      sample_status, kind)
     VALUES ($1, $2, 'pending', $3, 'payment_pending', 'lab') RETURNING id`,
    [visit, urgency, TEST_PRICE * tests.length],
  );
  for (const name of tests) {
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, $3)`,
      [order.id, name, TEST_PRICE],
    );
  }
  return order.id;
}

const liveLines = (visit) =>
  query(`SELECT service_item_id FROM bill_lines WHERE visit_id = $1 AND is_live`, [visit]).then(
    (r) => r.rows,
  );

async function earlierVisit(patient, daysAgo = 14) {
  return (
    await one(
      `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
       VALUES ($1, $2::date - $3::int, 'exited') RETURNING id`,
      [patient, ids.day, daysAgo],
    )
  ).id;
}

async function billedOrder(visit, tests, urgency) {
  const order = await orderFor(visit, tests, "today");
  await visitLines.linesForOrder(visit, { labOrderId: order, testNames: tests }, desk, db);
  await query(`UPDATE giniflow_lab_orders SET urgency = $2 WHERE id = $1`, [order, urgency]);
  return order;
}

const inTx = async (work) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

async function counterRow(name) {
  const body = await counterPatients(ids.day, tag, new Date(), db);
  return [...body.toBill, ...body.billed, ...body.waiting].find((row) => row.name === name);
}

test.describe.serial("P4C-43 check in and bill in one step", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a test ordered for the next visit or tomorrow is not put on today's bill", async () => {
    const made = await extraVisit(ids, "Later", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const nextVisit = await orderFor(made.visit, [ids.hba1cName], "next_visit");
    const tomorrow = await orderFor(made.visit, [ids.abiName], "tomorrow");

    for (const [order, name] of [
      [nextVisit, ids.hba1cName],
      [tomorrow, ids.abiName],
    ]) {
      const result = await visitLines.linesForOrder(
        made.visit,
        { labOrderId: order, testNames: [name] },
        desk,
        db,
      );
      expect(result.added).toEqual([]);
    }
    expect((await visitLines.testsForDesk(made.visit, desk, db)).added).toEqual([]);
    expect(await liveLines(made.visit)).toEqual([]);
    expect((await counterRow(`P4 Later ${tag}`)).hints.tests).toBe(0);

    const today = await orderFor(made.visit, [ids.hba1cName], "today");
    const result = await visitLines.linesForOrder(
      made.visit,
      { labOrderId: today, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    expect(result.added).toEqual([ids.hba1cName]);
  });

  test("2. a payment made earlier or online is recorded on the bill, never in the drawer", async () => {
    const made = await extraVisit(ids, "Prepaid", { healthray: false });
    const draft = await bills.openDraft(made.visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const bill = await one(`SELECT version, patient_payable FROM bills WHERE id = $1`, [draft.id]);
    const taken = await payments.takePayments(
      draft.id,
      {
        version: bill.version,
        payments: [
          { mode: "prepaid", amount: Number(bill.patient_payable), reference: `UTR-${tag}` },
        ],
      },
      desk,
      db,
    );
    expect(taken.totals.outstanding).toBe(0);
    expect(taken.payments[0]).toMatchObject({
      mode: "prepaid",
      shift_id: null,
      reference: `UTR-${tag}`,
    });
    const run = await reports.runReport("collections", { from: ids.day, to: ids.day }, db);
    const modes = run.sections.find((part) => part.key === "modes");
    expect(modes.rows.some((row) => row.label === "Paid earlier / online")).toBe(true);
  });

  test("3. tests waiting from the last visit carry over by how they were billed", async () => {
    const made = await extraVisit(ids, "Carry", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const older = await earlierVisit(made.patient, 40);
    await orderFor(older, [ids.hba1cName], "next_visit");
    const last = await earlierVisit(made.patient, 14);
    const unbilled = await orderFor(last, [ids.hba1cName], "next_visit");
    const onDraft = await billedOrder(last, [ids.abiName], "next_visit");
    const paid = await orderFor(last, ["P4 Paid elsewhere"], "tomorrow");
    await query(`UPDATE giniflow_lab_orders SET payment_status = 'paid' WHERE id = $1`, [paid]);
    const drawn = await orderFor(last, [ids.hba1cName], "next_visit");
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'collected' WHERE id = $1`, [
      drawn,
    ]);
    await orderFor(last, [ids.hba1cName], "today");

    const offered = await carry.carryOverChoices(made.visit, db);
    expect(Object.fromEntries(offered.map((o) => [o.orderId, o.state]))).toEqual({
      [unbilled]: "unbilled",
      [onDraft]: "draft",
      [paid]: "paid",
    });

    const moved = await inTx((client) =>
      carry.carryOverIn(client, made.visit, [unbilled, onDraft, paid], desk),
    );
    expect(moved).toHaveLength(3);
    const orders = await query(
      `SELECT id, visit_id, urgency FROM giniflow_lab_orders WHERE id = ANY($1::uuid[])`,
      [[unbilled, onDraft, paid]],
    );
    expect(orders.rows.every((o) => o.visit_id === made.visit && o.urgency === "today")).toBe(true);
    const today = await query(
      `SELECT l.service_item_id FROM bill_lines l WHERE l.visit_id = $1 AND l.is_live`,
      [made.visit],
    );
    expect(today.rows.map((r) => r.service_item_id).sort()).toEqual([ids.abi, ids.hba1c].sort());
    expect(await liveLines(last)).toEqual([]);
    const events = await one(
      `SELECT count(*)::int AS n FROM giniflow_lab_order_events
        WHERE track = 'visit' AND status = 'carried_over' AND lab_order_id = ANY($1::uuid[])`,
      [[unbilled, onDraft, paid]],
    );
    expect(events.n).toBe(3);
    expect(await carry.carryOverChoices(made.visit, db)).toEqual([]);
  });

  test("4. a test still due on the last visit's bill, or another patient's, is not carried", async () => {
    const made = await extraVisit(ids, "CarryDue", { healthray: false });
    const last = await earlierVisit(made.patient, 7);
    const due = await billedOrder(last, [ids.abiName], "next_visit");
    const draft = await one(`SELECT id, version FROM bills WHERE visit_id = $1`, [last]);
    await payments.takePayments(
      draft.id,
      {
        version: draft.version,
        payments: [{ mode: "prepaid", amount: 100, reference: `UTR4-${tag}` }],
      },
      desk,
      db,
    );
    const [offer] = await carry.carryOverChoices(made.visit, db);
    expect(offer).toMatchObject({ orderId: due, state: "due" });
    await expect(
      inTx((client) => carry.carryOverIn(client, made.visit, [due], desk)),
    ).rejects.toMatchObject({ status: 409 });

    const stranger = await extraVisit(ids, "CarryOther", { healthray: false });
    await expect(
      inTx((client) => carry.carryOverIn(client, stranger.visit, [due], desk)),
    ).rejects.toMatchObject({ status: 409 });
  });

  test("5. the arrival bill shows the consultation and the carried tests, then collects it all at once", async () => {
    const made = await extraVisit(ids, "Arrive", { healthray: false });
    const last = await earlierVisit(made.patient, 10);
    const hba1c = await orderFor(last, [ids.hba1cName], "next_visit");
    const abi = await orderFor(last, [ids.abiName], "next_visit");

    await expect(
      arrival.commitArrivalBill(made.visit, { expectedTotal: 0 }, desk, db),
    ).rejects.toMatchObject({ status: 409 });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);

    const preview = await arrival.arrivalBillPreview(made.visit, {}, desk, db);
    expect(preview.lines.map((l) => l.itemId).sort()).toEqual(
      [ids.consultDoctorNew, ids.hba1c, ids.abi].sort(),
    );
    expect(preview.outstanding).toBe(265000);
    expect(await liveLines(made.visit)).toEqual([]);
    const skipped = await arrival.arrivalBillPreview(made.visit, { skip: [abi] }, desk, db);
    expect(skipped.outstanding).toBe(225000);

    await expect(
      arrival.commitArrivalBill(made.visit, { expectedTotal: 1 }, desk, db),
    ).rejects.toMatchObject({ code: "amount_changed" });
    expect(await liveLines(made.visit)).toEqual([]);

    const done = await arrival.commitArrivalBill(
      made.visit,
      {
        skip: [abi],
        expectedTotal: 225000,
        alreadyPaid: [{ itemId: ids.hba1c, source: "prepaid", reference: `UTR5-${tag}` }],
        mode: "card",
        reference: `ARR-${tag}`,
      },
      desk,
      db,
    );
    expect(done.status).toBe("final");
    expect(done.billNo).toBeTruthy();
    expect(done.payments).toEqual([
      { mode: "prepaid", amount: 25000 },
      { mode: "card", amount: 200000 },
    ]);
    const orders = await query(
      `SELECT id, visit_id, payment_status FROM giniflow_lab_orders WHERE id = ANY($1::uuid[])`,
      [[hba1c, abi]],
    );
    const byId = Object.fromEntries(orders.rows.map((o) => [o.id, o]));
    expect(byId[hba1c]).toMatchObject({ visit_id: made.visit, payment_status: "paid" });
    expect(byId[abi].visit_id).toBe(last);

    const again = await arrival.arrivalBillPreview(made.visit, { skip: [abi] }, desk, db);
    expect(again.outstanding).toBe(0);
    expect(again.lines).toEqual([]);
  });

  test("6. the stations API serves the arrival bill to the billing desk only", async () => {
    const made = await extraVisit(ids, "ArriveApi", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const url = `/api/giniflow/stations/reception/${made.visit}/arrival-bill`;
    const reception = await apiAs("reception");
    const preview = await (await reception.get(url)).json();
    expect(preview.outstanding).toBe(200000);
    const paid = await reception.post(url, {
      data: {
        expectedTotal: preview.outstanding,
        alreadyPaid: [{ itemId: ids.consultDoctorNew, source: "healthray" }],
      },
    });
    expect(paid.status()).toBe(200);
    expect((await paid.json()).status).toBe("final");
    await reception.dispose();

    const coordinator = await apiAs("coordinator");
    expect((await coordinator.get(url)).status()).toBe(403);
    await coordinator.dispose();
  });

  test("7. reception checks in and collects in one press, marking a carried test as paid earlier", async ({
    page,
  }) => {
    const made = await extraVisit(ids, "ArriveScreen", { healthray: false });
    const last = await earlierVisit(made.patient, 12);
    await orderFor(last, [ids.hba1cName], "next_visit");
    const name = `P4 ArriveScreen ${tag}`;

    await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
      route.fulfill({
        json: {
          date: ids.day,
          expected: [
            {
              visitId: made.visit,
              patientId: made.patient,
              name,
              fileNo: `F4ArriveScreen-${tag}`,
              age: 55,
              sex: "Male",
              phone: null,
              priority: "normal",
              slot: "10:30",
              minutesLate: null,
              bookingType: "New",
              walkIn: false,
              status: "booked",
              statusLabel: "Booked",
              assignedDoctorId: null,
              suggestedVisitTypeId: 991431,
            },
          ],
          onFloor: [],
          notComing: [],
          counts: { expected: 1, onFloor: 0, notComing: 0, onFloorHere: 0 },
          query: "",
          serverTime: new Date().toISOString(),
        },
      }),
    );
    await page.route("**/api/flow/visit-types**", (route) =>
      route.fulfill({ json: [{ id: 991431, name: `P4C43 Visit ${tag}`, for_online: false }] }),
    );
    await page.route("**/api/giniflow/journey/plan/991431", (route) =>
      route.fulfill({
        json: [
          {
            catalogId: 991432,
            name: "Vitals",
            role: "vitals",
            minutes: 5,
            included: true,
            source: "template",
          },
        ],
      }),
    );
    let checkedIn = 0;
    await page.route(`**/api/giniflow/stations/reception/${made.visit}/checkin`, async (route) => {
      checkedIn++;
      await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
        made.visit,
      ]);
      return route.fulfill({ json: { totalCount: 1, plannedTotalMin: 5, raised: null } });
    });

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await page
      .locator(".ar-row")
      .filter({ hasText: name })
      .getByRole("button", { name: "✓ Arrived" })
      .click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    const bill = panel.getByRole("region", { name: "Bill at arrival" });
    await expect(bill).toContainText(ids.hba1cName);
    await expect(bill).toContainText("from the last visit");
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,250");

    await bill.getByLabel(/^How HbA1c .* is paid$/).selectOption("prepaid");
    await expect(bill.getByRole("alert")).toContainText(
      "Enter the transaction ID or earlier receipt number for HbA1c",
    );
    await bill.getByLabel(/^HbA1c .* payment reference$/).fill(`UTR-${tag}`);
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,000");
    await bill.getByRole("radio", { name: "Card" }).check();
    const press = panel.getByRole("button", { name: "✓ Check in & collect ₹2,000" });
    await expect(press).toBeDisabled();
    await bill.getByLabel("Card reference").fill(`SCR-${tag}`);
    await press.click();

    await expect.poll(() => checkedIn).toBe(1);
    await expect(panel).toBeHidden();
    const paid = await query(
      `SELECT p.mode, p.amount::numeric AS amount, b.status FROM payments p
         JOIN bills b ON b.id = p.bill_id WHERE b.visit_id = $1 ORDER BY p.mode`,
      [made.visit],
    );
    expect(paid.rows.map((r) => [r.mode, Number(r.amount), r.status])).toEqual([
      ["card", 2000, "final"],
      ["prepaid", 250, "final"],
    ]);
  });

  test("8. a test the doctor orders after the arrival bill opens a new bill and waits in Pending bill", async ({
    page,
  }) => {
    const made = await extraVisit(ids, "Later2", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'with_doctor' WHERE id = $1`, [
      made.visit,
    ]);
    const preview = await arrival.arrivalBillPreview(made.visit, {}, desk, db);
    const first = await arrival.commitArrivalBill(
      made.visit,
      { expectedTotal: preview.outstanding, mode: "upi", reference: `U-${tag}` },
      desk,
      db,
    );
    expect(first.status).toBe("final");

    const order = await orderFor(made.visit, [ids.abiName], "today");
    await visitLines.linesForOrder(
      made.visit,
      { labOrderId: order, testNames: [ids.abiName] },
      desk,
      db,
    );
    const drafts = await query(
      `SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice'`,
      [made.visit],
    );
    expect(drafts.rows).toHaveLength(1);
    const row = await counterRow(`P4 Later2 ${tag}`);
    expect(row.group).toBe("toBill");
    expect(row.hints.tests).toBe(1);

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception?tab=bill", () =>
      page.getByRole("tab", { name: /^Bill/ }),
    );
    await expect(page.getByRole("tab", { name: "Bill", exact: true })).toHaveAccessibleDescription(
      /patients? with tests to bill/,
    );
    await expect(
      page.getByRole("complementary", { name: "Today's patients" }).getByRole("button", {
        name: /^Pending bill/,
      }),
    ).toBeVisible();
  });

  test("9. a split payment is taken as several payments, and only when it adds up", async () => {
    const made = await extraVisit(ids, "Split", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const preview = await arrival.arrivalBillPreview(made.visit, {}, desk, db);
    expect(preview.outstanding).toBe(200000);

    await expect(
      arrival.commitArrivalBill(
        made.visit,
        {
          expectedTotal: 200000,
          split: [
            { mode: "card", amount: 100000, reference: `C-${tag}` },
            { mode: "upi", amount: 50000, reference: `U-${tag}` },
          ],
        },
        desk,
        db,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      arrival.commitArrivalBill(
        made.visit,
        {
          expectedTotal: 200000,
          split: [
            { mode: "card", amount: 100000, reference: `C-${tag}` },
            { mode: "upi", amount: 100000 },
          ],
        },
        desk,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });

    const done = await arrival.commitArrivalBill(
      made.visit,
      {
        expectedTotal: 200000,
        split: [
          { mode: "card", amount: 120000, reference: `C-${tag}` },
          { mode: "upi", amount: 80000, reference: `U-${tag}` },
        ],
      },
      desk,
      db,
    );
    expect(done.status).toBe("final");
    const paid = await query(
      `SELECT p.mode, p.amount::numeric AS amount, p.reference FROM payments p
         JOIN bills b ON b.id = p.bill_id WHERE b.visit_id = $1 ORDER BY p.mode`,
      [made.visit],
    );
    expect(paid.rows.map((r) => [r.mode, Number(r.amount), r.reference])).toEqual([
      ["card", 1200, `C-${tag}`],
      ["upi", 800, `U-${tag}`],
    ]);
  });

  test("10. reception splits the amount between card and UPI on the check-in panel", async ({
    page,
  }) => {
    const made = await extraVisit(ids, "ArriveSplit", { healthray: false });
    const last = await earlierVisit(made.patient, 12);
    await orderFor(last, [ids.hba1cName], "next_visit");
    const name = `P4 ArriveSplit ${tag}`;

    await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
      route.fulfill({
        json: {
          date: ids.day,
          expected: [
            {
              visitId: made.visit,
              patientId: made.patient,
              name,
              fileNo: `F4ArriveSplit-${tag}`,
              age: 55,
              sex: "Male",
              phone: null,
              priority: "normal",
              slot: "10:30",
              minutesLate: null,
              bookingType: "New",
              walkIn: false,
              status: "booked",
              statusLabel: "Booked",
              assignedDoctorId: null,
              suggestedVisitTypeId: 991441,
            },
          ],
          onFloor: [],
          notComing: [],
          counts: { expected: 1, onFloor: 0, notComing: 0, onFloorHere: 0 },
          query: "",
          serverTime: new Date().toISOString(),
        },
      }),
    );
    await page.route("**/api/flow/visit-types**", (route) =>
      route.fulfill({ json: [{ id: 991441, name: `P4C43 Visit ${tag}`, for_online: false }] }),
    );
    await page.route("**/api/giniflow/journey/plan/991441", (route) =>
      route.fulfill({
        json: [
          {
            catalogId: 991442,
            name: "Vitals",
            role: "vitals",
            minutes: 5,
            included: true,
            source: "template",
          },
        ],
      }),
    );
    let checkedIn = 0;
    await page.route(`**/api/giniflow/stations/reception/${made.visit}/checkin`, async (route) => {
      checkedIn++;
      await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
        made.visit,
      ]);
      return route.fulfill({ json: { totalCount: 1, plannedTotalMin: 5, raised: null } });
    });

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await page
      .locator(".ar-row")
      .filter({ hasText: name })
      .getByRole("button", { name: "✓ Arrived" })
      .click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    const bill = panel.getByRole("region", { name: "Bill at arrival" });
    await expect(bill).toContainText(ids.hba1cName);
    await expect(bill).toContainText("from the last visit");
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,250");

    await bill.getByLabel(/^How HbA1c .* is paid$/).selectOption("prepaid");
    await bill.getByLabel(/^HbA1c .* payment reference$/).fill(`UTR-${tag}`);
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,000");
    await bill.getByRole("radio", { name: "Split" }).check();
    const split = bill.getByRole("group", { name: "Split payment" });
    await split.getByLabel("Part 1 paid by").selectOption("card");
    await split.getByLabel("Part 1 reference").fill(`SC-${tag}`);
    await split.getByLabel("Part 2 amount").fill("400");
    await expect(split.getByLabel("Part 1 amount")).toHaveValue("1600");
    await split.getByLabel("Part 2 amount").fill("2500");
    await expect(split.getByLabel("Part 1 amount")).toHaveValue("");
    await expect(split.getByRole("status")).toContainText("₹500 over");
    await expect(
      split.getByRole("checkbox", { name: /Keep the extra ₹500 as a deposit/ }),
    ).toBeVisible();
    await split.getByLabel("Part 1 amount").fill("1500");
    await split.getByLabel("Part 2 amount").fill("400");
    const press = panel.getByRole("button", { name: "✓ Check in & collect ₹2,000" });
    await split.getByLabel("Part 1 amount").fill("1500");
    await expect(split.getByLabel("Part 2 amount")).toHaveValue("500");
    await expect(press).toBeDisabled();
    await expect(bill.getByRole("alert")).toHaveText("Enter the UPI reference number for part 2.");
    await split.getByLabel("Part 2 reference").fill(`SU-${tag}`);
    await expect(split.getByRole("status")).toContainText("₹2,000 of ₹2,000 ✓");
    await expect(bill.getByRole("alert")).toHaveCount(0);
    await press.click();

    await expect.poll(() => checkedIn).toBe(1);
    await expect(panel).toBeHidden();
    const paid = await query(
      `SELECT p.mode, p.amount::numeric AS amount, b.status FROM payments p
         JOIN bills b ON b.id = p.bill_id WHERE b.visit_id = $1 ORDER BY p.mode`,
      [made.visit],
    );
    expect(paid.rows.map((r) => [r.mode, Number(r.amount), r.status])).toEqual([
      ["card", 1500, "final"],
      ["prepaid", 250, "final"],
      ["upi", 500, "final"],
    ]);
  });
  test("11. cash needs an open shift: warned and blocked without one, taken into the drawer with one", async ({
    page,
  }) => {
    const made = await extraVisit(ids, "ArriveCash", { healthray: false });
    const last = await earlierVisit(made.patient, 12);
    await orderFor(last, [ids.hba1cName], "next_visit");
    const name = `P4 ArriveCash ${tag}`;

    await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
      route.fulfill({
        json: {
          date: ids.day,
          expected: [
            {
              visitId: made.visit,
              patientId: made.patient,
              name,
              fileNo: `F4ArriveCash-${tag}`,
              age: 55,
              sex: "Male",
              phone: null,
              priority: "normal",
              slot: "10:30",
              minutesLate: null,
              bookingType: "New",
              walkIn: false,
              status: "booked",
              statusLabel: "Booked",
              assignedDoctorId: null,
              suggestedVisitTypeId: 991451,
            },
          ],
          onFloor: [],
          notComing: [],
          counts: { expected: 1, onFloor: 0, notComing: 0, onFloorHere: 0 },
          query: "",
          serverTime: new Date().toISOString(),
        },
      }),
    );
    await page.route("**/api/flow/visit-types**", (route) =>
      route.fulfill({ json: [{ id: 991451, name: `P4C43 Visit ${tag}`, for_online: false }] }),
    );
    await page.route("**/api/giniflow/journey/plan/991451", (route) =>
      route.fulfill({
        json: [
          {
            catalogId: 991452,
            name: "Vitals",
            role: "vitals",
            minutes: 5,
            included: true,
            source: "template",
          },
        ],
      }),
    );
    let checkedIn = 0;
    await page.route(`**/api/giniflow/stations/reception/${made.visit}/checkin`, async (route) => {
      checkedIn++;
      await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
        made.visit,
      ]);
      return route.fulfill({ json: { totalCount: 1, plannedTotalMin: 5, raised: null } });
    });

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await page
      .locator(".ar-row")
      .filter({ hasText: name })
      .getByRole("button", { name: "✓ Arrived" })
      .click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    const bill = panel.getByRole("region", { name: "Bill at arrival" });
    await expect(bill).toContainText(ids.hba1cName);
    await expect(bill).toContainText("from the last visit");
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,250");

    await bill.getByLabel(/^How HbA1c .* is paid$/).selectOption("prepaid");
    await bill.getByLabel(/^HbA1c .* payment reference$/).fill(`UTR-${tag}`);
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,000");
    const press = panel.getByRole("button", { name: "✓ Check in & collect ₹2,000" });
    await expect(bill.getByRole("alert")).toContainText("Open your shift");
    await expect(press).toBeDisabled();

    const shift = await shifts.openShift({ opening_cash: 0 }, desk, db);
    try {
      await page.reload();
      await page
        .locator(".ar-row")
        .filter({ hasText: name })
        .getByRole("button", { name: "✓ Arrived" })
        .click();
      await bill.getByLabel(/^How HbA1c .* is paid$/).selectOption("prepaid");
      await bill.getByLabel(/^HbA1c .* payment reference$/).fill(`UTR-${tag}`);
      await bill.getByRole("radio", { name: "Split" }).check();
      const split = bill.getByRole("group", { name: "Split payment" });
      await split.getByLabel("Part 1 amount").fill("1200");
      await split.getByLabel("Part 2 amount").fill("800");
      await split.getByLabel("Part 2 reference").fill(`CU-${tag}`);
      await expect(bill.getByText("Open your shift")).toHaveCount(0);
      await press.click();
      await expect.poll(() => checkedIn).toBe(1);
      await expect(panel).toBeHidden();
      const cash = await one(
        `SELECT p.shift_id FROM payments p JOIN bills b ON b.id = p.bill_id
          WHERE b.visit_id = $1 AND p.mode = 'cash'`,
        [made.visit],
      );
      expect(cash.shift_id).toBe(shift.id);
    } finally {
      await shifts.closeShift(shift.id, { counted_cash: 1200 }, desk, db);
    }
  });

  test("12. extra paid in a split is kept as the patient's deposit, only when ticked", async () => {
    const made = await extraVisit(ids, "Extra", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const split = [
      { mode: "card", amount: 200000, reference: `XC-${tag}` },
      { mode: "upi", amount: 50000, reference: `XU-${tag}` },
    ];
    await expect(
      arrival.commitArrivalBill(made.visit, { expectedTotal: 200000, split }, desk, db),
    ).rejects.toMatchObject({ status: 409 });

    const done = await arrival.commitArrivalBill(
      made.visit,
      { expectedTotal: 200000, split, extraToDeposit: true },
      desk,
      db,
    );
    expect(done.status).toBe("final");
    expect(done.deposited).toBe(50000);
    const onBill = await query(
      `SELECT p.mode, p.amount::numeric AS amount FROM payments p
         JOIN bills b ON b.id = p.bill_id WHERE b.visit_id = $1`,
      [made.visit],
    );
    expect(onBill.rows.map((r) => [r.mode, Number(r.amount)])).toEqual([["card", 2000]]);
    const deposit = await one(
      `SELECT mode, amount::numeric AS amount, reference FROM payments
        WHERE deposit_patient_id = $1`,
      [made.patient],
    );
    expect([deposit.mode, Number(deposit.amount), deposit.reference]).toEqual([
      "upi",
      500,
      `XU-${tag}`,
    ]);
    const account = await one(
      `SELECT balance::numeric AS balance FROM deposit_accounts WHERE patient_id = $1`,
      [made.patient],
    );
    expect(Number(account.balance)).toBe(500);
  });

  test("13. services can be removed from and added to the arrival bill", async () => {
    const made = await extraVisit(ids, "EditBill", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    const changes = { add: [ids.dressing], remove: [ids.consultDoctorNew] };
    const preview = await arrival.arrivalBillPreview(made.visit, changes, desk, db);
    expect(preview.lines.map((l) => l.itemId)).toEqual([ids.dressing]);
    expect(preview.outstanding).toBe(50000);
    expect(await liveLines(made.visit)).toEqual([]);

    const done = await arrival.commitArrivalBill(
      made.visit,
      { ...changes, expectedTotal: 50000, mode: "card", reference: `E-${tag}` },
      desk,
      db,
    );
    expect(done.status).toBe("final");
    expect((await liveLines(made.visit)).map((l) => l.service_item_id)).toEqual([ids.dressing]);
  });

  test("14. reception removes a service and adds another from the check-in panel", async ({
    page,
  }) => {
    const made = await extraVisit(ids, "ArriveEdit", { healthray: false });
    const last = await earlierVisit(made.patient, 12);
    await orderFor(last, [ids.hba1cName], "next_visit");
    const name = `P4 ArriveEdit ${tag}`;

    await page.route("**/api/giniflow/stations/reception/arrivals**", (route) =>
      route.fulfill({
        json: {
          date: ids.day,
          expected: [
            {
              visitId: made.visit,
              patientId: made.patient,
              name,
              fileNo: `F4ArriveEdit-${tag}`,
              age: 55,
              sex: "Male",
              phone: null,
              priority: "normal",
              slot: "10:30",
              minutesLate: null,
              bookingType: "New",
              walkIn: false,
              status: "booked",
              statusLabel: "Booked",
              assignedDoctorId: null,
              suggestedVisitTypeId: 991461,
            },
          ],
          onFloor: [],
          notComing: [],
          counts: { expected: 1, onFloor: 0, notComing: 0, onFloorHere: 0 },
          query: "",
          serverTime: new Date().toISOString(),
        },
      }),
    );
    await page.route("**/api/flow/visit-types**", (route) =>
      route.fulfill({ json: [{ id: 991461, name: `P4C43 Visit ${tag}`, for_online: false }] }),
    );
    await page.route("**/api/giniflow/journey/plan/991461", (route) =>
      route.fulfill({
        json: [
          {
            catalogId: 991462,
            name: "Vitals",
            role: "vitals",
            minutes: 5,
            included: true,
            source: "template",
          },
        ],
      }),
    );
    let checkedIn = 0;
    await page.route(`**/api/giniflow/stations/reception/${made.visit}/checkin`, async (route) => {
      checkedIn++;
      await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
        made.visit,
      ]);
      return route.fulfill({ json: { totalCount: 1, plannedTotalMin: 5, raised: null } });
    });

    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception", () =>
      page.getByRole("tab", { name: /^Arrivals/ }),
    );
    await page
      .locator(".ar-row")
      .filter({ hasText: name })
      .getByRole("button", { name: "✓ Arrived" })
      .click();
    const panel = page.getByRole("dialog", { name: "Check in" });
    const bill = panel.getByRole("region", { name: "Bill at arrival" });
    await expect(bill).toContainText(ids.hba1cName);
    await expect(bill).toContainText("from the last visit");
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,250");

    await bill.getByLabel(/^How HbA1c .* is paid$/).selectOption("prepaid");
    await bill.getByLabel(/^HbA1c .* payment reference$/).fill(`UTR-${tag}`);
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹2,000");
    await bill.getByRole("button", { name: /^Remove Consultation/ }).click();
    await expect(bill.getByLabel("Removed from this bill")).toContainText("Consultation");
    await bill.getByLabel("Add a service").fill("Dressing");
    await bill.getByRole("button", { name: /^Add Dressing/ }).click();
    await expect(bill.getByRole("row", { name: /^Dressing/ })).toBeVisible();
    await expect(bill.getByRole("row", { name: /To collect now/ })).toContainText("₹500");
    await bill.getByRole("radio", { name: "Card" }).check();
    await bill.getByLabel("Card reference").fill(`ED-${tag}`);
    await panel.getByRole("button", { name: "✓ Check in & collect ₹500" }).click();

    await expect.poll(() => checkedIn).toBe(1);
    await expect(panel).toBeHidden();
    const paid = await query(
      `SELECT p.mode, p.amount::numeric AS amount, b.status FROM payments p
         JOIN bills b ON b.id = p.bill_id WHERE b.visit_id = $1 ORDER BY p.mode`,
      [made.visit],
    );
    expect(paid.rows.map((r) => [r.mode, Number(r.amount), r.status])).toEqual([
      ["card", 500, "final"],
      ["prepaid", 250, "final"],
    ]);
  });

  test("15. paid earlier / online is refused without a transaction ID or receipt number", async () => {
    const made = await extraVisit(ids, "NoRef", { healthray: false });
    await query(`UPDATE giniflow_visits SET current_status = 'checked_in' WHERE id = $1`, [
      made.visit,
    ]);
    await expect(
      arrival.commitArrivalBill(
        made.visit,
        {
          expectedTotal: 200000,
          alreadyPaid: [{ itemId: ids.consultDoctorNew, source: "prepaid" }],
        },
        desk,
        db,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const done = await arrival.commitArrivalBill(
      made.visit,
      {
        expectedTotal: 200000,
        alreadyPaid: [
          { itemId: ids.consultDoctorNew, source: "prepaid", reference: `UTR15-${tag}` },
        ],
      },
      desk,
      db,
    );
    const paid = await one(`SELECT p.mode, p.reference FROM payments p WHERE p.bill_id = $1`, [
      done.billId,
    ]);
    expect(paid).toEqual({ mode: "prepaid", reference: `UTR15-${tag}` });
  });
});
