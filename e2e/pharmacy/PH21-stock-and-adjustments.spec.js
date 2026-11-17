import { test, expect } from "@playwright/test";
import { apiAs, loginAs } from "../helpers/auth.mjs";
import { gotoReady } from "../helpers/browser.mjs";
import { one, query } from "../helpers/db.mjs";
import { assertTestDatabase } from "../setup/guard.mjs";
import { pickOption } from "../helpers/pickers.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);

const TAG = `PH21${Date.now().toString(36).toUpperCase()}`;
const dayOffset = (days) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
};

test.describe.configure({ mode: "serial" });

test.describe("PH21 batch stock view and adjustments", () => {
  let admin;
  let pharmacist;
  let nurse;
  let tablet;
  let empty;
  let soon;
  let later;
  let expired;
  let receiptId;

  const stock = async (api, params) =>
    (await api.get("/api/pharmacy/batches/stock", { params: { q: TAG, ...params } })).json();

  test.beforeAll(async () => {
    admin = await apiAs("pharmacy_admin");
    pharmacist = await apiAs("pharmacy");
    nurse = await apiAs("nurse");
    const medicine = (name, extra) =>
      admin
        .post("/api/pharmacy/medicines", {
          data: {
            name: `${TAG} ${name}`,
            form: "TAB",
            pack_size: 10,
            unit_label: "tab",
            pack_label: "strip",
            gst_rate_pct: 12,
            ...extra,
          },
        })
        .then((r) => r.json());
    tablet = await medicine("Amlodipine 5", { min_stock_units: 50, max_stock_units: 100 });
    empty = await medicine("Telmisartan 40", { min_stock_units: 20 });

    const receipt = await (
      await admin.post("/api/pharmacy/purchases", { data: { kind: "opening" } })
    ).json();
    const line = (batch_no, expiry_date, qty_packs, rack_no) => ({
      medicine_id: tablet.id,
      batch_no,
      expiry_date,
      qty_packs,
      free_packs: 0,
      purchase_rate: "20",
      gst_rate_pct: 12,
      mrp: "40",
      sale_rate: "35",
      rack_no,
    });
    const saved = await (
      await admin.put(`/api/pharmacy/purchases/${receipt.id}`, {
        data: {
          version: receipt.version,
          lines: [line("LATER1", dayOffset(400), 6, "A-2"), line("SOON1", dayOffset(20), 3, "A-1")],
        },
      })
    ).json();
    const posted = await admin.post(`/api/pharmacy/purchases/${receipt.id}/post`, {
      data: { version: saved.version },
    });
    expect(posted.status(), await posted.text()).toBe(200);
    receiptId = receipt.id;
    soon = await one(
      `SELECT id FROM pharmacy_batches WHERE medicine_id = $1 AND batch_no = 'SOON1'`,
      [tablet.id],
    );
    later = await one(
      `SELECT id FROM pharmacy_batches WHERE medicine_id = $1 AND batch_no = 'LATER1'`,
      [tablet.id],
    );

    expired = await one(
      `INSERT INTO pharmacy_batches (medicine_id, batch_no, expiry_date, pack_size, mrp, sale_rate, gst_rate_pct)
       VALUES ($1, 'OLD9', $2, 10, 40, 35, 12) RETURNING id`,
      [tablet.id, dayOffset(-5)],
    );
    const main = await one(`SELECT id FROM pharmacy_locations WHERE kind = 'main'`);
    await query(
      `INSERT INTO pharmacy_stock (location_id, batch_id, qty_units) VALUES ($1, $2, 5)`,
      [main.id, expired.id],
    );
    await query(
      `INSERT INTO pharmacy_stock_movements (location_id, batch_id, medicine_id, kind, delta_units, balance_after)
       VALUES ($1, $2, $3, 'opening', 5, 5)`,
      [main.id, expired.id, tablet.id],
    );
  });

  test.afterAll(async () => {
    await Promise.all([admin?.dispose(), pharmacist?.dispose(), nurse?.dispose()]);
  });

  test("stock is listed per medicine with batches soonest expiry first", async () => {
    const body = await stock(admin);
    expect(body.location).toMatchObject({ code: "MAIN", kind: "main" });
    expect(body.rows.map((r) => [r.name, r.level])).toEqual([
      [`${TAG} Telmisartan 40`, "out"],
      [`${TAG} Amlodipine 5`, "ok"],
    ]);
    const row = body.rows[1];
    expect(row).toMatchObject({
      total_units: 95,
      sellable_units: 90,
      expired_units: 5,
      near_expiry_units: 30,
      next_expiry: dayOffset(20),
      min_units: 50,
      max_units: 100,
    });
    expect(row.batches.map((b) => [b.batch_no, b.qty_units, b.rack_no, b.expired])).toEqual([
      ["OLD9", 5, null, true],
      ["SOON1", 30, "A-1", false],
      ["LATER1", 60, "A-2", false],
    ]);
    expect(row.cost_value).toBe("180.00");
    expect(row.batches[1].purchase_rate).toBe("20.00");
  });

  test("the pharmacist sees stock but not purchase cost", async () => {
    const body = await stock(pharmacist);
    expect(body.rows[1].cost_value).toBeUndefined();
    expect(body.rows[1].batches[1].purchase_rate).toBeUndefined();
    const summary = await (await pharmacist.get("/api/pharmacy/batches/summary")).json();
    expect(summary.cost_value).toBeUndefined();
  });

  test("filters pick out near-expiry, expired and out-of-stock medicines", async () => {
    expect((await stock(admin, { filter: "near_expiry" })).rows.map((r) => r.name)).toEqual([
      `${TAG} Amlodipine 5`,
    ]);
    expect((await stock(admin, { filter: "expired" })).rows.map((r) => r.name)).toEqual([
      `${TAG} Amlodipine 5`,
    ]);
    expect((await stock(admin, { filter: "out" })).rows.map((r) => r.name)).toEqual([
      `${TAG} Telmisartan 40`,
    ]);
  });

  test("the batch list for billing is sorted soonest expiry first", async () => {
    const body = await (
      await nurse.get("/api/pharmacy/batches", { params: { medicine_id: tablet.id } })
    ).json();
    expect(body.batches.map((b) => b.batch_no)).toEqual(["OLD9", "SOON1", "LATER1"]);
  });

  test("an adjustment needs the stock the user saw, and records why", async () => {
    const stale = await admin.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: later.id,
        expected_units: 59,
        new_units: 10,
        reason: "physical_count",
        note: "Shelf count",
      },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error).toContain("it is now 60 tab");

    const up = await admin.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: later.id,
        expected_units: 60,
        new_units: 70,
        reason: "damaged",
        note: "Broken strip",
      },
    });
    expect(up.status()).toBe(400);
    expect((await up.json()).error).toContain("Damaged can only reduce stock");

    const noNote = await admin.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: later.id,
        expected_units: 60,
        new_units: 10,
        reason: "physical_count",
        note: "",
      },
    });
    expect(noNote.status()).toBe(400);

    const ok = await admin.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: later.id,
        expected_units: 60,
        new_units: 10,
        reason: "physical_count",
        note: "Shelf count after audit",
      },
    });
    expect(ok.status(), await ok.text()).toBe(201);
    expect(await ok.json()).toMatchObject({ before_units: 60, after_units: 10, delta_units: -50 });

    const row = (await stock(admin)).rows.find((r) => r.name === `${TAG} Amlodipine 5`);
    expect(row).toMatchObject({ sellable_units: 40, level: "low" });
  });

  test("expired stock is written off as an expiry write-off", async () => {
    const response = await admin.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: expired.id,
        expected_units: 5,
        new_units: 0,
        reason: "expired",
        note: "Expired on shelf",
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const move = await one(
      `SELECT kind, delta_units, balance_after FROM pharmacy_stock_movements
        WHERE batch_id = $1 ORDER BY id DESC LIMIT 1`,
      [expired.id],
    );
    expect(move).toEqual({ kind: "expiry_writeoff", delta_units: -5, balance_after: 0 });
    expect((await stock(admin, { filter: "expired" })).rows).toEqual([]);
  });

  test("a batch's history shows every movement with its reference", async () => {
    const body = await (await admin.get(`/api/pharmacy/batches/${later.id}/movements`)).json();
    expect(body.rows.map((r) => [r.kind, r.delta_units, r.balance_after])).toEqual([
      ["adjustment", -50, 10],
      ["opening", 60, 60],
    ]);
    expect(body.rows[1].reference).toMatch(/^GRN\d{6}$/);
    expect(body.rows[0].reason).toBe("Physical count: Shelf count after audit");
    expect(body.rows[0].actor_name).toBe("E2E Pharmacy Admin");
    expect(receiptId).toBeTruthy();
  });

  test("the summary counts each state", async () => {
    const summary = await (await admin.get("/api/pharmacy/batches/summary")).json();
    for (const key of ["in_stock", "out_of_stock", "below_min", "near_expiry", "expired"]) {
      expect(typeof summary[key], key).toBe("number");
    }
    expect(summary.below_min).toBeGreaterThanOrEqual(1);
    expect(Number(summary.cost_value)).toBeGreaterThan(0);
  });

  test("adjustments are listed and audited, and only the admin can make them", async () => {
    const list = await (await admin.get("/api/pharmacy/adjustments")).json();
    expect(list.rows.slice(0, 2).map((a) => a.reason)).toEqual(["expired", "physical_count"]);
    const audit = await one(
      `SELECT count(*)::int AS n FROM billing_audit WHERE entity = 'pharmacy_stock_adjustments'
         AND entity_id = $1`,
      [String(list.rows[0].id)],
    );
    expect(audit.n).toBe(1);
    const denied = await pharmacist.post("/api/pharmacy/adjustments", {
      data: {
        batch_id: later.id,
        expected_units: 10,
        new_units: 9,
        reason: "lost",
        note: "Missing",
      },
    });
    expect(denied.status()).toBe(403);
  });

  test("stock never goes below zero and always equals the history", async () => {
    const drift = await one(
      `SELECT count(*)::int AS n FROM pharmacy_stock s
        WHERE s.qty_units <> (SELECT COALESCE(SUM(delta_units), 0) FROM pharmacy_stock_movements m
                               WHERE m.batch_id = s.batch_id AND m.location_id = s.location_id)`,
    );
    expect(drift.n).toBe(0);
    await expect(
      query(`UPDATE pharmacy_stock SET qty_units = -1 WHERE batch_id = $1`, [later.id]),
    ).rejects.toThrow(/pharmacy_stock_not_negative/);
    expect(empty.id).toBeTruthy();
  });

  test("the admin finds a batch by rack, adjusts it and reads its history on screen", async ({
    page,
  }) => {
    await loginAs(page, "pharmacy_admin");
    await gotoReady(
      page,
      "/pharmacy/stock",
      () => page.getByRole("tab", { name: "Batch stock", selected: true }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search stock").fill(TAG);
    const row = page.getByRole("row", { name: new RegExp(`${TAG} Amlodipine 5`) }).first();
    await expect(row).toContainText("Below minimum");
    await row.getByRole("button", { name: /batch/ }).click();

    const batches = page.getByRole("table", { name: `Batches of ${TAG} Amlodipine 5` });
    await expect(batches.getByRole("row").nth(1)).toContainText("SOON1");
    await expect(batches.getByRole("row").nth(1)).toContainText("A-1");
    await expect(batches.getByRole("row").nth(1)).toContainText("days left");

    await batches
      .getByRole("button", { name: `Adjust batch LATER1 of ${TAG} Amlodipine 5` })
      .click();
    const dialog = page.getByRole("dialog", { name: `Adjust stock · ${TAG} Amlodipine 5` });
    await expect(dialog).toContainText("1 strip (10 tab)");
    await pickOption(dialog, "Reason", "Damaged");
    await dialog.getByRole("textbox", { name: "New stock (tab)" }).fill("12");
    await dialog.getByRole("button", { name: "Save adjustment" }).click();
    await expect(dialog.getByText("Damaged can only reduce stock.")).toBeVisible();
    await dialog.getByRole("textbox", { name: "New stock (tab)" }).fill("8");
    await dialog.getByRole("textbox", { name: "What happened" }).fill("Two tablets crushed");
    await expect(dialog.getByRole("status")).toContainText("10 to 8 tab (−2)");
    await dialog.getByRole("button", { name: "Save adjustment" }).click();
    await expect(dialog).toBeHidden();
    await expect(batches.getByRole("row", { name: /LATER1/ })).toContainText("8 tab");

    await batches.getByRole("button", { name: "History of batch LATER1" }).click();
    const history = page.getByRole("dialog", { name: "Batch history · LATER1" });
    await expect(history.getByRole("row").nth(1)).toContainText("Damaged: Two tablets crushed");
    await expect(history.getByRole("row").nth(1)).toContainText("−2");
    await history.getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "DARPAN report" }).click();
    await expect(page.getByRole("heading", { name: "DARPAN stock report" })).toBeVisible();
    await expect(page).toHaveURL(/tab=darpan/);
  });

  test("the pharmacist sees batches but cannot adjust them or see cost", async ({ page }) => {
    await loginAs(page, "pharmacy");
    await gotoReady(
      page,
      "/pharmacy/stock",
      () => page.getByRole("tab", { name: "Batch stock", selected: true }),
      { timeout: 30000 },
    );
    await page.getByLabel("Search stock").fill(TAG);
    const row = page.getByRole("row", { name: new RegExp(`${TAG} Amlodipine 5`) }).first();
    await row.getByRole("button", { name: /batch/ }).click();
    const batches = page.getByRole("table", { name: `Batches of ${TAG} Amlodipine 5` });
    await expect(batches.getByRole("button", { name: /History of batch/ }).first()).toBeVisible();
    await expect(batches.getByRole("button", { name: /Adjust batch/ })).toHaveCount(0);
    await expect(batches.getByRole("columnheader", { name: "Cost" })).toHaveCount(0);
    await expect(page.getByText("Stock value at cost")).toHaveCount(0);
  });
});
