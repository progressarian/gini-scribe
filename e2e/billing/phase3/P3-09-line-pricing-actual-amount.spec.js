import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { lineActual } = await import("../../../server/services/billing/priceLine.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const schemes = await import("../../../server/services/patientSchemes.js");

const db = getPool();
const ctx = { actorId: USERS.reception_admin.id, ip: "10.9.9.9" };
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const c = (name) => `p309_${name}_${tag}`;
const failure = (promise) => promise.then(() => null).catch((e) => e);
const ids = {};

const DAY = "2026-10-15";
const price = (item, extra = {}) => lineActual({ item: ids[item], date: DAY, ...extra }, db);
const addRate = (scheme, item, extra) =>
  rates.saveRate(
    { scheme_code: c(scheme), service_item_id: ids[item], valid_from: "2026-01-01", ...extra },
    ctx,
    db,
  );
const refusedWith = async (input, status, message) => {
  const error = await failure(lineActual(input, db));
  expect([error?.status, error?.message], JSON.stringify(input)).toEqual([
    status,
    expect.stringMatching(message),
  ]);
};

test.describe.serial("P3-09 line pricing: actual amount", () => {
  test.beforeAll(async () => {
    await schemes.createScheme(
      { code: c("cghs"), label: `P309 CGHS ${tag}`, payer_name: "CGHS Wellness Centre" },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("pensioner"), label: "Pensioner", parent_code: c("cghs") },
      db,
      ctx,
    );
    await schemes.createScheme(
      { code: c("paid"), label: "CGHS Paid", parent_code: c("cghs") },
      db,
      ctx,
    );
    ids.tax = (
      await query(
        `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, '9993', 18) RETURNING id`,
        [`GST18-${T}`],
      )
    ).rows[0].id;
    ids.group = (
      await query(`INSERT INTO service_groups (code, name) VALUES ($1, $1) RETURNING id`, [
        `P309-OPD-${T}`,
      ])
    ).rows[0].id;
    ids.subgroup = (
      await query(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, $2, $2) RETURNING id`,
        [ids.group, `P309-PROCS-${T}`],
      )
    ).rows[0].id;
    const item = (code, basePrice, extra = {}) =>
      query(
        `INSERT INTO service_items
           (code, name, subgroup_id, base_price, kind, unit, allow_quantity, max_quantity,
            tax_code_id, price_includes_tax)
         VALUES ($1, $1, $2, $3, 'procedure', $4, $5, $6, $7, $8) RETURNING id`,
        [
          `${code}-${T}`,
          ids.subgroup,
          basePrice,
          extra.unit ?? "each",
          extra.allow_quantity ?? false,
          extra.max_quantity ?? null,
          extra.tax_code_id ?? null,
          extra.price_includes_tax ?? false,
        ],
      ).then((r) => r.rows[0].id);
    ids.meet = await item("P309-MEET", 1000, { tax_code_id: ids.tax, price_includes_tax: true });
    ids.dressing = await item("P309-DRESSING", 400);
    ids.strip = await item("P309-STRIP", 12.5, {
      unit: "strip",
      allow_quantity: true,
      max_quantity: 5,
    });
    ids.gauze = await item("P309-GAUZE", 20, { allow_quantity: true });
    ids.old = await item("P309-OLD", 100);
    await query(`UPDATE service_items SET is_active = FALSE WHERE id = $1`, [ids.old]);
  });

  test("1. General uses the base price, the item's own name and no bill code", async () => {
    expect(await price("meet")).toEqual({
      item_id: ids.meet,
      item_code: `P309-MEET-${T}`,
      item_name: `P309-MEET-${T}`,
      kind: "procedure",
      group_id: ids.group,
      group_code: `P309-OPD-${T}`,
      subgroup_id: ids.subgroup,
      subgroup_code: `P309-PROCS-${T}`,
      doctor_id: null,
      visit_type: null,
      unit: "each",
      quantity: 1,
      category: null,
      date: DAY,
      base_price: 100000,
      rate: 100000,
      rate_source: "base",
      bill_name: `P309-MEET-${T}`,
      bill_name_source: "base",
      bill_code: null,
      bill_code_source: null,
      actual: 100000,
      tax_code: {
        id: ids.tax,
        code: `GST18-${T}`,
        sac_hsn: "9993",
        rate_pct: 18,
        is_active: true,
      },
      price_includes_tax: true,
    });
    for (const none of [null, undefined, "", "general", " GENERAL "]) {
      const line = await price("meet", { category: none });
      expect([line.category, line.rate, line.rate_source], `${none} means General`).toEqual([
        null,
        100000,
        "base",
      ]);
    }
    const dressing = await price("dressing");
    expect(dressing.tax_code, "an item with no tax code").toBeNull();
    expect(dressing.price_includes_tax).toBe(false);
  });

  test("2. done when: a CGHS rate replaces the base price for a Pensioner patient too, with its bill name and code", async () => {
    await addRate("cghs", "meet", {
      rate: 700,
      bill_name: "Consultant meet with Dr Banshali CC02",
      bill_code: `CC02-${T}`,
    });
    for (const scheme of ["pensioner", "paid"]) {
      expect(await price("meet", { category: c(scheme) })).toMatchObject({
        category: c(scheme),
        base_price: 100000,
        rate: 70000,
        rate_source: "parent",
        bill_name: "Consultant meet with Dr Banshali CC02",
        bill_name_source: "parent",
        bill_code: `CC02-${T}`,
        bill_code_source: "parent",
        actual: 70000,
      });
    }
    const general = await price("meet");
    expect([general.rate, general.bill_code], "General is untouched").toEqual([100000, null]);
    const dressing = await price("dressing", { category: c("pensioner") });
    expect([dressing.rate, dressing.rate_source], "an item with no CGHS rate").toEqual([
      40000,
      "base",
    ]);
  });

  test("3. a sub-category's own rate beats its parent's", async () => {
    await addRate("pensioner", "meet", { rate: 500, bill_name: "Pensioner meet" });
    expect(await price("meet", { category: c("pensioner") })).toMatchObject({
      rate: 50000,
      rate_source: "own",
      bill_name: "Pensioner meet",
      bill_name_source: "own",
      bill_code: `CC02-${T}`,
      bill_code_source: "parent",
      actual: 50000,
    });
    expect((await price("meet", { category: c("paid") })).rate, "the sibling keeps CGHS").toBe(
      70000,
    );
  });

  test("4. a rate row with only a bill code keeps the parent or base rate but gives the code", async () => {
    await addRate("paid", "meet", { bill_code: `CP02-${T}` });
    expect(await price("meet", { category: c("paid") })).toMatchObject({
      rate: 70000,
      rate_source: "parent",
      bill_name: "Consultant meet with Dr Banshali CC02",
      bill_name_source: "parent",
      bill_code: `CP02-${T}`,
      bill_code_source: "own",
      actual: 70000,
    });
    await addRate("cghs", "dressing", { bill_code: `CD01-${T}` });
    expect(await price("dressing", { category: c("paid") })).toMatchObject({
      rate: 40000,
      rate_source: "base",
      bill_name: `P309-DRESSING-${T}`,
      bill_name_source: "base",
      bill_code: `CD01-${T}`,
      bill_code_source: "parent",
    });
  });

  test("5. rates not yet valid or already ended are ignored", async () => {
    await addRate("pensioner", "dressing", {
      rate: 300,
      valid_from: "2026-09-01",
      valid_to: "2026-09-30",
    });
    await addRate("pensioner", "dressing", { rate: 350, valid_from: "2026-11-01" });
    await addRate("cghs", "gauze", { rate: 15, valid_from: "2026-10-16" });
    const on = async (item, date) => {
      const line = await price(item, { category: c("pensioner"), date });
      return [line.rate, line.rate_source];
    };
    expect(await on("dressing", DAY), "between the two").toEqual([40000, "base"]);
    expect(await on("dressing", "2026-09-30"), "the last day").toEqual([30000, "own"]);
    expect(await on("dressing", "2026-09-01"), "the first day").toEqual([30000, "own"]);
    expect(await on("dressing", "2026-08-31")).toEqual([40000, "base"]);
    expect(await on("dressing", "2026-11-01")).toEqual([35000, "own"]);
    expect(await on("gauze", DAY), "the parent's rate starts tomorrow").toEqual([2000, "base"]);
    expect(await on("gauze", "2026-10-16")).toEqual([1500, "parent"]);
    const today = await lineActual({ item: ids.meet, category: c("paid") }, db);
    expect(today.date, "the date defaults to today in India").toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("6. actual = quantity × rate, in whole paise", async () => {
    const strip = await price("strip", { quantity: 3 });
    expect([strip.base_price, strip.rate, strip.quantity, strip.actual, strip.unit]).toEqual([
      1250,
      1250,
      3,
      3750,
      "strip",
    ]);
    await addRate("cghs", "strip", { rate: 12.35 });
    const cghs = await price("strip", { quantity: "5", category: c("pensioner") });
    expect([cghs.rate, cghs.quantity, cghs.actual]).toEqual([1235, 5, 6175]);
    await addRate("cghs", "gauze", { rate: 0.1, valid_from: "2026-10-01", valid_to: "2026-10-15" });
    const gauze = await price("gauze", { quantity: 7, category: c("paid") });
    expect([gauze.rate, gauze.actual], "0.10 × 7 is 70 paise, not a float").toEqual([10, 70]);
    expect(Number.isInteger(gauze.actual)).toBe(true);
  });

  test("7. quantity rules", async () => {
    const line = (item, quantity) => ({ item: ids[item], quantity, date: DAY });
    await refusedWith(line("meet", 2), 400, /is billed one at a time; its quantity must be 1$/);
    await refusedWith(line("strip", 6), 400, /can be billed at most 5 strip on one line$/);
    for (const bad of [0, -1, 1.5, "x", "2.0x"]) {
      await refusedWith(line("strip", bad), 400, /^Quantity must be a whole number from 1 to/);
    }
    expect((await price("strip", { quantity: 5 })).actual, "the maximum is allowed").toBe(6250);
    expect((await price("gauze", { quantity: 1000 })).actual, "no maximum set").toBe(2000000);
    for (const none of [undefined, null, ""]) {
      expect((await price("meet", { quantity: none })).quantity, `${none} means 1`).toBe(1);
    }
    await refusedWith(line("gauze", 2147483647), 400, /is too large for one line$/);
  });

  test("8. bad item, category and date are refused", async () => {
    await refusedWith({ item: 987654321, date: DAY }, 404, /^That item doesn't exist$/);
    await refusedWith({ item: "x", date: DAY }, 400, /^Choose a valid item$/);
    await refusedWith({ item: -4, date: DAY }, 400, /^Choose a valid item$/);
    await refusedWith({ date: DAY }, 400, /^Choose a valid item$/);
    await refusedWith({ item: ids.old, date: DAY }, 409, /is deactivated$/);
    await refusedWith({ item: ids.meet, date: "15/10/2026" }, 400, /^Date must be a date/);
    await refusedWith({ item: ids.meet, date: "2026-02-30" }, 400, /^Date must be a date/);
    const category = (value) => ({ item: ids.meet, date: DAY, category: value });
    await refusedWith(category(`${c("paid")}x`), 404, /^That category doesn't exist$/);
    await refusedWith(category(42), 400, /^Category must be a category code$/);
    await refusedWith(
      category(c("cghs")),
      409,
      /has sub-categories, so a line can't be billed under it/,
    );
    await schemes.createScheme({ code: c("old"), label: `P309 Old ${tag}` }, db, ctx);
    await schemes.updateScheme(c("old"), { is_active: false }, db, ctx);
    await refusedWith(category(c("old")), 409, /is retired$/);
    const spaced = await price("meet", { category: `  ${c("paid").toUpperCase()} ` });
    expect(spaced.category, "code case and spaces").toBe(c("paid"));
  });
});
