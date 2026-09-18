import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import {
  CATEGORY_RATE_DB_COLUMNS,
  CATEGORY_RULE_DB_COLUMNS,
  CATEGORY_RULE_MODES,
  GENDERS,
  sheetByName,
} from "../../../server/services/billing/importColumns.js";
import {
  AUDIT_COLUMNS,
  allowedValuesOf,
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-09_billing_categories.sql");
const TABLES = ["category_rules", "category_item_rates"];
const COLUMNS = {
  category_rules: [
    "id",
    "scheme_code",
    "name",
    "min_age",
    "max_age",
    "gender",
    "requires_card",
    "mode",
    "priority",
    "is_active",
    ...AUDIT_COLUMNS,
  ],
  category_item_rates: [
    "scheme_code",
    "service_item_id",
    "rate",
    "bill_name",
    "bill_code",
    "valid_from",
    "valid_to",
    ...AUDIT_COLUMNS,
  ],
};

let db = null;
let itemId = null;

const addRule = `INSERT INTO category_rules (scheme_code, name, min_age, max_age, gender, requires_card, mode)
  VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), COALESCE($7, 'suggest'))`;
const rule = (o = {}) => [
  o.scheme ?? "e2e_senior",
  o.name ?? "Rule",
  o.min ?? null,
  o.max ?? null,
  o.gender ?? null,
  o.card ?? null,
  o.mode ?? null,
];
const addRate = `INSERT INTO category_item_rates
  (scheme_code, service_item_id, rate, bill_name, bill_code, valid_from, valid_to)
  VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7)`;
const rate = (o = {}) => [
  o.scheme ?? "e2e_cghs",
  o.item ?? itemId,
  o.rate ?? null,
  o.name ?? null,
  o.code ?? null,
  o.from ?? null,
  o.to ?? null,
];

test.describe.serial("P1-09 migration: category rules and category rates", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    const { client } = db;
    await client.query(
      `INSERT INTO patient_schemes (code, label) VALUES ('e2e_cghs', 'CGHS test'), ('e2e_senior', 'Senior test')`,
    );
    const group = await client.query(
      `INSERT INTO service_groups (code, name) VALUES ('E2E-G9', 'Group') RETURNING id`,
    );
    const sub = await client.query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'E2E-S9', 'Sub') RETURNING id`,
      [group.rows[0].id],
    );
    const item = await client.query(
      `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
       VALUES ('E2E-DRESS9', 'Dressing', $1, 300, 'procedure') RETURNING id`,
      [sub.rows[0].id],
    );
    itemId = item.rows[0].id;
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates both tables, inserts no rows and has no comments", () => {
    for (const table of TABLES) expect(tablesCreatedBy(SQL)).toContain(table);
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. the tables have exactly the planned columns", async () => {
    for (const table of TABLES) {
      expect(await columnsOf(db.client, table), table).toEqual([...COLUMNS[table]].sort());
    }
  });

  test("3. keys and indexes", async () => {
    const indexes = await indexesOf(db.client, TABLES);
    expect(indexes.category_rules_scheme_name_key).toMatch(
      /UNIQUE INDEX .*\(scheme_code, lower\(name\)\)/,
    );
    expect(indexes.category_item_rates_pkey).toMatch(
      /UNIQUE INDEX .*\(scheme_code, service_item_id, valid_from\)/,
    );
    expect(indexes.category_rules_active_priority_idx).toMatch(/\(priority\) WHERE is_active/);
    expect(indexes.category_item_rates_item_idx).toMatch(
      /\(service_item_id, scheme_code, valid_from DESC\)/,
    );
  });

  test("4. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, TABLES);
    expect(rls).toHaveLength(TABLES.length);
    for (const row of rls) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
    expect(publicGrants).toEqual([]);
  });

  test("5. no rules or rates are seeded", async () => {
    for (const table of TABLES) {
      const { rows } = await db.client.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  test("6. the database and the Excel template agree", async () => {
    expect(await allowedValuesOf(db.client, "category_rules", "gender")).toEqual(
      [...GENDERS].sort(),
    );
    expect(await allowedValuesOf(db.client, "category_rules", "mode")).toEqual(
      [...CATEGORY_RULE_MODES].sort(),
    );
    for (const [sheet, map, table] of [
      ["Category rules", CATEGORY_RULE_DB_COLUMNS, "category_rules"],
      ["Category rates", CATEGORY_RATE_DB_COLUMNS, "category_item_rates"],
    ]) {
      const sheetColumns = sheetByName(sheet).columns.map((c) => c.name);
      expect(Object.keys(map).sort(), sheet).toEqual([...sheetColumns].sort());
      const dbColumns = await columnsOf(db.client, table);
      for (const [from, to] of Object.entries(map)) {
        expect(dbColumns, `${sheet}.${from} → ${to}`).toContain(to);
      }
    }
  });

  test("7. category rules follow the rules", async () => {
    const { client, refused } = db;
    expect(await refused(addRule, rule({ name: "Age 60 and over", min: 60 }))).toBeNull();
    const saved = await client.query(
      `SELECT mode, priority, is_active, requires_card FROM category_rules WHERE name = 'Age 60 and over'`,
    );
    expect(saved.rows[0]).toEqual({
      mode: "suggest",
      priority: 100,
      is_active: true,
      requires_card: false,
    });
    expect(await refused(addRule, rule({ name: "Age 60 and over", min: 65 })), "same name").toBe(
      REFUSED.duplicate,
    );
    expect(
      await refused(addRule, rule({ name: "age 60 AND over", min: 65 })),
      "same name in another case",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(addRule, rule({ scheme: "e2e_cghs", name: "Age 60 and over", card: true })),
      "same name in another category is fine",
    ).toBeNull();
    expect(await refused(addRule, rule({ name: "Nothing" })), "a rule with no criterion").toBe(
      REFUSED.rule,
    );
    expect(await refused(addRule, rule({ name: "Backwards", min: 70, max: 60 }))).toBe(
      REFUSED.rule,
    );
    expect(await refused(addRule, rule({ name: "Negative", min: -1 }))).toBe(REFUSED.rule);
    expect(await refused(addRule, rule({ name: "Too old", max: 151 }))).toBe(REFUSED.rule);
    expect(await refused(addRule, rule({ name: "Bad gender", gender: "M" }))).toBe(REFUSED.rule);
    expect(await refused(addRule, rule({ name: "Bad mode", min: 1, mode: "force" }))).toBe(
      REFUSED.rule,
    );
    expect(await refused(addRule, rule({ name: " ", min: 1 })), "blank name").toBe(REFUSED.rule);
    expect(await refused(addRule, rule({ scheme: "nope", name: "Orphan", min: 1 }))).toBe(
      REFUSED.missingParent,
    );
    expect(
      await refused(addRule, rule({ name: "Women 60+", min: 60, gender: "Female", mode: "auto" })),
    ).toBeNull();
    expect(
      await refused(`DELETE FROM patient_schemes WHERE code = 'e2e_senior'`),
      "a category with rules can't be deleted",
    ).toBe(REFUSED.stillUsed);
  });

  test("8. category rates follow the rules", async () => {
    const { refused } = db;
    expect(
      await refused(
        addRate,
        rate({ rate: 250, name: "Dressing (CGHS)", code: "CC02", from: "2026-10-01" }),
      ),
    ).toBeNull();
    expect(
      await refused(addRate, rate({ rate: 260, from: "2026-10-01" })),
      "same category, item and start date",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(addRate, rate({ rate: 275, from: "2027-04-01" })),
      "a future rate card for the same item",
    ).toBeNull();
    expect(
      await refused(addRate, rate({ scheme: "e2e_senior", code: "SC1", from: "2026-10-01" })),
      "only a bill code, keeping the General price",
    ).toBeNull();
    expect(
      await refused(addRate, rate({ scheme: "e2e_senior", from: "2026-11-01" })),
      "changes nothing",
    ).toBe(REFUSED.rule);
    expect(await refused(addRate, rate({ rate: -1, from: "2026-12-01" }))).toBe(REFUSED.rule);
    expect(
      await refused(addRate, rate({ rate: 0, from: "2026-12-02" })),
      "a 0 rate is allowed",
    ).toBeNull();
    expect(
      await refused(addRate, rate({ code: "C C", from: "2026-12-03" })),
      "space in bill code",
    ).toBe(REFUSED.rule);
    expect(
      await refused(addRate, rate({ name: "  ", from: "2026-12-04" })),
      "blank bill name",
    ).toBe(REFUSED.rule);
    expect(
      await refused(addRate, rate({ rate: 1, from: "2026-12-05", to: "2026-12-04" })),
      "ends before it starts",
    ).toBe(REFUSED.rule);
    expect(await refused(addRate, rate({ rate: 1, item: -1, from: "2026-12-06" }))).toBe(
      REFUSED.missingParent,
    );
    expect(await refused(addRate, rate({ scheme: "nope", rate: 1, from: "2026-12-07" }))).toBe(
      REFUSED.missingParent,
    );
    expect(
      await refused(`DELETE FROM service_items WHERE id = $1`, [itemId]),
      "an item with category rates can't be deleted",
    ).toBe(REFUSED.stillUsed);
    expect(
      await refused(`DELETE FROM patient_schemes WHERE code = 'e2e_cghs'`),
      "a category with rates can't be deleted",
    ).toBe(REFUSED.stillUsed);
  });

  test("9. a rate saved without a start date starts on today's India date", async () => {
    const { client } = db;
    await client.query(
      `INSERT INTO category_item_rates (scheme_code, service_item_id, bill_code) VALUES ('e2e_cghs', $1, 'TODAY')`,
      [itemId],
    );
    const { rows } = await client.query(
      `SELECT valid_from = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS india_today,
              pg_get_expr(d.adbin, d.adrelid) AS default_expr
         FROM category_item_rates r
         JOIN pg_attrdef d ON d.adrelid = 'category_item_rates'::regclass
         JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum AND a.attname = 'valid_from'
        WHERE r.bill_code = 'TODAY'`,
    );
    expect(rows[0].india_today).toBe(true);
    expect(rows[0].default_expr).toMatch(/Asia\/Kolkata/);
  });

  test("10. the test database was built with both tables", async () => {
    for (const table of TABLES) {
      const row = await one(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
      expect(row.t, table).toBe(table);
    }
  });
});
