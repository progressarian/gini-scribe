import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { desk, extraVisit, newTag, refused, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const billEdit = await import("../../../server/services/billing/billEdit.js");
const creditNotes = await import("../../../server/services/billing/creditNotes.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");
const { inTransaction } = await import("../../../server/services/billing/transaction.js");

const db = getPool();
const tag = newTag();
let ids;
let bill;

const lineOf = (current, itemId) => current.lines.find((line) => line.service_item_id === itemId);

test.describe.serial("E1 edit a final bill in place", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    const draft = await bills.openDraft(ids.visit, desk, db);
    for (const line of draft.lines) await bills.removeLine(draft.id, line.id, {}, desk, db);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const ready = await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    expect(ready.totals.payable).toBe(130000);
    await bills.clearHealthrayAndFinalise(
      draft.id,
      { version: ready.version, paid: { mode: "cash" } },
      desk,
      db,
    );
    bill = await bills.readBill(draft.id, db);
  });

  test.afterAll(async () => {
    await query(
      `UPDATE bills SET edit_started_at = NULL, edit_snapshot = NULL WHERE visit_id = $1`,
      [ids.visit],
    );
    await tearDown(ids);
  });

  test("1. a final bill is locked until Edit bill is chosen, and only billing desks may edit", async () => {
    expect(bill.status).toBe("final");
    expect(bill.editable).toBe(false);
    expect(bill.totals.paid).toBe(130000);
    await refused(
      bills.addLine(bill.id, { item_id: ids.hba1c }, desk, db),
      409,
      /choose Edit bill/,
      "adding to a final bill without editing",
    );
    expect(hasCapability("reception", CAPABILITIES.BILLING_EDIT_FINAL)).toBe(true);
    expect(hasCapability("admin", CAPABILITIES.BILLING_EDIT_FINAL)).toBe(true);
    expect(hasCapability("nurse", CAPABILITIES.BILLING_EDIT_FINAL)).toBe(false);
  });

  test("2. adding a service keeps the number and leaves the extra as due", async () => {
    const started = await billEdit.startEdit(bill.id, { version: bill.version }, desk, db);
    expect(started.editable).toBe(true);
    expect(started.editing).not.toBeNull();
    await refused(
      bills.cancelBill(bill.id, { reason: "test" }, desk, db),
      409,
      /being edited/,
      "cancelling while editing",
    );
    await refused(
      creditNotes.previewFinalDiscount(bill.id, { kind: "flat", value: 10, reason: "x" }),
      409,
      /being edited/,
      "discounting while editing",
    );
    const added = await bills.addLine(bill.id, { item_id: ids.hba1c }, desk, db);
    expect(added.totals.payable).toBe(155000);
    const preview = await billEdit.previewEdit(bill.id, db);
    expect(preview.added.map((line) => line.item_id)).toEqual([ids.hba1c]);
    expect(preview.due).toBe(25000);
    await refused(
      billEdit.saveEdit(bill.id, { version: added.version, reason: " " }, desk, db),
      400,
      /Say why/,
      "saving without a reason",
    );
    const saved = await billEdit.saveEdit(
      bill.id,
      { version: added.version, reason: "Patient asked for HbA1c after printing" },
      desk,
      db,
    );
    expect(saved).toMatchObject({ status: "final", bill_no: bill.bill_no, revision_no: 1 });
    expect(saved.editing).toBeNull();
    expect(saved.totals).toMatchObject({ payable: 155000, paid: 130000 });
    const revision = await one(
      `SELECT revision_no, reason, jsonb_array_length(before->'lines') AS before_lines,
              jsonb_array_length(after->'lines') AS after_lines
         FROM bill_revisions WHERE bill_id = $1`,
      [bill.id],
    );
    expect(revision).toMatchObject({ revision_no: 1, before_lines: 2, after_lines: 3 });
    const dues = await one(
      `SELECT count(*)::int AS n FROM bills WHERE id = $1 AND paid_amount < patient_payable`,
      [bill.id],
    );
    expect(dues.n).toBe(1);
    bill = saved;
  });

  test("3. lines already on the bill keep their price when the master price changes", async () => {
    await query(`UPDATE service_items SET base_price = 900 WHERE id = $1`, [ids.brace]);
    const started = await billEdit.startEdit(bill.id, { version: bill.version }, desk, db);
    const dressing = lineOf(started, ids.dressing);
    const changed = await bills.changeQuantity(bill.id, dressing.id, { quantity: 2 }, desk, db);
    expect(lineOf(changed, ids.brace).rate).toBe(80000);
    expect(changed.totals.payable).toBe(205000);
    const discarded = await billEdit.discardEdit(bill.id, { version: changed.version }, desk, db);
    expect(discarded.editing).toBeNull();
    expect(discarded.revision_no).toBe(1);
    expect(discarded.totals.payable).toBe(155000);
    expect(lineOf(discarded, ids.dressing).quantity).toBe(1);
    expect(discarded.lines.map((line) => line.service_item_id).sort()).toEqual(
      [ids.brace, ids.dressing, ids.hba1c].sort(),
    );
    bill = discarded;
  });

  test("4. the total can't drop below what was collected, and a discount can be changed", async () => {
    const started = await billEdit.startEdit(bill.id, { version: bill.version }, desk, db);
    await refused(
      bills.removeLine(bill.id, lineOf(started, ids.brace).id, {}, desk, db),
      409,
      /already been collected/,
      "removing below paid",
    );
    const discounted = await bills.setLineDiscount(
      bill.id,
      lineOf(started, ids.hba1c).id,
      { kind: "flat", value: 100, reason: "Staff discount" },
      desk,
      db,
    );
    expect(discounted.totals.payable).toBe(145000);
    const saved = await billEdit.saveEdit(
      bill.id,
      { version: discounted.version, reason: "Discount agreed at the counter" },
      desk,
      db,
    );
    expect(saved).toMatchObject({ revision_no: 2, bill_no: bill.bill_no });
    expect(saved.totals.payable).toBe(145000);
  });

  test("5. saving with no change closes the edit without a new revision", async () => {
    const current = await bills.readBill(bill.id, db);
    const started = await billEdit.startEdit(bill.id, { version: current.version }, desk, db);
    const saved = await billEdit.saveEdit(
      bill.id,
      { version: started.version, reason: "Opened by mistake" },
      desk,
      db,
    );
    expect(saved.revision_no).toBe(2);
    expect(saved.editing).toBeNull();
  });

  test("6. the printed bill says it is a revision, and an open edit prints as not final", async () => {
    const current = await bills.readBill(bill.id, db);
    expect(billPdf.revisionBannerHtml(current)).toContain("Revised bill — revision 2");
    const started = await billEdit.startEdit(bill.id, { version: current.version }, desk, db);
    expect(billPdf.revisionBannerHtml(started)).toContain("BEING EDITED");
    await billEdit.discardEdit(bill.id, { version: started.version }, desk, db);
  });

  test("7. a bill with a credit note can still be edited, and its refunded lines stay counted", async () => {
    const other = await extraVisit(ids, "Credited");
    const draft = await bills.openDraft(other.visit, desk, db);
    for (const line of draft.lines) await bills.removeLine(draft.id, line.id, {}, desk, db);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const ready = await bills.addLine(draft.id, { item_id: ids.dressing, quantity: 2 }, desk, db);
    await bills.clearHealthrayAndFinalise(
      draft.id,
      { version: ready.version, paid: { mode: "cash" } },
      desk,
      db,
    );
    const paid = await bills.readBill(draft.id, db);
    const payableBefore = paid.totals.payable;
    await inTransaction(
      (client) =>
        creditNotes.creditNoteIn(
          client,
          {
            billId: paid.id,
            lines: [
              { line_id: lineOf(paid, ids.brace).id, quantity: 1 },
              { line_id: lineOf(paid, ids.dressing).id, quantity: 1 },
            ],
          },
          desk,
        ),
      db,
    );
    const credited = await bills.readBill(paid.id, db);
    const started = await billEdit.startEdit(paid.id, { version: credited.version }, desk, db);
    expect(started.editing).not.toBeNull();
    expect(started.totals.payable).toBe(payableBefore);
    const dressing = lineOf(started, ids.dressing);
    await refused(
      bills.removeLine(paid.id, dressing.id, {}, desk, db),
      409,
      /refunded on credit note/,
      "removing a partly refunded line",
    );
    const added = await bills.addLine(paid.id, { item_id: ids.hba1c }, desk, db);
    expect(added.totals.payable).toBe(payableBefore + 25000);
    const saved = await billEdit.saveEdit(
      paid.id,
      { version: added.version, reason: "Test added after the refund" },
      desk,
      db,
    );
    expect(saved).toMatchObject({ revision_no: 1, bill_no: paid.bill_no });
    expect(saved.totals.payable).toBe(payableBefore + 25000);
  });
});
