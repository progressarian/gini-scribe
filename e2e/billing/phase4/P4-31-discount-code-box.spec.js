import { test, expect } from "@playwright/test";
import { getPool } from "../../helpers/db.mjs";
import { loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { fromPaise } from "../../../src/components/billing/format.js";
import { desk, discountCode, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");

const db = getPool();
const tag = newTag();
const CODE = `P4OFF${tag.toUpperCase()}`;
let ids;

const open = (page) =>
  gotoReady(page, `/giniflow/station/billing?visit=${ids.visit}`, () =>
    page.getByRole("region", { name: "Discount codes" }),
  );

const box = (page) => page.getByRole("region", { name: "Discount codes" });

const totalRow = (page, label) =>
  page
    .getByRole("region", { name: "Totals and payment" })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: label, exact: true }) })
    .getByRole("cell");

test.describe.serial("P4-31 discount code box", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await discountCode(ids, CODE, { kind: "percent", value: 10 });
    await discountCode(ids, null, {
      name: `P4 auto ${tag}`,
      method: "auto",
      kind: "percent",
      value: 5,
      service_item_ids: [ids.brace],
    });
    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await bills.addLine(ids.bill, { item_id: ids.consultNew }, desk, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. the totals update when a code is accepted", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    await expect(totalRow(page, "Discount")).toHaveText(fromPaise(0));

    await box(page).getByLabel("Discount code").fill(CODE);
    await box(page).getByRole("button", { name: "Apply code" }).click();

    await expect(box(page).getByText(`${CODE} applied`)).toBeVisible();
    const saved = await bills.readBill(ids.bill, db);
    expect(saved.totals.discount).toBe(15000);
    await expect(totalRow(page, "Discount")).toHaveText(fromPaise(saved.totals.discount));
    await expect(totalRow(page, "Patient payable")).toHaveText(fromPaise(saved.totals.payable));
  });

  test("2. an applied code is a chip that can be taken off again", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    const chips = box(page).getByRole("list", { name: "Codes on this bill" });
    await expect(chips.getByText(CODE)).toBeVisible();

    await chips.getByRole("button", { name: `Remove ${CODE}` }).click();
    await expect(chips.getByText(CODE)).toHaveCount(0);
    await expect(totalRow(page, "Discount")).toHaveText(fromPaise(0));
    expect((await bills.readBill(ids.bill, db)).codes).toEqual([]);
  });

  test("3. a refused code says why, in the server's words", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    await box(page).getByLabel("Discount code").fill(`NOPE${tag.toUpperCase()}`);
    await box(page).getByRole("button", { name: "Apply code" }).click();
    await expect(box(page).getByText(`NOPE${tag.toUpperCase()}`, { exact: false })).toBeVisible();
    await expect(totalRow(page, "Discount")).toHaveText(fromPaise(0));
    expect((await bills.readBill(ids.bill, db)).codes).toEqual([]);
  });

  test("4. an automatic discount is shown by name and cannot be removed", async ({ page }) => {
    await bills.addLine(ids.bill, { item_id: ids.brace }, desk, db);
    await loginAs(page, "reception");
    await open(page);
    const automatic = box(page).getByRole("list", { name: "Automatic discounts" });
    const saved = await bills.readBill(ids.bill, db);
    const auto = saved.discounts.find((entry) => entry.method === "auto");
    expect(auto).toBeTruthy();
    await expect(automatic.getByText(auto.name)).toBeVisible();
    await expect(automatic.getByRole("button")).toHaveCount(0);
  });

  test("5. there is no manual discount field anywhere on the counter", async ({ page }) => {
    await loginAs(page, "reception");
    await open(page);
    await expect(box(page).getByLabel("Discount code")).toHaveCount(1);
    await expect(box(page).getByRole("spinbutton")).toHaveCount(0);
    await expect(page.getByLabel(/discount amount/i)).toHaveCount(0);
    await expect(page.getByLabel(/manual discount/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /give discount/i })).toHaveCount(0);
  });
});
