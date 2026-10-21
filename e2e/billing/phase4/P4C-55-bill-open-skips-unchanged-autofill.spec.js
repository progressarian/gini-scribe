import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  extraVisit,
  healthrayBill,
  HEALTHRAY_CONSULTATION,
  newTag,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";
import { db } from "../phase4b/p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { openDeskDraft } = await import("../../../server/services/billing/deskOpen.js");
const { listVisitBills, readBill } = await import("../../../server/services/billing/bills.js");

const tag = newTag();
let ids;
const ctx = { ...desk };

const autofilledAt = async (billId) =>
  (await one(`SELECT autofilled_at FROM bills WHERE id = $1`, [billId])).autofilled_at;

const lineNames = (bill) => bill.lines.map((l) => l.bill_name).sort();

test.describe.serial("P4C-55 opening a bill skips the auto-fill when nothing changed", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
  });
  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a second open with no changes reuses the draft without filling it again", async () => {
    const { visit } = await extraVisit(ids, "Same");
    const first = await openDeskDraft(visit, ctx, db);
    const filled = await autofilledAt(first.id);
    expect(filled).toBeTruthy();
    const second = await openDeskDraft(visit, ctx, db);
    expect(second.id).toBe(first.id);
    expect(lineNames(second)).toEqual(lineNames(first));
    expect(await autofilledAt(first.id)).toEqual(filled);
  });

  test("2. a changed HealthRay bill fills the draft again on the next open", async () => {
    const { visit, patient } = await extraVisit(ids, "Changed");
    const first = await openDeskDraft(visit, ctx, db);
    const filled = await autofilledAt(first.id);
    await healthrayBill(ids, patient, [
      HEALTHRAY_CONSULTATION,
      { desc: "Ankle brace", amount: 800, category: "procedure" },
    ]);
    await openDeskDraft(visit, ctx, db);
    expect(await autofilledAt(first.id)).not.toEqual(filled);
  });

  test("3. a new floor order fills the draft again", async () => {
    const { visit } = await extraVisit(ids, "Order");
    const first = await openDeskDraft(visit, ctx, db);
    const filled = await autofilledAt(first.id);
    const order = await one(
      `INSERT INTO giniflow_lab_orders (visit_id, urgency, payment_status, amount_total,
                                        sample_status, kind)
       VALUES ($1, 'today', 'pending', 250, 'payment_pending', 'lab') RETURNING id`,
      [visit],
    );
    await query(
      `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, $2, 250)`,
      [order.id, ids.hba1cName],
    );
    await openDeskDraft(visit, ctx, db);
    expect(await autofilledAt(first.id)).not.toEqual(filled);
  });

  test("4. after 10 minutes the draft is filled again even if nothing changed", async () => {
    const { visit } = await extraVisit(ids, "Stale");
    const first = await openDeskDraft(visit, ctx, db);
    await query(`UPDATE bills SET autofilled_at = NOW() - interval '11 minutes' WHERE id = $1`, [
      first.id,
    ]);
    const stale = await autofilledAt(first.id);
    await openDeskDraft(visit, ctx, db);
    expect(await autofilledAt(first.id)).not.toEqual(stale);
  });

  test("5. a billing master change fills every draft again", async () => {
    const { visit } = await extraVisit(ids, "Master");
    const first = await openDeskDraft(visit, ctx, db);
    const filled = await autofilledAt(first.id);
    await query(
      `INSERT INTO billing_audit (entity, entity_id, action, after) VALUES ('service_items', '0', 'update', '{}')`,
    );
    await openDeskDraft(visit, ctx, db);
    expect(await autofilledAt(first.id)).not.toEqual(filled);
  });

  test("6. visit bills and re-read return the same bill as the open", async () => {
    const { visit } = await extraVisit(ids, "Read");
    const opened = await openDeskDraft(visit, ctx, db);
    const [listed] = await listVisitBills(visit, db);
    const reread = await readBill(opened.id, db);
    expect(listed.id).toBe(opened.id);
    expect(lineNames(listed)).toEqual(lineNames(opened));
    expect(lineNames(reread)).toEqual(lineNames(opened));
    expect(reread.totals).toEqual(opened.totals);
  });
});
