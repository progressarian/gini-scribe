import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, labOrder, newTag, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const { rebillFinalBill } = await import("../../../server/services/billing/rebill.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.62", role: "admin" };
const REASON = "Duplicate line billed by mistake";
let ids;
let order;
let oldBill;
let extraLine;
let result;

const orderRow = () =>
  one(
    `SELECT payment_status, sample_status, amount_paid::float AS amount_paid
       FROM giniflow_lab_orders WHERE id = $1`,
    [order],
  );
const paymentsOf = (billId) =>
  query(
    `SELECT direction, mode, amount::float AS amount FROM payments
      WHERE bill_id = $1 ORDER BY received_at`,
    [billId],
  ).then((r) => r.rows);

test.describe.serial("P4C-62 an admin corrects a final bill paid in HealthRay", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    order = await labOrder(ids, [ids.hba1cName]);
    await query(`UPDATE giniflow_lab_orders SET amount_total = 250 WHERE id = $1`, [order]);
    await query(`UPDATE giniflow_lab_order_tests SET price = 250 WHERE lab_order_id = $1`, [order]);
    await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: order, testNames: [ids.hba1cName] },
      desk,
      db,
    );
    const draft = await bills.openDraft(ids.visit, desk, db);
    const withExtra = await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    extraLine = withExtra.lines.find((line) => line.service_item_id === ids.brace).id;
    await bills.clearHealthrayAndFinalise(draft.id, { version: withExtra.version }, desk, db);
    oldBill = await bills.readBill(draft.id, db);
    await query(`UPDATE giniflow_lab_orders SET sample_status = 'processing' WHERE id = $1`, [
      order,
    ]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the starting bill is final and fully paid in HealthRay", async () => {
    expect(oldBill.status).toBe("final");
    expect(await paymentsOf(oldBill.id)).toEqual([
      { direction: "in", mode: "healthray", amount: 1050 },
    ]);
    expect(await orderRow()).toMatchObject({ payment_status: "paid", amount_paid: 250 });
  });

  test("2. only an admin can correct it, and only with a reason", async () => {
    await refused(
      rebillFinalBill(oldBill.id, { reason: REASON }, desk, db),
      403,
      /Only an admin/,
      "desk correcting a bill",
    );
    await refused(
      rebillFinalBill(oldBill.id, { reason: " " }, admin, db),
      400,
      /Say why/,
      "no reason",
    );
  });

  test("3. correcting credits the old bill and re-bills the kept lines, paid in HealthRay", async () => {
    result = await rebillFinalBill(
      oldBill.id,
      { reason: REASON, drop_line_ids: [extraLine] },
      admin,
      db,
    );
    expect(result.refunded).toBe(105000);
    expect(await paymentsOf(result.credit_note_id)).toEqual([
      { direction: "out", mode: "healthray", amount: 1050 },
    ]);
    const fresh = result.bill;
    expect(fresh.id).not.toBe(oldBill.id);
    expect(fresh.status).toBe("final");
    expect(fresh.lines.map((line) => line.service_item_id)).toEqual([ids.hba1c]);
    expect(fresh.lines[0].lab_order_id).toBe(order);
    expect(await paymentsOf(fresh.id)).toEqual([
      { direction: "in", mode: "healthray", amount: 250 },
    ]);
    const listed = await bills.listVisitBills(ids.visit, db);
    expect(listed.find((b) => b.id === oldBill.id).replaced_by_bill_id).toBe(fresh.id);
    expect(listed.find((b) => b.id === fresh.id).replaced_by_bill_id).toBeNull();
  });

  test("4. the lab order stays paid and its sample keeps its place", async () => {
    expect(await orderRow()).toEqual({
      payment_status: "paid",
      sample_status: "processing",
      amount_paid: 250,
    });
  });

  test("5. the reason is on the refund, and a corrected bill can't be corrected twice", async () => {
    const request = await one(
      `SELECT status, reason, decided_by FROM billing_requests WHERE credit_note_id = $1`,
      [result.credit_note_id],
    );
    expect(request).toMatchObject({ status: "approved", decided_by: USERS.admin.id });
    expect(request.reason).toContain(REASON);
    await refused(
      rebillFinalBill(oldBill.id, { reason: REASON }, admin, db),
      409,
      /already has credit note/,
      "second correction",
    );
  });
});
