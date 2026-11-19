import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { discountCode, newTag, setUp, tearDown } from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const { priceBill } = await import("../../../server/services/billing/priceBill.js");
const { updateDiscountRule } = await import("../../../server/services/billing/discountRules.js");

const db = getPool();
const tag = newTag();
const admin = { actorId: USERS.admin.id, ip: "10.9.6.61", role: "admin" };
let ids;
let lineCode;
let billCode;

const price = (code) =>
  priceBill(
    {
      lines: [{ item: ids.hba1c }, { item: ids.abi }],
      codes: [code],
      date: ids.day,
      role: "reception",
    },
    db,
  );
const discountOf = (priced, itemId) =>
  priced.lines.find((line) => line.item_id === itemId).discount;

test.describe.serial("P4C-61 a discount can leave outsourced tests at full price", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await query(`UPDATE service_items SET is_outsourced = TRUE WHERE id = $1`, [ids.abi]);
    const both = [ids.hba1c, ids.abi];
    lineCode = `P4-NOOUT-${tag}`;
    billCode = `P4-NOOUTB-${tag}`;
    await discountCode(ids, lineCode, { service_item_ids: both });
    await discountCode(ids, billCode, { service_item_ids: both, applies_per: "bill" });
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. without the option, the code takes 10% off both tests", async () => {
    const priced = await price(lineCode);
    expect(discountOf(priced, ids.hba1c)).toBe(2500);
    expect(discountOf(priced, ids.abi)).toBe(4000);
  });

  test("2. with the option, the outsourced test keeps its full price", async () => {
    const rule = await one(`SELECT id FROM discount_rules WHERE code = $1`, [lineCode]);
    const saved = await updateDiscountRule(rule.id, { excludes_outsourced: true }, admin, db);
    expect(saved.excludes_outsourced).toBe(true);
    const priced = await price(lineCode);
    expect(discountOf(priced, ids.hba1c)).toBe(2500);
    expect(discountOf(priced, ids.abi)).toBe(0);
    expect(priced.totals.discount).toBe(2500);
  });

  test("3. a bill-wide code with the option only spreads over in-house tests", async () => {
    const rule = await one(`SELECT id FROM discount_rules WHERE code = $1`, [billCode]);
    await updateDiscountRule(rule.id, { excludes_outsourced: true }, admin, db);
    const priced = await price(billCode);
    expect(discountOf(priced, ids.hba1c)).toBe(2500);
    expect(discountOf(priced, ids.abi)).toBe(0);
  });

  test("4. on a bill with only outsourced tests the code is refused, not silently ₹0", async () => {
    const priced = await priceBill(
      { lines: [{ item: ids.abi }], codes: [lineCode], date: ids.day, role: "reception" },
      db,
    );
    expect(priced.totals.discount).toBe(0);
    expect(priced.refused_codes.map((entry) => entry.code)).toEqual([lineCode]);
  });
});
