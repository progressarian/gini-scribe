import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { fromPaise } from "../../../src/components/billing/format.js";
import {
  billStatusText,
  paymentRuleText,
} from "../../../src/components/billing/counter/lineText.js";
import { desk, labOrder, newTag, payRule, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
let ids;
let finalBill;

const open = (page) =>
  gotoReady(page, `/giniflow/station/billing?visit=${ids.visit}`, () =>
    page.getByRole("table", { name: "Bill lines" }),
  );

const lineRows = (page) =>
  page.getByRole("table", { name: "Bill lines" }).locator("tbody").getByRole("row");

test.describe.serial("P4-29 previous bills and lines", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.pensioner, { name: "pensioner pays nothing", patient_pays: "nothing" });

    const first = await bills.openDraft(ids.visit, desk, db);
    await bills.addLine(first.id, { item_id: ids.consultNew }, desk, db);
    await bills.setCategory(first.id, { category: ids.pensioner }, desk, db);
    const ready = await bills.readBill(first.id, db);
    finalBill = await bills.finaliseBill(first.id, { version: ready.version }, desk, db);

    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.dressing, quantity: 2 }, desk, db);
    await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);
    await labOrder(ids, [ids.looseName]);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the table matches the server's priced lines", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    const bill = await bills.readBill(ids.bill, db);
    await expect(lineRows(page)).toHaveCount(bill.lines.length);
    for (const [index, line] of bill.lines.entries()) {
      const cells = lineRows(page).nth(index).getByRole("cell");
      await expect(cells.nth(0)).toHaveText(line.bill_name);
      await expect(cells.nth(1)).toHaveText(line.bill_code || "—");
      await expect(cells.nth(2)).toHaveText(String(line.quantity));
      await expect(cells.nth(3)).toHaveText(fromPaise(line.actual));
      await expect(cells.nth(4)).toHaveText(fromPaise(line.discount));
      await expect(cells.nth(5)).toHaveText(paymentRuleText(line.payment_rule));
      await expect(cells.nth(6)).toHaveText(fromPaise(line.patient_payable));
    }
  });

  test("2. the earlier bill is listed with its number, totals and print", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    const row = page
      .getByRole("table", { name: "Earlier bills" })
      .getByRole("row")
      .filter({ hasText: finalBill.bill_no });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("cell").nth(1)).toHaveText(billStatusText(finalBill.status));
    await expect(row.getByRole("cell").nth(2)).toHaveText(fromPaise(finalBill.totals.actual));
    await expect(row.getByRole("cell").nth(4)).toHaveText(fromPaise(finalBill.totals.payable));
    await expect(row.getByRole("link", { name: /Print/ })).toHaveAttribute(
      "href",
      new RegExp(`/api/billing/bills/${finalBill.id}/bill.pdf`),
    );
  });

  test("3. an ordered test nobody can bill yet is named", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    const panel = page.getByRole("region", { name: "Ordered tests with no price" });
    await expect(panel.getByText(ids.looseName)).toBeVisible();
  });

  test("4. the quantity is editable only on items that allow it", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    const dressing = lineRows(page).filter({ hasText: `Dressing ${tag}` });
    const brace = lineRows(page).filter({ hasText: `Ankle brace ${tag}` });
    await expect(dressing.getByRole("spinbutton")).toHaveCount(1);
    await expect(brace.getByRole("spinbutton")).toHaveCount(0);

    await dressing.getByRole("spinbutton").fill("3");
    await dressing.getByRole("spinbutton").blur();
    await expect(dressing.getByRole("cell").nth(3)).toHaveText(fromPaise(150000));
    const saved = await bills.readBill(ids.bill, db);
    expect(saved.lines.find((l) => l.bill_name.includes("Dressing")).quantity).toBe(3);
  });

  test("5. a line is removed with a reason", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    await lineRows(page)
      .filter({ hasText: `Ankle brace ${tag}` })
      .getByRole("button", { name: "Remove" })
      .click();
    await page.getByLabel("Why is this line being removed?").fill("Returned at the counter");
    await page.getByRole("button", { name: "Remove line" }).click();
    await expect(lineRows(page).filter({ hasText: `Ankle brace ${tag}` })).toHaveCount(0);
    const saved = await bills.readBill(ids.bill, db);
    expect(saved.lines.map((l) => l.bill_name).join(" ")).not.toContain("Ankle brace");
  });
});
