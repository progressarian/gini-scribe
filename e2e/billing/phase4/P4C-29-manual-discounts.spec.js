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
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;
let autoBefore;
let ruleId;

const lineFor = (bill, itemId) => bill.lines.find((line) => line.service_item_id === itemId);

async function draftWith(label, itemIds) {
  const { visit } = await extraVisit(ids, label, { visitType: "Follow Up" });
  let bill = await bills.openDraft(visit, desk, db);
  for (const itemId of itemIds) bill = await bills.addLine(bill.id, { item_id: itemId }, desk, db);
  return bill;
}

const manualRows = (billId) =>
  query(
    `SELECT d.method, d.rule_id, d.code, d.taken_from, d.amount::float AS amount, d.applied_by
       FROM bill_line_discounts d JOIN bill_lines l ON l.id = d.bill_line_id
      WHERE l.bill_id = $1 AND d.method = 'manual' ORDER BY d.amount`,
    [billId],
  ).then((r) => r.rows);

async function call(method, url, data) {
  const api = await apiAs("reception");
  const response = await api[method](url, { data });
  const body = await response.json();
  await api.dispose();
  return { status: response.status(), body };
}

test.describe.serial("P4C-29 manual discounts on a line and on the whole bill", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    autoBefore = await autoConsultation(false);
  });

  test.afterAll(async () => {
    if (ruleId) await query(`UPDATE discount_rules SET is_active = FALSE WHERE id = $1`, [ruleId]);
    if (autoBefore !== undefined) await autoConsultation(autoBefore);
    await tearDown(ids);
  });

  test("1. a flat ₹ discount comes off that line only, and is stored as manual by whoever gave it", async () => {
    const bill = await draftWith("M1", [ids.dressing, ids.brace]);
    const brace = lineFor(bill, ids.brace);
    const after = await bills.setLineDiscount(
      bill.id,
      brace.id,
      { kind: "flat", value: 150, reason: "Staff family" },
      desk,
      db,
    );
    expect(lineFor(after, ids.brace).patient_payable).toBe(65000);
    expect(lineFor(after, ids.dressing).patient_payable).toBe(50000);
    expect(after.totals.discount).toBe(15000);
    expect(after.totals.payable).toBe(115000);
    expect(lineFor(after, ids.brace).manual_discount).toMatchObject({
      kind: "flat",
      value: 150,
      reason: "Staff family",
      by: USERS.reception.id,
    });
    expect(await manualRows(bill.id)).toEqual([
      {
        method: "manual",
        rule_id: null,
        code: null,
        taken_from: "bill",
        amount: 150,
        applied_by: USERS.reception.id,
      },
    ]);
    const audit = await one(
      `SELECT before, after FROM billing_audit
        WHERE entity = 'bill_lines' AND entity_id = $1 AND after ? 'manual_discount'
        ORDER BY id DESC LIMIT 1`,
      [brace.id],
    );
    expect(audit.before.manual_discount.kind).toBeNull();
    expect(audit.after.manual_discount).toMatchObject({ kind: "flat", reason: "Staff family" });
  });

  test("2. a percent discount, then clearing it with 0, puts the line back", async () => {
    const bill = await draftWith("M2", [ids.brace]);
    const brace = lineFor(bill, ids.brace);
    const tenth = await bills.setLineDiscount(
      bill.id,
      brace.id,
      { kind: "percent", value: 12.5 },
      desk,
      db,
    );
    expect(lineFor(tenth, ids.brace).patient_payable).toBe(70000);
    const cleared = await bills.setLineDiscount(
      bill.id,
      brace.id,
      { kind: "percent", value: 0 },
      desk,
      db,
    );
    expect(lineFor(cleared, ids.brace).patient_payable).toBe(80000);
    expect(lineFor(cleared, ids.brace).manual_discount).toBeNull();
    expect(await manualRows(bill.id)).toEqual([]);
  });

  test("3. the additional bill discount is shared across the lines in proportion", async () => {
    const bill = await draftWith("M3", [ids.dressing, ids.brace]);
    const after = await bills.setBillDiscount(bill.id, { kind: "percent", value: 10 }, desk, db);
    expect(after.manual_discount).toMatchObject({ kind: "percent", value: 10 });
    expect(lineFor(after, ids.dressing).patient_payable).toBe(45000);
    expect(lineFor(after, ids.brace).patient_payable).toBe(72000);
    expect(after.totals.discount).toBe(13000);
    expect(after.discounts).toEqual(
      expect.arrayContaining([expect.objectContaining({ method: "manual", amount: 13000 })]),
    );
    const flat = await bills.setBillDiscount(bill.id, { kind: "flat", value: 130 }, desk, db);
    expect(flat.totals.payable).toBe(117000);
  });

  test("4. manual discounts come on top of an automatic rule: rule, then line, then bill", async () => {
    ruleId = (
      await one(
        `INSERT INTO discount_rules (name, method, kind, value, service_item_ids, applies_per)
         VALUES ($1, 'auto', 'percent', 10, ARRAY[$2]::int[], 'line') RETURNING id`,
        [`P4C29 auto ${tag}`, ids.brace],
      )
    ).id;
    const bill = await draftWith("M4", [ids.brace]);
    expect(lineFor(bill, ids.brace).patient_payable).toBe(72000);
    const withLine = await bills.setLineDiscount(
      bill.id,
      lineFor(bill, ids.brace).id,
      { kind: "flat", value: 100 },
      desk,
      db,
    );
    expect(lineFor(withLine, ids.brace).patient_payable).toBe(62000);
    const withBill = await bills.setBillDiscount(bill.id, { kind: "percent", value: 50 }, desk, db);
    expect(lineFor(withBill, ids.brace).patient_payable).toBe(31000);
    await query(`UPDATE discount_rules SET is_active = FALSE WHERE id = $1`, [ruleId]);
  });

  test("5. a discount never takes a line below ₹0", async () => {
    const bill = await draftWith("M5", [ids.dressing]);
    const after = await bills.setLineDiscount(
      bill.id,
      lineFor(bill, ids.dressing).id,
      { kind: "flat", value: 9999 },
      desk,
      db,
    );
    expect(lineFor(after, ids.dressing).patient_payable).toBe(0);
    expect(after.totals.payable).toBe(0);
  });

  test("6. bad input is refused in words", async () => {
    const bill = await draftWith("M6", [ids.brace]);
    const line = lineFor(bill, ids.brace);
    const over = await call("post", `/api/billing/bills/${bill.id}/lines/${line.id}/discount`, {
      kind: "percent",
      value: 120,
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/more than 100%/);
    const noKind = await call("post", `/api/billing/bills/${bill.id}/discount`, { value: 50 });
    expect(noKind.status).toBe(400);
    const ok = await call("post", `/api/billing/bills/${bill.id}/discount`, {
      kind: "flat",
      value: "50",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.totals.payable).toBe(75000);
  });

  test("7. discarding unsaved changes takes back a discount given after the last save", async () => {
    const bill = await draftWith("M7", [ids.brace]);
    await bills.saveDraft(bill.id, desk, db);
    await bills.setLineDiscount(
      bill.id,
      lineFor(bill, ids.brace).id,
      { kind: "flat", value: 200 },
      desk,
      db,
    );
    await bills.setBillDiscount(bill.id, { kind: "percent", value: 5 }, desk, db);
    const back = await bills.discardDraft(bill.id, desk, db);
    expect(back.manual_discount).toBeNull();
    expect(lineFor(back, ids.brace).manual_discount).toBeNull();
    expect(back.totals.payable).toBe(80000);

    await bills.setLineDiscount(
      bill.id,
      lineFor(back, ids.brace).id,
      { kind: "flat", value: 200 },
      desk,
      db,
    );
    await bills.saveDraft(bill.id, desk, db);
    await bills.setBillDiscount(bill.id, { kind: "percent", value: 5 }, desk, db);
    const kept = await bills.discardDraft(bill.id, desk, db);
    expect(kept.manual_discount).toBeNull();
    expect(lineFor(kept, ids.brace).manual_discount).toMatchObject({ kind: "flat", value: 200 });
    expect(kept.totals.payable).toBe(60000);
  });

  test("8. the counter: a line discount typed inline, then an additional bill discount", async ({
    page,
  }) => {
    const bill = await draftWith("M8", [ids.dressing, ids.brace]);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await loginAs(page, "reception");
    const lines = page.getByRole("region", { name: "Bill lines" });
    await gotoReady(
      page,
      `/giniflow/station/reception?tab=bill&visit=${bill.visit_id}`,
      () => lines,
    );
    await lines.getByLabel(`Discount type for Ankle brace ${tag}`).selectOption("flat");
    const amount = lines.getByLabel(`Discount for Ankle brace ${tag}`);
    await amount.fill("150");
    await amount.press("Enter");
    await expect(lines.getByText("Discount ₹150 off · by")).toBeVisible();
    await expect(lines.getByText("−₹150")).toBeVisible();

    const box = page.getByRole("region", { name: "Discount codes" });
    await box.getByRole("button", { name: "+ Additional discount on the bill" }).click();
    await box.getByLabel("Discount %").fill("10");
    await box.getByRole("button", { name: "Apply discount" }).click();
    await expect(box.getByText(/Additional discount on the bill: 10% off/)).toBeVisible();
    const totals = page.getByRole("table", { name: "Totals" });
    await expect(totals).toContainText("₹1,035");
    await box.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(
      box.getByRole("button", { name: "+ Additional discount on the bill" }),
    ).toBeVisible();
    await expect(totals).toContainText("₹1,150");
  });
});
