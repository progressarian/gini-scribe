import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { closePdfViewer, expectPdfInViewer } from "../../helpers/pdfViewer.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { desk, extraVisit, newTag, setUp, tearDown } from "../phase4/p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const plans = await import("../../../server/services/billing/membershipPlans.js");
const shifts = await import("../../../server/services/billing/cashShifts.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.7.3", role: "admin" };
let ids;
let plan;
let edited;
let cardNo;

async function finalBill(visit, items) {
  const draft = await bills.openDraft(visit, desk, db);
  for (const line of draft.lines) await bills.removeLine(draft.id, line.id, {}, desk, db);
  let current = draft;
  for (const item of items) current = await bills.addLine(draft.id, { item_id: item }, desk, db);
  await bills.clearHealthrayAndFinalise(
    draft.id,
    { version: current.version, paid: { mode: "cash" } },
    desk,
    db,
  );
  return bills.readBill(draft.id, db);
}

const openVisit = (page, visit) =>
  gotoReady(page, `/giniflow/station/billing?visit=${visit}`, () =>
    page.getByRole("region", { name: "Bill actions" }),
  );

const actions = (page) => page.getByRole("region", { name: "Bill actions" });

test.describe.serial("E3 edit-bill and membership screens", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    ids.edit = await extraVisit(ids, "Edit");
    ids.family = await extraVisit(ids, "Fam");
    edited = await finalBill(ids.edit.visit, [ids.dressing]);
    plan = await plans.createPlan(
      {
        code: `S${tag}`.toUpperCase(),
        name: `Silver ${tag}`,
        price: 3000,
        consult_count: 1,
        dietitian_count: 0,
        lab_discount_pct: 10,
        lab_excludes_outsourced: false,
      },
      admin,
      db,
    );
  });

  test.afterAll(async () => {
    if (plan) {
      await query(
        `UPDATE bills SET membership_card_id = NULL WHERE membership_card_id IN
           (SELECT id FROM membership_cards WHERE plan_id = $1)`,
        [plan.id],
      );
      await query(
        `DELETE FROM membership_card_uses WHERE card_id IN
           (SELECT id FROM membership_cards WHERE plan_id = $1)`,
        [plan.id],
      );
      await query(`DELETE FROM membership_cards WHERE plan_id = $1`, [plan.id]);
    }
    await query(
      `UPDATE bills SET edit_started_at = NULL, edit_snapshot = NULL WHERE visit_id = ANY($1)`,
      [[ids.visit, ids.edit.visit, ids.family.visit]],
    );
    await tearDown(ids);
    if (plan) {
      await query(
        `DELETE FROM bill_line_discounts WHERE rule_id IN
           (SELECT id FROM discount_rules WHERE membership_plan_id = $1)`,
        [plan.id],
      );
      await query(`DELETE FROM discount_rules WHERE membership_plan_id = $1`, [plan.id]);
      await query(`DELETE FROM membership_plans WHERE id = $1`, [plan.id]);
      await query(`DELETE FROM bill_lines WHERE service_item_id = $1`, [plan.service_item_id]);
      await query(`DELETE FROM service_items WHERE id = $1`, [plan.service_item_id]);
    }
  });

  test("1. reception edits a printed bill, saves with a reason and reprints the same number", async ({
    page,
  }) => {
    await loginAs(page, "reception");
    await openVisit(page, ids.edit.visit);
    await page.getByRole("button", { name: `Open bill ${edited.bill_no}` }).click();
    await actions(page).getByRole("button", { name: "Edit bill" }).click();
    const bar = page.getByRole("group", { name: "Editing a final bill" });
    await expect(bar).toBeVisible();
    await expect(bar.getByRole("button", { name: "Save changes…" })).toBeDisabled();

    const quantity = page.getByLabel(`Quantity for Dressing ${tag}`);
    await quantity.fill("2");
    await quantity.press("Enter");
    await expect(quantity).toHaveValue("2");

    await bar.getByLabel(/Why is this bill being changed/).fill("Second dressing given");
    await bar.getByRole("button", { name: "Save changes…" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Due after saving")).toBeVisible();
    await expect(dialog.getByText("₹500", { exact: true }).first()).toBeVisible();
    await dialog.getByRole("button", { name: "Save and print" }).click();

    await expectPdfInViewer(page, `/bills/${edited.id}/bill.pdf`, `Bill ${edited.bill_no}`);
    await closePdfViewer(page);
    await expect(actions(page).getByText(/revision 1/)).toBeVisible();
    const saved = await one(
      `SELECT bill_no, revision_no, patient_payable::float AS payable FROM bills WHERE id = $1`,
      [edited.id],
    );
    expect(saved).toEqual({ bill_no: edited.bill_no, revision_no: 1, payable: 1000 });
  });

  test("2. the admin sees the plan in Settings › Membership plans", async ({ page }) => {
    await loginAs(page, "admin");
    await gotoReady(page, "/settings/membership-plans", () =>
      page.getByRole("table", { name: "Membership plans" }),
    );
    const row = page.getByRole("row", { name: new RegExp(`Silver ${tag}`) });
    await expect(row).toContainText("₹3,000");
    await expect(row).toContainText("10%");
    await page.getByRole("button", { name: "+ New plan" }).click();
    const form = page.getByRole("dialog", { name: "New membership plan" });
    await form.getByRole("button", { name: "Add plan" }).click();
    await expect(form.getByText(/Enter the plan's name/)).toBeVisible();
    await form.getByRole("button", { name: "Cancel" }).click();
  });

  test("3. reception sells a card, then a family member's bill uses it", async ({ page }) => {
    await loginAs(page, "reception");
    await openVisit(page, ids.visit);
    const box = page.getByRole("region", { name: "Membership card" });
    await box.getByLabel("Sell a membership card").selectOption(String(plan.id));
    await box.getByRole("button", { name: "Add plan to bill" }).click();
    await expect(page.getByRole("table", { name: "Bill lines" })).toContainText(`Silver ${tag}`);

    const draft = await one(
      `SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft' AND bill_type = 'invoice'`,
      [ids.visit],
    );
    const current = await bills.readBill(draft.id, db);
    const kept = current.lines.filter((line) => line.service_item_id !== plan.service_item_id);
    for (const line of kept) await bills.removeLine(draft.id, line.id, {}, desk, db);
    const fresh = await bills.readBill(draft.id, db);
    await bills.clearHealthrayAndFinalise(
      draft.id,
      { version: fresh.version, paid: { mode: "cash" } },
      desk,
      db,
    );
    cardNo = (await one(`SELECT card_no FROM membership_cards WHERE plan_id = $1`, [plan.id]))
      .card_no;

    const famDraft = await bills.openDraft(ids.family.visit, desk, db);
    for (const line of famDraft.lines) await bills.removeLine(famDraft.id, line.id, {}, desk, db);
    await bills.addLine(famDraft.id, { item_id: ids.consultNew }, desk, db);
    await bills.addLine(famDraft.id, { item_id: ids.hba1c }, desk, db);

    await openVisit(page, ids.family.visit);
    const famBox = page.getByRole("region", { name: "Membership card" });
    await famBox.getByLabel("Use someone else's card").fill(cardNo);
    await famBox.getByRole("button", { name: new RegExp(`Use card ${cardNo}`) }).click();
    await expect(famBox.getByText(/1 of 1 consultations left/)).toBeVisible();
    const lines = page.getByRole("table", { name: "Bill lines" });
    await expect(lines.getByText("Covered by membership")).toBeVisible();
  });

  test("4. the Memberships desk tab finds the card and shows its history", async ({ page }) => {
    await loginAs(page, "reception");
    await gotoReady(page, "/giniflow/station/reception?tab=memberships", () =>
      page.getByRole("region", { name: "Membership cards" }),
    );
    await page.getByLabel("Find a card").fill(cardNo);
    await page.getByRole("button", { name: `Open card ${cardNo}` }).click();
    const detail = page.getByRole("region", { name: `Membership card ${cardNo}` });
    await expect(detail).toContainText(`Silver ${tag}`);
    await expect(detail).toContainText("Nothing has been used on this card yet.");
  });

  test("5. a bigger discount on a paid bill is given back as a credit note, refunded in cash", async ({
    page,
  }) => {
    const visit = await extraVisit(ids, "Disc");
    const draft = await bills.openDraft(visit.visit, desk, db);
    for (const line of draft.lines) await bills.removeLine(draft.id, line.id, {}, desk, db);
    await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing, quantity: 3 }, desk, db);
    const discounted = await bills.setBillDiscount(
      draft.id,
      { kind: "percent", value: 10 },
      desk,
      db,
    );
    await bills.clearHealthrayAndFinalise(
      draft.id,
      { version: discounted.version, paid: { mode: "upi", upi_app: "icici" } },
      desk,
      db,
    );
    const paid = await bills.readBill(draft.id, db);
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]);
    await shifts.openShift({ opening_cash: 1000 }, desk, db);

    await loginAs(page, "reception");
    await openVisit(page, visit.visit);
    await page.getByRole("button", { name: `Open bill ${paid.bill_no}` }).click();
    await actions(page).getByRole("button", { name: "Edit bill" }).click();
    const disc = page.getByRole("region", { name: "Discount codes" });
    await disc.getByRole("button", { name: "Change" }).click();
    await disc.getByLabel("Discount %").fill("20");
    await disc.getByRole("button", { name: "Apply discount" }).click();
    const alert = disc.getByRole("alert");
    await expect(alert).toContainText("₹2,070");
    await expect(alert).toContainText("₹1,840");
    await alert.getByRole("button", { name: "Give it as a credit note…" }).click();

    const finalForm = page.getByRole("group", { name: "Discount on this final bill" });
    await finalForm.getByRole("button", { name: "Review discount" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Already given")).toBeVisible();
    await expect(dialog.getByLabel(/Refund in cash now/)).toBeChecked();
    await dialog.getByRole("button", { name: "Give discount" }).click();
    await expect(finalForm.getByText(/₹230 refunded in cash/)).toBeVisible();

    const outs = await query(
      `SELECT p.mode, p.amount::float AS amount FROM payments p JOIN bills n ON n.id = p.bill_id
        WHERE n.original_bill_id = $1 AND p.direction = 'out'`,
      [paid.id],
    );
    expect(outs.rows).toEqual([{ mode: "cash", amount: 230 }]);
    const ins = await query(
      `SELECT mode, amount::float AS amount FROM payments WHERE bill_id = $1`,
      [paid.id],
    );
    expect(ins.rows).toEqual([{ mode: "healthray", amount: 2070 }]);
    await query(`DELETE FROM cash_shifts WHERE user_id = $1`, [USERS.reception.id]).catch(() => {});
  });
});
