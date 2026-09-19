import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../../helpers/db.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const schemas = await import("../../../server/schemas/index.js");
const groups = await import("../../../server/services/billing/serviceGroups.js");
const taxes = await import("../../../server/services/billing/taxCodes.js");
const items = await import("../../../server/services/billing/serviceItems.js");
const categories = await import("../../../server/services/patientSchemes.js");
const rules = await import("../../../server/services/billing/categoryRules.js");
const rates = await import("../../../server/services/billing/categoryRates.js");
const series = await import("../../../server/services/billing/billSeries.js");
const settingsService = await import("../../../server/services/billing/billingSettings.js");

const S = schemas.BILLING_SCHEMAS;
const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: null };
const tag = crypto.randomBytes(3).toString("hex");
const ok = (schema, body) => schema.safeParse(body).success;

const MINIMAL = {
  billingGroupCreateSchema: { code: "G1", name: "Group" },
  billingGroupUpdateSchema: { name: "Group" },
  billingSubgroupCreateSchema: { group_id: 1, code: "S1", name: "Sub" },
  billingSubgroupUpdateSchema: { name: "Sub" },
  billingActiveSchema: { is_active: true },
  billingTaxCodeCreateSchema: { code: "GST18" },
  billingTaxCodeUpdateSchema: { rate_pct: 18 },
  billingItemCreateSchema: {
    code: "I1",
    name: "Item",
    subgroup_id: 1,
    base_price: 100,
    kind: "procedure",
  },
  billingItemUpdateSchema: { name: "Item" },
  billingCategoryCreateSchema: { code: "cghs_x", label: "CGHS" },
  billingCategoryUpdateSchema: { label: "CGHS" },
  billingCategoryRuleCreateSchema: { scheme_code: "senior", name: "60+" },
  billingCategoryRuleUpdateSchema: { name: "60+" },
  billingCategoryRateSaveSchema: { scheme_code: "cghs", service_item_id: 1 },
  billingCategoryRateDeleteQuerySchema: {},
  billingSettingsUpdateSchema: { allow_pay_later: false },
  billingSeriesSaveSchema: { series: "MAIN", fy: "2026-27" },
  billingItemListQuerySchema: {},
  billingListQuerySchema: {},
  billingRateGridQuerySchema: {},
};

test.describe("P1-25 validation schemas", () => {
  test("1. every billing schema is registered and accepts a minimal valid body", () => {
    expect(Object.keys(S).sort()).toEqual(Object.keys(MINIMAL).sort());
    for (const [key, body] of Object.entries(MINIMAL)) {
      const result = S[key].safeParse(body);
      expect(result.success, `${key}: ${JSON.stringify(result.error?.issues)}`).toBe(true);
    }
  });

  test("2. unknown fields are rejected everywhere", () => {
    for (const [key, body] of Object.entries(MINIMAL)) {
      expect(ok(S[key], { ...body, price_override: 1 }), key).toBe(false);
    }
  });

  test("3. update schemas need at least one field", () => {
    for (const key of Object.keys(S).filter((k) => k.endsWith("UpdateSchema"))) {
      expect(ok(S[key], {}), key).toBe(false);
    }
  });

  test("4. money is 0 or more with at most 2 decimals", () => {
    const create = (base_price) => ({ ...MINIMAL.billingItemCreateSchema, base_price });
    for (const good of [0, 1200, 1200.5, 1200.55, "1200", " 1200.50 ", "0"]) {
      expect(ok(S.billingItemCreateSchema, create(good)), `accepts ${JSON.stringify(good)}`).toBe(
        true,
      );
    }
    for (const bad of [-1, 10.005, "1,200", "₹500", "1e3", "12.345", "", true, null, []]) {
      expect(ok(S.billingItemCreateSchema, create(bad)), `refuses ${JSON.stringify(bad)}`).toBe(
        false,
      );
    }
    expect(
      ok(S.billingCategoryRateSaveSchema, { ...MINIMAL.billingCategoryRateSaveSchema, rate: -5 }),
    ).toBe(false);
    expect(
      ok(S.billingCategoryRateSaveSchema, { ...MINIMAL.billingCategoryRateSaveSchema, rate: "" }),
      "blank rate keeps the General price",
    ).toBe(true);
  });

  test("5. types, lists and formats are checked", () => {
    const item = MINIMAL.billingItemCreateSchema;
    expect(ok(S.billingItemCreateSchema, { ...item, kind: "package" })).toBe(false);
    expect(ok(S.billingItemCreateSchema, { ...item, visit_type: "Investigation" })).toBe(false);
    expect(ok(S.billingItemCreateSchema, { ...item, allow_quantity: "true" })).toBe(false);
    expect(ok(S.billingItemCreateSchema, { ...item, subgroup_id: 0 })).toBe(false);
    expect(ok(S.billingItemCreateSchema, { ...item, test_catalog_id: "abc" })).toBe(false);
    expect(ok(S.billingItemCreateSchema, { ...item, code: "A B" })).toBe(false);
    expect(ok(S.billingActiveSchema, { is_active: "false" })).toBe(false);
    expect(ok(S.billingTaxCodeUpdateSchema, { rate_pct: 101 })).toBe(false);
    expect(ok(S.billingTaxCodeUpdateSchema, { sac_hsn: "12345" })).toBe(false);
    expect(
      ok(S.billingCategoryRuleCreateSchema, {
        ...MINIMAL.billingCategoryRuleCreateSchema,
        gender: "M",
      }),
    ).toBe(false);
    expect(
      ok(S.billingCategoryRuleCreateSchema, {
        ...MINIMAL.billingCategoryRuleCreateSchema,
        mode: "force",
      }),
    ).toBe(false);
    expect(ok(S.billingCategoryRateDeleteQuerySchema, { reopen_previous: "yes" })).toBe(false);
    expect(ok(S.billingSettingsUpdateSchema, { discount_stacking: "all" })).toBe(false);
    expect(ok(S.billingSeriesSaveSchema, { series: "MAIN", fy: "2026" })).toBe(false);
  });

  test("6. query strings: true/false text becomes a real boolean, anything else is refused", () => {
    expect(S.billingItemListQuerySchema.parse({ active: "true", groupId: "3" })).toEqual({
      active: true,
      groupId: "3",
    });
    expect(S.billingItemListQuerySchema.parse({ active: "false" })).toEqual({ active: false });
    expect(S.billingListQuerySchema.parse({ activeOnly: "true" })).toEqual({ activeOnly: true });
    for (const bad of [
      { active: "yes" },
      { active: "1" },
      { groupId: "0" },
      { groupId: "abc" },
      { sort: "name" },
    ]) {
      expect(ok(S.billingItemListQuerySchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  test("7. a full valid body passes the schema and is accepted by the real service", async () => {
    const parsed = (key, body) => S[key].parse(body);
    const group = await groups.createGroup(
      parsed("billingGroupCreateSchema", {
        code: `VG-${tag}`,
        name: ` Group ${tag} `,
        sort_order: "5",
      }),
      ctx,
      db,
    );
    const sub = await groups.createSubgroup(
      parsed("billingSubgroupCreateSchema", {
        group_id: String(group.id),
        code: `VS-${tag}`,
        name: "Sub",
        sort_order: "",
      }),
      ctx,
      db,
    );
    const tax = await taxes.createTaxCode(
      parsed("billingTaxCodeCreateSchema", {
        code: `VT-${tag}`,
        sac_hsn: "999312",
        rate_pct: "18",
      }),
      ctx,
      db,
    );
    const item = await items.createItem(
      parsed("billingItemCreateSchema", {
        code: `VI-${tag}`,
        name: "Consult",
        subgroup_id: sub.id,
        base_price: "1200.50",
        unit: "visit",
        allow_quantity: false,
        max_quantity: null,
        tax_code_id: tax.id,
        price_includes_tax: true,
        kind: "consultation",
        doctor_id: String(CONSULTANTS.beant.id),
        visit_type: "Follow Up",
        test_catalog_id: null,
      }),
      ctx,
      db,
    );
    expect(item).toMatchObject({
      base_price: 1200.5,
      visit_type: "Follow Up",
      price_includes_tax: true,
    });
    const updated = await items.updateItem(
      item.id,
      parsed("billingItemUpdateSchema", { base_price: 1300, reason: "Rate card" }),
      ctx,
      db,
    );
    expect(updated.base_price).toBe(1300);
    const category = await categories.createScheme(
      parsed("billingCategoryCreateSchema", {
        code: `v_${tag}`,
        label: `Valid ${tag}`,
        color: "blue",
        parent_code: "",
        payer_name: "Payer",
        requires_ref: true,
        requires_referral: false,
        requires_referral_doc: false,
        print_category_on_bill: true,
        allow_pay_later: "",
        daily_cap: "10",
        sort_order: 3,
      }),
      db,
      ctx,
    );
    expect(category).toMatchObject({ daily_cap: 10, allow_pay_later: null, requires_ref: true });
    const rule = await rules.createRule(
      parsed("billingCategoryRuleCreateSchema", {
        scheme_code: `v_${tag}`,
        name: "Card 60+",
        min_age: "60",
        max_age: "",
        gender: "Female",
        requires_card: true,
        mode: "auto",
        priority: "10",
      }),
      ctx,
      db,
    );
    expect(rule).toMatchObject({ min_age: 60, max_age: null, mode: "auto", priority: 10 });
    const rate = await rates.saveRate(
      parsed("billingCategoryRateSaveSchema", {
        scheme_code: `v_${tag}`,
        service_item_id: String(item.id),
        valid_from: "2026-10-01",
        valid_to: "",
        rate: "900",
        bill_name: "Consult CC02",
        bill_code: "CC02",
      }),
      ctx,
      db,
    );
    expect(rate.rate).toMatchObject({ rate: 900, valid_to: null, bill_code: "CC02" });
    const deleted = await rates.deleteRate(
      {
        scheme_code: `v_${tag}`,
        service_item_id: item.id,
        valid_from: "2026-10-01",
      },
      ctx,
      db,
    );
    expect(deleted.deleted).toBe(true);
    const saved = await series.saveSeries(
      parsed("billingSeriesSaveSchema", {
        series: `v${tag}`,
        fy: "2026-27",
        prefix: "V/",
        number_width: "4",
        next_no: "",
      }),
      ctx,
      db,
    );
    expect(saved.next_number).toBe("V/0001");
    const audit = await query(
      `SELECT count(*)::int AS n FROM billing_audit WHERE entity_id LIKE $1`,
      [`%${tag}%`],
    );
    expect(audit.rows[0].n).toBeGreaterThan(0);
  });

  test("8. numbers too big for the database get a clear 400, never a database error", async () => {
    const HUGE = "99999999999";
    const MONEY_HUGE = "99999999999999";
    const schemaCases = [
      ["billingGroupUpdateSchema", { sort_order: HUGE }],
      ["billingGroupUpdateSchema", { sort_order: -99999999999 }],
      ["billingSubgroupCreateSchema", { group_id: HUGE, code: "S", name: "S" }],
      ["billingItemCreateSchema", { ...MINIMAL.billingItemCreateSchema, base_price: MONEY_HUGE }],
      ["billingItemCreateSchema", { ...MINIMAL.billingItemCreateSchema, base_price: 1e13 }],
      ["billingItemCreateSchema", { ...MINIMAL.billingItemCreateSchema, max_quantity: HUGE }],
      ["billingItemCreateSchema", { ...MINIMAL.billingItemCreateSchema, subgroup_id: 99999999999 }],
      ["billingCategoryUpdateSchema", { daily_cap: HUGE }],
      ["billingCategoryRuleUpdateSchema", { priority: HUGE }],
      ["billingCategoryRateSaveSchema", { scheme_code: "cghs", service_item_id: HUGE }],
      [
        "billingCategoryRateSaveSchema",
        { scheme_code: "cghs", service_item_id: 1, rate: MONEY_HUGE },
      ],
      ["billingSettingsUpdateSchema", { max_codes_per_bill: HUGE }],
      ["billingItemListQuerySchema", { groupId: HUGE }],
    ];
    for (const [key, body] of schemaCases) {
      const result = S[key].safeParse(body);
      expect(result.success, `${key} ${JSON.stringify(body)}`).toBe(false);
      expect(JSON.stringify(result.error.issues)).toMatch(/too large/);
    }
    expect(
      ok(S.billingSeriesSaveSchema, { series: "MAIN", fy: "2026-27", next_no: "99999999999" }),
      "bill numbers may go above the integer range",
    ).toBe(true);

    const client = await db.connect();
    const refused = async (label, fn) => {
      await client.query("SAVEPOINT oversize");
      try {
        await fn();
        return `${label}: accepted`;
      } catch (error) {
        return error.status === 400 && !error.code
          ? null
          : `${label}: ${error.status ?? error.code} ${error.message}`;
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT oversize");
      }
    };
    try {
      await client.query("BEGIN");
      const direct = [
        await refused("group sort order", () =>
          groups.createGroup(
            { code: `OV1-${tag}`, name: "Big", sort_order: 99999999999 },
            ctx,
            client,
          ),
        ),
        await refused("subgroup group id", () =>
          groups.createSubgroup({ group_id: HUGE, code: `OV2-${tag}`, name: "Big" }, ctx, client),
        ),
        await refused("item price", () =>
          items.createItem(
            {
              code: `OV3-${tag}`,
              name: "Big",
              subgroup_id: 1,
              base_price: MONEY_HUGE,
              kind: "other",
            },
            ctx,
            client,
          ),
        ),
        await refused("item subgroup id", () =>
          items.createItem(
            { code: `OV4-${tag}`, name: "Big", subgroup_id: HUGE, base_price: 1, kind: "other" },
            ctx,
            client,
          ),
        ),
        await refused("item max quantity", () =>
          items.createItem(
            {
              code: `OV5-${tag}`,
              name: "Big",
              subgroup_id: 1,
              base_price: 1,
              kind: "other",
              allow_quantity: true,
              max_quantity: HUGE,
            },
            ctx,
            client,
          ),
        ),
        await refused("category daily cap", () =>
          categories.createScheme(
            { code: `ov_${tag}`, label: "Big", daily_cap: HUGE },
            client,
            ctx,
          ),
        ),
        await refused("rule priority", () =>
          rules.createRule(
            { scheme_code: "cghs", name: "Big", min_age: 1, priority: HUGE },
            ctx,
            client,
          ),
        ),
        await refused("rate item id", () =>
          rates.saveRate({ scheme_code: "cghs", service_item_id: HUGE, rate: 1 }, ctx, client),
        ),
        await refused("rate amount", () =>
          rates.saveRate(
            { scheme_code: "cghs", service_item_id: 1, rate: MONEY_HUGE },
            ctx,
            client,
          ),
        ),
        await refused("codes per bill", () =>
          settingsService.updateSettings({ max_codes_per_bill: HUGE }, ctx, client),
        ),
        await refused("item list filter", () => items.listItems({ groupId: HUGE }, client)),
      ];
      expect(
        direct.filter(Boolean),
        "each oversized value is a clean 400 from the service",
      ).toEqual([]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
