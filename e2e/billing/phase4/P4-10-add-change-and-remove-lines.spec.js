import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, newTag, refused, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;

test.describe.serial("P4-10 add, change and remove lines", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. an item is added by its id, and a wrong one is refused", async () => {
    const bill = await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
    expect(bill.lines).toHaveLength(1);
    expect(bill.lines[0]).toMatchObject({
      service_item_id: ids.dressing,
      line_no: 1,
      source: "added",
    });
    expect(bill.totals.payable).toBe(50000);
    await refused(
      bills.addLine(ids.bill, { item_id: 987654321 }, desk, db),
      404,
      /doesn't exist/,
      "an unknown item",
    );
    await refused(
      bills.addLine(ids.bill, { item_id: "soon" }, desk, db),
      400,
      /valid item/,
      "a bad item id",
    );
  });

  test("2. a deactivated item can't be added", async () => {
    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ids.brace]);
    await refused(
      bills.addLine(ids.bill, { item_id: ids.brace }, desk, db),
      409,
      /deactivated/,
      "a deactivated item",
    );
    await query(`UPDATE service_items SET is_active = TRUE WHERE id = $1`, [ids.brace]);
  });

  test("3. the quantity changes only on items that allow it, up to the maximum", async () => {
    const line = (await bills.readBill(ids.bill, db)).lines[0];
    const bill = await bills.changeQuantity(ids.bill, line.id, { quantity: 3 }, desk, db);
    expect(bill.lines[0].quantity).toBe(3);
    expect(bill.totals.payable).toBe(150000);
    await refused(
      bills.changeQuantity(ids.bill, line.id, { quantity: 4 }, desk, db),
      400,
      /at most 3/,
      "more than the maximum",
    );
    await refused(
      bills.changeQuantity(ids.bill, line.id, { quantity: 0 }, desk, db),
      400,
      /whole number from 1/,
      "a quantity of nothing",
    );
    const brace = await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);
    const braceLine = brace.lines.find((l) => l.service_item_id === ids.brace);
    await refused(
      bills.changeQuantity(ids.bill, braceLine.id, { quantity: 2 }, desk, db),
      400,
      /one at a time/,
      "a quantity on an item that doesn't allow one",
    );
    ids.line = line.id;
    ids.braceLine = braceLine.id;
  });

  test("4. every change reprices the bill and bumps the version", async () => {
    const before = await bills.readBill(ids.bill, db);
    expect(before.totals.payable).toBe(150000 + 80000);
    const after = await bills.changeQuantity(ids.bill, ids.line, { quantity: 2 }, desk, db);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.totals.payable).toBe(100000 + 80000);
    const stored = await one(
      `SELECT SUM(patient_payable)::numeric AS lines FROM bill_lines
        WHERE bill_id = $1 AND is_live`,
      [ids.bill],
    );
    expect(Number(stored.lines) * 100).toBe(after.totals.payable);
  });

  test("5. removing a line needs a reason, and is audited", async () => {
    await refused(
      bills.removeLine(ids.bill, ids.braceLine, {}, desk, db),
      400,
      /why/i,
      "a removal with no reason",
    );
    const bill = await bills.removeLine(
      ids.bill,
      ids.braceLine,
      { reason: "The patient did not take the brace" },
      desk,
      db,
    );
    expect(bill.lines).toHaveLength(1);
    expect(bill.totals.payable).toBe(100000);
    const { rows } = await query(
      `SELECT action, after FROM billing_audit WHERE entity = 'bill_lines' AND entity_id = $1 ORDER BY id`,
      [ids.braceLine],
    );
    expect(rows.at(-1)).toMatchObject({ action: "delete" });
    expect(rows.at(-1).after.reason).toMatch(/did not take/);
  });

  test("6. the lines are renumbered and nothing can be changed on a final bill", async () => {
    const two = await bills.addLine(ids.bill, { item_id: ids.hba1c }, desk, db);
    expect(two.lines.map((l) => l.line_no)).toEqual([1, 2]);
    const one = await bills.removeLine(ids.bill, ids.line, { reason: "Not done" }, desk, db);
    expect(one.lines.map((l) => l.line_no)).toEqual([1]);
    expect(one.lines[0].service_item_id).toBe(ids.hba1c);
    const bill = await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);
    expect(bill.lines.map((l) => l.line_no)).toEqual([1, 2]);
    await query(
      `UPDATE bills SET status = 'final', bill_no = $2, series = 'MAIN', fy = $3,
              finalised_at = NOW() WHERE id = $1`,
      [ids.bill, `P4/${tag}/000010`, ids.fy],
    );
    await refused(
      bills.addLine(ids.bill, { item_id: ids.hba1c }, desk, db),
      409,
      /already final/,
      "adding to a final bill",
    );
    await refused(
      bills.removeLine(ids.bill, bill.lines[0].id, { reason: "no" }, desk, db),
      409,
      /already final/,
      "removing from a final bill",
    );
  });
  test("7. the quantity rules are the bill's own, not the pricing engine's", async () => {
    const unit = `sitting ${tag}`;
    await query(`UPDATE service_items SET unit = $2 WHERE id = $1`, [ids.dressing, unit]);
    const draft = await bills.openDraft(ids.visit, desk, db);
    const added = await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const line = added.lines.find((l) => l.service_item_id === ids.dressing);
    const error = await refused(
      bills.changeQuantity(draft.id, line.id, { quantity: 4 }, desk, db),
      400,
      /can be billed at most 3 on one line/,
      "more than the maximum",
    );
    expect(error.message).not.toContain(unit);
    const after = await bills.readBill(draft.id, db);
    expect(after.lines[0].quantity).toBe(1);
    expect(after.version).toBe(added.version);
    await query(`UPDATE service_items SET unit = 'each' WHERE id = $1`, [ids.dressing]);
  });
});
