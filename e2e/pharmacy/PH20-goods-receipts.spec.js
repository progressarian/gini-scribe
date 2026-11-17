import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH20${Date.now().toString(36).toUpperCase()}`;
const FUTURE = `${new Date().getFullYear() + 2}-06-30`;
const PAST = `${new Date().getFullYear() - 1}-01-31`;
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

test.describe.configure({ mode: "serial" });

test.describe("PH20 goods receipts post stock into batches", () => {
  let admin;
  let pharmacist;
  let vendor;
  let tablet;
  let syrup;
  let receipt;

  const line = (overrides = {}) => ({
    medicine_id: tablet.id,
    batch_no: `${TAG.slice(-6)}a`,
    expiry_date: FUTURE,
    qty_packs: 5,
    free_packs: 1,
    purchase_rate: "100",
    discount_pct: 10,
    gst_rate_pct: 12,
    mrp: "150",
    sale_rate: "140",
    rack_no: "A-1",
    ...overrides,
  });

  const save = (r, data) =>
    admin.put(`/api/pharmacy/purchases/${r.id}`, { data: { ...data, version: r.version } });

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    vendor = await (
      await admin.post("/api/pharmacy/vendors", {
        data: { name: `${TAG} Distributors`, phone: "9876500020" },
      })
    ).json();
    tablet = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Metformin 500`,
          form: "TAB",
          pack_size: 10,
          unit_label: "tab",
          pack_label: "strip",
          gst_rate_pct: 12,
        },
      })
    ).json();
    syrup = await (
      await admin.post("/api/pharmacy/medicines", {
        data: {
          name: `${TAG} Cough Syrup`,
          form: "SYP",
          pack_size: 1,
          unit_label: "unit",
          pack_label: "bottle",
          gst_rate_pct: 5,
        },
      })
    ).json();
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose()]);
  });

  test("a draft receipt saves lines and works out the totals", async () => {
    const created = await admin.post("/api/pharmacy/purchases", {
      data: { vendor_id: vendor.id, invoice_no: `${TAG}-INV-1` },
    });
    receipt = await created.json();
    expect(created.status(), JSON.stringify(receipt)).toBe(201);
    expect(receipt).toMatchObject({
      status: "draft",
      kind: "purchase",
      location_name: "Main pharmacy",
    });
    expect(receipt.receipt_no).toMatch(/^GRN\d{6}$/);

    const saved = await save(receipt, {
      vendor_id: vendor.id,
      invoice_no: `${TAG}-INV-1`,
      lines: [
        line(),
        line({
          medicine_id: syrup.id,
          batch_no: "syr 01",
          qty_packs: 2,
          free_packs: 0,
          purchase_rate: "50",
          discount_pct: 0,
          gst_rate_pct: 5,
          mrp: "80",
          sale_rate: "75",
          rack_no: null,
        }),
      ],
    });
    receipt = await saved.json();
    expect(saved.status(), JSON.stringify(receipt)).toBe(200);
    expect(receipt).toMatchObject({
      discount_amount: "50.00",
      taxable_amount: "550.00",
      gst_amount: "59.00",
      net_amount: "609.00",
    });
    expect(receipt.lines.map((l) => [l.batch_no, l.line_total])).toEqual([
      [`${TAG.slice(-6)}A`, "504.00"],
      ["SYR01", "105.00"],
    ]);
  });

  test("bad lines are refused with readable reasons", async () => {
    const bad = await save(receipt, {
      vendor_id: vendor.id,
      invoice_no: `${TAG}-INV-1`,
      lines: [line({ qty_packs: 0, free_packs: 0, sale_rate: "200" })],
    });
    expect(bad.status()).toBe(400);
    const { error } = await bad.json();
    expect(error).toContain("free packs cannot both be 0");
    expect(error).toContain("cannot be more than the MRP");

    const twice = await save(receipt, {
      vendor_id: vendor.id,
      invoice_no: `${TAG}-INV-1`,
      lines: [line(), line()],
    });
    expect(twice.status()).toBe(400);
    expect((await twice.json()).error).toContain("repeats a medicine and batch");
  });

  test("the same vendor invoice cannot be entered twice", async () => {
    const other = await (
      await admin.post("/api/pharmacy/purchases", { data: { vendor_id: vendor.id } })
    ).json();
    const dup = await save(other, {
      vendor_id: vendor.id,
      invoice_no: `${TAG}-inv-1`,
      lines: [],
    });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error).toContain("already recorded on another receipt");
    const cancel = await admin.post(`/api/pharmacy/purchases/${other.id}/cancel`, {
      data: { version: other.version, reason: "Entered twice" },
    });
    expect(cancel.status()).toBe(200);
    expect((await cancel.json()).status).toBe("cancelled");
  });

  test("posting needs an invoice date and then puts the stock on the shelf", async () => {
    const early = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: receipt.version },
    });
    expect(early.status()).toBe(409);
    expect((await early.json()).error).toContain("enter the invoice date");

    receipt = await (
      await save(receipt, {
        vendor_id: vendor.id,
        invoice_no: `${TAG}-INV-1`,
        invoice_date: TODAY,
        lines: receipt.lines.map((l) => ({
          medicine_id: l.medicine_id,
          batch_no: l.batch_no,
          expiry_date: l.expiry_date,
          qty_packs: l.qty_packs,
          free_packs: l.free_packs,
          purchase_rate: l.purchase_rate,
          discount_pct: l.discount_pct,
          gst_rate_pct: l.gst_rate_pct,
          mrp: l.mrp,
          sale_rate: l.sale_rate,
          rack_no: l.rack_no,
        })),
      })
    ).json();

    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: receipt.version },
    });
    const body = await posted.json();
    expect(posted.status(), JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("posted");
    expect(body.lines.every((l) => l.batch_id)).toBe(true);
    receipt = body;

    const stock = await query(
      `SELECT m.name, b.batch_no, b.rack_no, b.pack_size, b.mrp, s.qty_units
         FROM pharmacy_stock s
         JOIN pharmacy_batches b ON b.id = s.batch_id
         JOIN pharmacy_medicines m ON m.id = b.medicine_id
        WHERE m.name LIKE $1 ORDER BY m.name`,
      [`${TAG}%`],
    );
    expect(stock.rows).toEqual([
      {
        name: `${TAG} Cough Syrup`,
        batch_no: "SYR01",
        rack_no: null,
        pack_size: 1,
        mrp: "80.00",
        qty_units: 2,
      },
      {
        name: `${TAG} Metformin 500`,
        batch_no: `${TAG.slice(-6)}A`,
        rack_no: "A-1",
        pack_size: 10,
        mrp: "150.00",
        qty_units: 60,
      },
    ]);

    const moves = await query(
      `SELECT kind, delta_units, balance_after FROM pharmacy_stock_movements
        WHERE ref_type = 'pharmacy_purchases' AND ref_id = $1 ORDER BY id`,
      [String(receipt.id)],
    );
    expect(moves.rows.map((m) => [m.kind, m.delta_units, m.balance_after]).sort()).toEqual(
      [
        ["purchase", 2, 2],
        ["purchase", 60, 60],
      ].sort(),
    );
  });

  test("a posted receipt cannot be edited or cancelled", async () => {
    const edit = await save(receipt, { vendor_id: vendor.id, lines: [] });
    expect(edit.status()).toBe(409);
    const cancel = await admin.post(`/api/pharmacy/purchases/${receipt.id}/cancel`, {
      data: { version: receipt.version, reason: "Too late" },
    });
    expect(cancel.status()).toBe(409);
  });

  test("the same batch adds to stock, but a different MRP for it is refused", async () => {
    const start = async (invoice) =>
      (
        await admin.post("/api/pharmacy/purchases", {
          data: { vendor_id: vendor.id, invoice_no: invoice, invoice_date: TODAY },
        })
      ).json();

    let again = await start(`${TAG}-INV-2`);
    again = await (
      await save(again, {
        vendor_id: vendor.id,
        invoice_no: `${TAG}-INV-2`,
        invoice_date: TODAY,
        lines: [line({ qty_packs: 2, free_packs: 0, rack_no: "B-4" })],
      })
    ).json();
    const ok = await admin.post(`/api/pharmacy/purchases/${again.id}/post`, {
      data: { version: again.version },
    });
    expect(ok.status(), await ok.text()).toBe(200);
    const batch = await one(
      `SELECT b.rack_no, s.qty_units FROM pharmacy_batches b
         JOIN pharmacy_stock s ON s.batch_id = b.id
        WHERE b.medicine_id = $1`,
      [tablet.id],
    );
    expect(batch).toEqual({ rack_no: "B-4", qty_units: 80 });

    let wrong = await start(`${TAG}-INV-3`);
    wrong = await (
      await save(wrong, {
        vendor_id: vendor.id,
        invoice_no: `${TAG}-INV-3`,
        invoice_date: TODAY,
        lines: [
          line({ medicine_id: syrup.id, batch_no: "SYR02", mrp: "80", sale_rate: "75" }),
          line({ qty_packs: 1, free_packs: 0, mrp: "160" }),
        ],
      })
    ).json();
    const refused = await admin.post(`/api/pharmacy/purchases/${wrong.id}/post`, {
      data: { version: wrong.version },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toContain("already in stock with MRP ₹150.00");
    const nothing = await one(
      `SELECT count(*)::int AS n FROM pharmacy_batches WHERE medicine_id = $1 AND batch_no = 'SYR02'`,
      [syrup.id],
    );
    expect(nothing.n).toBe(0);
  });

  test("expired stock cannot be posted", async () => {
    let expired = await (
      await admin.post("/api/pharmacy/purchases", {
        data: { vendor_id: vendor.id, invoice_no: `${TAG}-INV-4`, invoice_date: TODAY },
      })
    ).json();
    expired = await (
      await save(expired, {
        vendor_id: vendor.id,
        invoice_no: `${TAG}-INV-4`,
        invoice_date: TODAY,
        lines: [line({ batch_no: "OLD1", expiry_date: PAST })],
      })
    ).json();
    const refused = await admin.post(`/api/pharmacy/purchases/${expired.id}/post`, {
      data: { version: expired.version },
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error).toContain("remove expired stock (line 1)");
  });

  test("opening stock needs no vendor and is recorded as opening", async () => {
    let opening = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    expect(opening).toMatchObject({ kind: "opening", vendor_id: null });
    opening = await (
      await save(opening, {
        lines: [
          line({
            medicine_id: syrup.id,
            batch_no: "OPEN1",
            purchase_rate: "0",
            mrp: "80",
            sale_rate: "75",
          }),
        ],
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${opening.id}/post`, {
      data: { version: opening.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    const move = await one(
      `SELECT kind, delta_units FROM pharmacy_stock_movements WHERE ref_type = 'pharmacy_purchases' AND ref_id = $1`,
      [String(opening.id)],
    );
    expect(move).toEqual({ kind: "opening", delta_units: 6 });
  });

  test("the stock history cannot be edited or deleted", async () => {
    await expect(
      query(`UPDATE pharmacy_stock_movements SET delta_units = 1 WHERE ref_id = $1`, [
        String(receipt.id),
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      query(`DELETE FROM pharmacy_stock_movements WHERE ref_id = $1`, [String(receipt.id)]),
    ).rejects.toThrow(/append-only/);
  });

  test("posting and cancelling are audited", async () => {
    const audit = await query(
      `SELECT action FROM billing_audit WHERE entity = 'pharmacy_purchases' AND entity_id = $1 ORDER BY id`,
      [String(receipt.id)],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["create", "update", "update", "approve"]);
  });

  test("the admin records and posts a purchase from the screen", async ({ page }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(page, "/pharmacy/purchases", () =>
      page.getByRole("heading", { name: "Goods receipts", exact: true }),
    );
    await page.getByRole("button", { name: "New purchase" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/GRN\d{6}/);

    await page
      .getByRole("combobox", { name: "Vendor" })
      .selectOption({ label: `${TAG} Distributors` });
    await page.getByRole("textbox", { name: "Invoice number" }).fill(`${TAG}-SCREEN`);
    await page.getByLabel("Invoice date").fill(TODAY);

    const picker = page.getByRole("combobox", { name: "Add a medicine" });
    await picker.fill(`${TAG} Cough`);
    await page.getByRole("option", { name: new RegExp(`${TAG} Cough Syrup`) }).click();

    const field = (label) =>
      page.getByLabel(`${label} for line 1, ${TAG} Cough Syrup`, { exact: true });
    await page.getByRole("button", { name: "Post to stock" }).click();
    await expect(page.getByText("Fix the highlighted fields before posting.")).toBeVisible();
    await expect(field("Batch")).toHaveAttribute("aria-invalid", "true");

    await field("Batch").fill("scr 9");
    await field("Expiry").fill(FUTURE);
    await field("Qty").fill("4");
    await field("Purchase rate").fill("50");
    await field("GST %").fill("5");
    await field("MRP").fill("80");
    await field("Sale rate").fill("75");
    await field("Rack").fill("C-7");
    await expect(page.getByRole("definition").filter({ hasText: "₹210.00" })).toBeVisible();

    await page.getByRole("button", { name: "Post to stock" }).click();
    await expect(page.getByText(/4 units in all/)).toBeVisible();
    await page.getByRole("button", { name: "Post to stock" }).last().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Posted");

    const stock = await one(
      `SELECT b.batch_no, b.rack_no, s.qty_units FROM pharmacy_batches b
         JOIN pharmacy_stock s ON s.batch_id = b.id
        WHERE b.medicine_id = $1 AND b.batch_no = 'SCR9'`,
      [syrup.id],
    );
    expect(stock).toEqual({ batch_no: "SCR9", rack_no: "C-7", qty_units: 4 });
  });

  test("the pharmacist cannot record purchases", async () => {
    expect((await pharmacist.get("/api/pharmacy/purchases")).status()).toBe(403);
    const create = await pharmacist.post("/api/pharmacy/purchases", { data: { kind: "opening" } });
    expect(create.status()).toBe(403);
  });
});
