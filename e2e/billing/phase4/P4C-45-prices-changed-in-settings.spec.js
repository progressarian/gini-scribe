import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  autoConsultation,
  desk,
  extraVisit,
  failure,
  newTag,
  payRule,
  setUp,
  subCategory,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let sub;
let rule;
let ruleName;

const stored = (billId) =>
  one(`SELECT patient_payable::float, claim_amount::float, version FROM bills WHERE id = $1`, [
    billId,
  ]);

async function twentyPercentDraft(label) {
  const { visit } = await extraVisit(ids, label, { healthray: false });
  const draft = await bills.openDraft(visit, desk, db);
  await bills.setCategory(draft.id, { category: sub }, desk, db);
  await bills.addLine(draft.id, { item_id: ids.hba1c }, desk, db);
  return { visit, billId: draft.id };
}

test.describe.serial("P4C-45 prices changed in Settings while a bill is a draft", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
    sub = await subCategory(ids, "Drift");
  });

  test.beforeEach(async () => {
    ruleName = `twenty ${Date.now()}`;
    rule = await payRule(ids, sub, {
      name: ruleName,
      patient_pays: "percent",
      patient_value: 20,
    });
  });

  test.afterEach(async () => {
    await query(`UPDATE category_payment_rules SET is_active = FALSE WHERE id = $1`, [rule]);
  });

  test.afterAll(async () => {
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. Finalise refuses with the new amount; opening the draft brings it up to date and says why", async () => {
    const { visit, billId } = await twentyPercentDraft("DriftOff");
    expect(await stored(billId)).toMatchObject({ patient_payable: 50, claim_amount: 200 });
    await query(`UPDATE category_payment_rules SET is_active = FALSE WHERE id = $1`, [rule]);

    const before = await stored(billId);
    const refusal = await failure(
      bills.finaliseBill(billId, { version: before.version, pay_later: true }, desk, db),
    );
    expect(refusal?.status).toBe(409);
    expect(refusal.code).toBe("prices_changed");
    expect(refusal.message).toContain("the patient now pays ₹250 (was ₹50)");
    expect(await stored(billId)).toMatchObject({ patient_payable: 50, version: before.version });

    const opened = await bills.openDraft(visit, desk, db);
    expect(opened.price_changes).toMatchObject({
      before: { payable: 5000, claim: 20000 },
      after: { payable: 25000, claim: 0 },
    });
    expect(opened.price_changes.lines).toHaveLength(1);
    expect(opened.price_changes.lines[0]).toMatchObject({ before: 5000, after: 25000 });
    expect(opened.price_changes.lines[0].reasons).toEqual([
      `"P4 ${ruleName} ${tag}" was switched off in Settings`,
      "The patient now pays the full amount",
    ]);
    expect(await stored(billId)).toMatchObject({ patient_payable: 250, claim_amount: 0 });

    const audit = await one(
      `SELECT after ->> 'reason' AS reason FROM billing_audit
        WHERE entity = 'bills' AND entity_id = $1 AND after ? 'price_changes'`,
      [billId],
    );
    expect(audit.reason).toBe("Prices changed in Settings");

    const again = await bills.openDraft(visit, desk, db);
    expect(again.price_changes).toBeNull();
  });

  test("2. a bill whose prices did not change opens with no notice and finalises as before", async () => {
    const { visit, billId } = await twentyPercentDraft("DriftSame");
    const opened = await bills.openDraft(visit, desk, db);
    expect(opened.price_changes).toBeNull();
    const paid = await payments.takePayments(
      billId,
      { version: opened.version, mode: "upi", amount: 50, reference: "UPI1234" },
      desk,
      db,
    );
    const final = await bills.finaliseBill(billId, { version: paid.version }, desk, db);
    expect(final.status).toBe("final");
    expect(final.totals.payable).toBe(5000);
  });

  test("3. money already taken above the new amount leaves the bill as it is and says so", async () => {
    const { visit, billId } = await twentyPercentDraft("DriftTaken");
    await query(`UPDATE category_payment_rules SET is_active = FALSE WHERE id = $1`, [rule]);
    await bills.openDraft(visit, desk, db);
    const full = await bills.readBill(billId, db);
    await payments.takePayments(
      billId,
      { version: full.version, mode: "card", amount: 250, reference: "1234" },
      desk,
      db,
    );
    rule = await payRule(ids, sub, { name: `nothing ${Date.now()}`, patient_pays: "nothing" });

    const opened = await bills.openDraft(visit, desk, db);
    expect(opened.price_changes.after.payable).toBe(0);
    expect(opened.price_changes.blocked).toContain("₹250 has already been taken");
    expect(await stored(billId)).toMatchObject({ patient_payable: 250 });
  });

  test("4. the counter shows what changed and why", async ({ page }) => {
    const { visit } = await twentyPercentDraft("DriftUi");
    await query(`UPDATE category_payment_rules SET is_active = FALSE WHERE id = $1`, [rule]);
    await loginAs(page, "reception");
    const notice = () => page.getByRole("status", { name: "Prices changed" });
    await gotoReady(page, `/giniflow/station/reception?tab=bill&visit=${visit}`, notice);
    await expect(notice()).toContainText("Prices changed since this bill was made");
    await expect(notice()).toContainText("Patient pays ₹250 (was ₹50)");
    await expect(notice()).toContainText("was switched off in Settings");
    await expect(notice()).toContainText("The patient now pays the full amount");
    await notice().getByRole("button", { name: "Got it" }).click();
    await expect(notice()).toHaveCount(0);
  });
});
