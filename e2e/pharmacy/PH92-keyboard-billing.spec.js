import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { financialYearOf } from "../../shared/billingVocab.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH92${Date.now().toString(36).toUpperCase()}`;
const PHONE = `97${String(Date.now()).slice(-8)}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

test.describe.configure({ mode: "serial" });

test.describe("PH92 keyboard-only billing at the pharmacy counter", () => {
  let admin;
  let pharmacist;
  let telsartan;
  let metformin;
  let walkin;
  let bill;

  const medicine = (name) =>
    admin
      .post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} ${name}`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
        },
      })
      .then((r) => r.json());

  const stockLine = (m, batch_no, days, qty_packs) => ({
    medicine_id: m.id,
    batch_no,
    expiry_date: dayOffset(days),
    qty_packs,
    purchase_rate: "20",
    gst_rate_pct: 12,
    mrp: "40",
    sale_rate: "35",
  });

  const savedLines = async () =>
    (await (await pharmacist.get(`/api/pharmacy/bills/${bill.id}`)).json()).lines;

  const search = (page) => page.getByRole("combobox", { name: "Add medicine" });
  const batchBox = (page, name) => page.getByRole("combobox", { name: `Batch for ${TAG} ${name}` });
  const entryQty = (page) =>
    page.getByRole("textbox", { name: "Quantity in strips for the new medicine" });
  const entryDisc = (page) => page.getByLabel("Discount % for the new medicine");

  const openBill = async (page) => {
    await loginAs(page, "pharmacy");
    await gotoReady(page, `/pharmacy/billing/${bill.id}`, () => search(page), { timeout: 30000 });
    await expect(search(page)).toBeFocused();
  };

  const typeMedicine = async (page, name) => {
    await page.keyboard.type(`${TAG} ${name}`);
    await expect(page.getByRole("option", { name: new RegExp(`${TAG} ${name}`) })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(batchBox(page, name)).toBeFocused();
  };

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    const fy = financialYearOf(dayOffset(0));
    for (const [series, prefix] of [
      ["PH", "PH/"],
      ["PHR", "PHR/"],
    ]) {
      const existing = await one(`SELECT 1 FROM bill_series WHERE series = $1 AND fy = $2`, [
        series,
        fy,
      ]);
      if (!existing) {
        await admin.put("/api/pharmacy/settings/series", {
          data: { series, fy, prefix, number_width: 6 },
        });
      }
    }
    telsartan = await medicine("Telsartan 40");
    metformin = await medicine("Metformin 500");
    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [
            stockLine(telsartan, "NEAR1", 10, 2),
            stockLine(telsartan, "FAR1", 400, 5),
            stockLine(metformin, "MF1", 400, 4),
          ],
        },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);

    const gone = await one(
      `INSERT INTO pharmacy_batches (medicine_id, batch_no, expiry_date, pack_size, mrp, sale_rate, gst_rate_pct)
       VALUES ($1, 'GONE1', $2, 10, 40, 35, 12) RETURNING id`,
      [telsartan.id, dayOffset(-3)],
    );
    const main = await one(`SELECT id FROM pharmacy_locations WHERE kind = 'main'`);
    await query(
      `INSERT INTO pharmacy_stock (location_id, batch_id, qty_units) VALUES ($1, $2, 20)`,
      [main.id, gone.id],
    );

    walkin = (
      await (
        await pharmacist.post("/api/pharmacy/bills/patients", {
          data: { name: `${TAG} Keyboard`, phone: PHONE },
        })
      ).json()
    ).patient;
    bill = await (
      await pharmacist.post("/api/pharmacy/bills", {
        data: { patient_id: walkin.id, sale_type: "walkin" },
      })
    ).json();
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("two medicines go on the bill with only the keyboard", async ({ page }) => {
    await openBill(page);
    await typeMedicine(page, "Telsartan 40");

    const options = page.getByRole("listbox", { name: `Batches of ${TAG} Telsartan 40` });
    await expect(options.getByRole("option").nth(0)).toContainText("GONE1");
    await expect(options.getByRole("option").nth(0)).toHaveAttribute("aria-disabled", "true");
    await expect(options.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowDown");
    await expect(options.getByRole("option").nth(2)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");

    await expect(entryQty(page)).toBeFocused();
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");
    await expect(entryDisc(page)).toBeFocused();
    await page.keyboard.type("10");
    await page.keyboard.press("Enter");
    await expect(search(page)).toBeFocused();

    await typeMedicine(page, "Metformin 500");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(search(page)).toBeFocused();

    const lines = await savedLines();
    expect(
      lines.map((l) => [l.batch_no, l.qty_units, Number(l.discount_pct), l.near_expiry_ok]),
    ).toEqual(
      expect.arrayContaining([
        ["FAR1", 30, 10, false],
        ["MF1", 10, 0, false],
      ]),
    );
    expect(lines).toHaveLength(2);
  });

  test("taking the near-expiry batch is the confirmation", async ({ page }) => {
    await openBill(page);
    await typeMedicine(page, "Telsartan 40");
    await expect(page.getByRole("option").filter({ hasText: "NEAR1" })).toContainText(
      "choosing confirms",
    );
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(search(page)).toBeFocused();
    const near = (await savedLines()).find((l) => l.batch_no === "NEAR1");
    expect(near).toMatchObject({ qty_units: 10, near_expiry_ok: true });
  });

  test("more than the batch holds is taken from the next batch, with one warning", async ({
    page,
  }) => {
    await openBill(page);
    await typeMedicine(page, "Telsartan 40");
    await page.keyboard.press("Enter");
    await page.keyboard.type("2");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    const notice = page.getByRole("status").filter({ hasText: "left in batch NEAR1" });
    await expect(notice).toContainText("Only 1 strip left in batch NEAR1");
    await expect(notice).toContainText("1 strip taken from batch FAR1");
    const lines = await savedLines();
    expect(lines.find((l) => l.batch_no === "NEAR1").qty_units).toBe(20);
    expect(lines.find((l) => l.batch_no === "FAR1").qty_units).toBe(40);

    await typeMedicine(page, "Metformin 500");
    await expect(notice).toBeHidden();
  });

  test("more than all the stock is refused and nothing is added", async ({ page }) => {
    await openBill(page);
    const before = await savedLines();
    await typeMedicine(page, "Telsartan 40");
    await page.keyboard.press("Enter");
    await page.keyboard.type("9");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("alert").filter({ hasText: "Only 1 strip in stock." }),
    ).toBeVisible();
    await expect(entryQty(page)).toBeFocused();
    expect(await savedLines()).toEqual(before);

    await page.keyboard.press("Escape");
    await expect(search(page)).toBeFocused();
    await expect(batchBox(page, "Telsartan 40")).toHaveCount(0);
  });

  test("a line's quantity is changed in place and Edit and Remove are reached with Tab", async ({
    page,
  }) => {
    await openBill(page);
    const qty = page.getByRole("textbox", {
      name: `Quantity in strips for ${TAG} Metformin 500 batch MF1`,
    });
    await qty.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await savedLines()).find((l) => l.batch_no === "MF1")?.qty_units)
      .toBe(30);

    await expect(qty).toHaveValue("3");
    await qty.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: `Edit ${TAG} Metformin 500 batch MF1` }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    const remove = page.getByRole("button", { name: `Remove ${TAG} Metformin 500 batch MF1` });
    await expect(remove).toBeFocused();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await savedLines()).some((l) => l.batch_no === "MF1"))
      .toBe(false);
  });

  test("a line's medicine and batch are edited from the entry row; Esc leaves it as it was", async ({
    page,
  }) => {
    await openBill(page);
    await typeMedicine(page, "Metformin 500");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(search(page)).toBeFocused();

    const edit = page.getByRole("button", { name: `Edit ${TAG} Metformin 500 batch MF1` });
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(batchBox(page, "Metformin 500")).toBeFocused();
    await expect(page.getByText(`Editing ${TAG} Metformin 500 · batch MF1`)).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(search(page)).toBeFocused();
    expect((await savedLines()).find((l) => l.batch_no === "MF1").qty_units).toBe(10);

    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(batchBox(page, "Metformin 500")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(entryQty(page)).toHaveValue("1");
    await page.keyboard.type("3");
    await page.keyboard.press("Enter");
    await page.keyboard.type("5");
    await page.keyboard.press("Enter");
    await expect(search(page)).toBeFocused();
    const mf = (await savedLines()).filter((l) => l.batch_no === "MF1");
    expect(mf.map((l) => [l.qty_units, Number(l.discount_pct)])).toEqual([[30, 5]]);
  });

  test("the medicine and batch lists are not cut off by the table", async ({ page }) => {
    await openBill(page);
    await typeMedicine(page, "Telsartan 40");
    const last = page
      .getByRole("listbox", { name: `Batches of ${TAG} Telsartan 40` })
      .getByRole("option")
      .last();
    await expect(last).toBeVisible();
    const box = await last.boundingBox();
    const onTop = await page.evaluate(
      ({ x, y, id }) => document.elementFromPoint(x, y)?.closest('[role="option"]')?.id === id,
      { x: box.x + box.width / 2, y: box.y + box.height / 2, id: await last.getAttribute("id") },
    );
    expect(onTop).toBe(true);
    const listBox = page.getByRole("listbox", { name: `Batches of ${TAG} Telsartan 40` });
    await expect(listBox).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(listBox.getByText("choosing confirms").first()).not.toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  });

  test("finalising by keyboard lands on Print, then Create new bill opens the patient page", async ({
    page,
  }) => {
    await openBill(page);
    const finalise = page.getByRole("button", { name: /^Finalise and collect/ });
    await finalise.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Finalise bill" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Print bill" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Create new bill" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/pharmacy\/billing\/new$/);
    await expect(page.getByLabel("Find patient")).toBeFocused();
  });

  test("a bill is started from the patient page with only the keyboard", async ({ page }) => {
    await loginAs(page, "pharmacy");
    await gotoReady(page, "/pharmacy/billing/new", () => page.getByLabel("Find patient"), {
      timeout: 30000,
    });
    await expect(page.getByLabel("Find patient")).toBeFocused();
    await page.keyboard.type(PHONE);
    const match = page.getByRole("radio", { name: new RegExp(`${TAG} Keyboard`) });
    await expect(match).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(match).toBeFocused();
    await expect(match).toBeChecked();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/pharmacy\/billing\/[0-9a-f-]{36}$/);
    await expect(search(page)).toBeFocused();
    await expect(page.getByText(`${TAG} Keyboard`).first()).toBeVisible();
    const table = page.getByRole("table", { name: "Medicines on this bill" });
    const empty = table.getByRole("cell", { name: /No medicines on this bill yet/ });
    const [tableBox, emptyBox] = [await table.boundingBox(), await empty.boundingBox()];
    expect(emptyBox.width).toBeGreaterThan(tableBox.width - 4);

    await page.goto("/pharmacy/billing/new");
    await expect(page.getByLabel("Find patient")).toBeFocused();
    await page.keyboard.type(PHONE);
    await expect(match).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/pharmacy\/billing\/[0-9a-f-]{36}$/);
    await expect(search(page)).toBeFocused();
  });
});
