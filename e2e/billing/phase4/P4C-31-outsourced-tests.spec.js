import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { apiAs, loginAs } from "../../helpers/auth.mjs";
import { gotoReady } from "../../helpers/browser.mjs";
import { openAddItems } from "../../helpers/addItems.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { desk, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const items = await import("../../../server/services/billing/serviceItems.js");
const billPdf = await import("../../../server/services/billing/billPdf.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.31", role: "admin" };
const LAUNCH_FAILED =
  /Could not find Chrom|Failed to launch|Browser was not found|Cannot find (module|package) 'puppeteer'|ENOENT/i;
let ids;

const abiName = () => `ABI ${tag}`;
const hba1cName = () => `HbA1c ${tag}`;

const hasPdfTools = (() => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function pdfText(billId) {
  let pdf;
  try {
    pdf = (await billPdf.generateBillPdf(billId, desk, db)).pdf;
  } catch (error) {
    if (!LAUNCH_FAILED.test(String(error?.message ?? error))) throw error;
    test.skip(true, "Chrome could not be launched here, so no PDF was rendered");
  }
  test.skip(!hasPdfTools, "pdftotext is not installed, so the PDF can't be read back");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4c31-"));
  try {
    const file = path.join(dir, "bill.pdf");
    fs.writeFileSync(file, pdf);
    return execFileSync("pdftotext", ["-layout", file, "-"]).toString();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const results = (page) =>
  page
    .getByRole("region", { name: "Add items" })
    .getByRole("list", { name: "Item search results" });

const itemsTable = (page) => page.getByRole("table", { name: "Items" });

const outsourcedOf = async (id) =>
  (await one(`SELECT is_outsourced FROM service_items WHERE id = $1`, [id])).is_outsourced;

test.describe.serial("P4C-31 outsourced tests", () => {
  test.describe.configure({ retries: 1 });

  test.beforeAll(async () => {
    ids = await setUp(tag);
    await items.updateItem(ids.abi, { is_outsourced: true }, admin, db);
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a test can be marked outsourced, and the change is audited", async () => {
    expect(await outsourcedOf(ids.abi)).toBe(true);
    expect(await outsourcedOf(ids.hba1c)).toBe(false);
    const audit = await one(
      `SELECT before->>'is_outsourced' AS was, after->>'is_outsourced' AS now
         FROM billing_audit
        WHERE entity = 'service_items' AND entity_id = $1::text AND action = 'update'
        ORDER BY id DESC LIMIT 1`,
      [String(ids.abi)],
    );
    expect(audit).toEqual({ was: "false", now: "true" });
  });

  test("2. only tests can be outsourced", async () => {
    const api = await apiAs("reception_admin");
    const refused = await api.patch(`/api/billing/master/items/${ids.brace}`, {
      data: { is_outsourced: true },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error).toMatch(/Only tests can be marked as outsourced/);
    expect(await outsourcedOf(ids.brace)).toBe(false);
    await api.dispose();
  });

  test("3. the items list filters to outsourced or in-house tests only", async () => {
    const api = await apiAs("reception_admin");
    const list = async (outsourced) =>
      (
        await (await api.get(`/api/billing/master/items?q=${tag}&outsourced=${outsourced}`)).json()
      ).items.map((item) => item.id);

    const outsourced = await list("true");
    expect(outsourced).toContain(ids.abi);
    expect(outsourced).not.toContain(ids.hba1c);

    const inhouse = await list("false");
    expect(inhouse).toContain(ids.hba1c);
    expect(inhouse).not.toContain(ids.abi);
    expect(inhouse).not.toContain(ids.brace);
    expect(inhouse).not.toContain(ids.consultNew);

    const all = (await (await api.get(`/api/billing/master/items?q=${tag}`)).json()).items;
    expect(all.find((item) => item.id === ids.abi).is_outsourced).toBe(true);
    expect((await api.get(`/api/billing/master/items?outsourced=maybe`)).status()).toBe(400);
    await api.dispose();
  });

  test("4. Settings shows the Lab column and filter", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/services", () => page.getByRole("region", { name: "Groups" }));
    await page.getByLabel("Search items").fill(tag);
    const table = itemsTable(page);
    await expect(table.getByRole("columnheader", { name: "Lab" })).toBeVisible();
    await expect(
      table.getByRole("row").filter({ hasText: abiName() }).getByRole("cell", {
        name: "Outsourced",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      table.getByRole("row").filter({ hasText: hba1cName() }).getByRole("cell", {
        name: "In-house",
        exact: true,
      }),
    ).toBeVisible();

    await page.getByLabel("Lab", { exact: true }).selectOption("outsourced");
    await expect(table.getByRole("row").filter({ hasText: abiName() })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: hba1cName() })).toHaveCount(0);

    await page.getByLabel("Lab", { exact: true }).selectOption("inhouse");
    await expect(table.getByRole("row").filter({ hasText: hba1cName() })).toHaveCount(1);
    await expect(table.getByRole("row").filter({ hasText: abiName() })).toHaveCount(0);
    await expect(table.getByRole("row").filter({ hasText: `Dressing ${tag}` })).toHaveCount(0);
  });

  test("5. the edit dialog ticks and unticks outsourced, for tests only", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/services", () => page.getByRole("region", { name: "Groups" }));
    await page.getByLabel("Search items").fill(tag);
    const dialog = page.getByRole("dialog");
    const box = dialog.getByRole("checkbox", { name: /Outsourced test/ });

    await page.getByRole("button", { name: `Edit ${hba1cName()}`, exact: true }).click();
    await expect(box).not.toBeChecked();
    await box.check();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => outsourcedOf(ids.hba1c)).toBe(true);
    await expect(
      itemsTable(page).getByRole("row").filter({ hasText: hba1cName() }).getByRole("cell", {
        name: "Outsourced",
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole("button", { name: `Edit ${hba1cName()}`, exact: true }).click();
    await expect(box).toBeChecked();
    await box.uncheck();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => outsourcedOf(ids.hba1c)).toBe(false);

    await page.getByRole("button", { name: `Edit Ankle brace ${tag}`, exact: true }).click();
    await expect(dialog.getByRole("checkbox", { name: /Outsourced test/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  });

  test("6. editing an outsourced test's price keeps it outsourced", async ({ page }) => {
    await loginAs(page, "reception_admin");
    await gotoReady(page, "/settings/services", () => page.getByRole("region", { name: "Groups" }));
    await page.getByLabel("Search items").fill(tag);
    await page.getByRole("button", { name: `Edit ${abiName()}`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Price (₹)", { exact: true }).fill("450");
    const reason = dialog.getByLabel(/Reason/);
    if (await reason.count()) await reason.fill("P4C-31 price check");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const row = await one(`SELECT base_price, is_outsourced FROM service_items WHERE id = $1`, [
      ids.abi,
    ]);
    expect(Number(row.base_price)).toBe(450);
    expect(row.is_outsourced).toBe(true);
  });

  test("7. the counter search and bill lines show the Outsourced badge", async ({ page }) => {
    const api = await apiAs("reception");
    const search = (await (await api.get(`/api/billing/items/search?q=${tag}`)).json()).items;
    expect(search.find((item) => item.id === ids.abi).is_outsourced).toBe(true);
    expect(search.find((item) => item.id === ids.hba1c).is_outsourced).toBe(false);
    await api.dispose();

    ids.bill = (await bills.openDraft(ids.visit, desk, db)).id;
    await loginAs(page, "reception");
    await gotoReady(page, `/giniflow/station/billing?visit=${ids.visit}`, () =>
      page.getByRole("region", { name: "Add items" }),
    );
    await openAddItems(page);
    await page.getByLabel("Search items").fill(tag);
    const abiResult = results(page).getByRole("listitem").filter({ hasText: abiName() });
    const hbResult = results(page).getByRole("listitem").filter({ hasText: hba1cName() });
    await expect(abiResult.getByText("Outsourced", { exact: true })).toBeVisible();
    await expect(hbResult.getByText("Outsourced", { exact: true })).toHaveCount(0);

    await bills.addLine(ids.bill, { item_id: ids.abi }, desk, db);
    await bills.addLine(ids.bill, { item_id: ids.hba1c }, desk, db);
    const read = await bills.readBill(ids.bill, db);
    expect(read.lines.find((line) => line.service_item_id === ids.abi).is_outsourced).toBe(true);
    expect(read.lines.find((line) => line.service_item_id === ids.hba1c).is_outsourced).toBe(false);

    await page.reload();
    const lines = page.getByRole("table").filter({ hasText: "Service / Test" }).first();
    const abiLine = lines.getByRole("row").filter({ hasText: abiName() });
    const hbLine = lines.getByRole("row").filter({ hasText: hba1cName() });
    await expect(abiLine.getByText("Outsourced", { exact: true })).toBeVisible();
    await expect(hbLine.getByText("Outsourced", { exact: true })).toHaveCount(0);
  });

  test("8. the printed bill marks outsourced lines only", async () => {
    const text = await pdfText(ids.bill);
    const lineOf = (name) => text.split("\n").find((row) => row.includes(name)) ?? "";
    expect(lineOf(abiName())).toContain("(Outsourced)");
    expect(lineOf(hba1cName())).not.toContain("(Outsourced)");
    expect(text.match(/\(Outsourced\)/g)).toHaveLength(1);
  });

  test("9. un-flagging the item drops the tag from the next print", async () => {
    await items.updateItem(ids.abi, { is_outsourced: false }, admin, db);
    const text = await pdfText(ids.bill);
    expect(text).not.toContain("(Outsourced)");
    await query(`UPDATE service_items SET is_outsourced = TRUE WHERE id = $1`, [ids.abi]);
  });
});
