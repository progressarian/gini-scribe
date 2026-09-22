import { test, expect } from "@playwright/test";
import { PATIENT_PAYS, REMAINDERS, VISIT_TYPES } from "../../../shared/billingVocab.js";
import {
  PAYMENT_RULE_DB_COLUMNS,
  sheetByName,
} from "../../../server/services/billing/importColumns.js";
import {
  AUDIT_COLUMNS,
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  allowedValuesOf,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-14_billing_rules.sql");
const TABLE = "category_payment_rules";
const COLUMNS = [
  "id",
  "scheme_code",
  "name",
  "group_id",
  "subgroup_id",
  "service_item_id",
  "visit_types",
  "patient_pays",
  "patient_value",
  "remainder",
  "valid_from",
  "valid_to",
  "priority",
  "is_active",
  ...AUDIT_COLUMNS,
];

let db = null;
const ids = {};

const addRule = `INSERT INTO category_payment_rules
  (scheme_code, name, group_id, subgroup_id, service_item_id, visit_types, patient_pays,
   patient_value, remainder, valid_from, valid_to, priority)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, 'claim'),
          COALESCE($10::date, CURRENT_DATE), $11, COALESCE($12, 100))`;
const rule = (o = {}) => [
  o.scheme ?? "p301_cghs",
  o.name ?? "Rule",
  o.group ?? null,
  o.subgroup ?? null,
  o.item ?? null,
  o.visits ?? null,
  o.pays ?? "full",
  o.value ?? null,
  o.remainder ?? null,
  o.from ?? null,
  o.to ?? null,
  o.priority ?? null,
];

test.describe.serial("P3-01 migration: payment rules", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    const { client } = db;
    await client.query(
      `INSERT INTO patient_schemes (code, label) VALUES ('p301_cghs', 'CGHS test'), ('p301_echs', 'ECHS test')`,
    );
    ids.group = (
      await client.query(
        `INSERT INTO service_groups (code, name) VALUES ('P301-G', 'Group') RETURNING id`,
      )
    ).rows[0].id;
    ids.subgroup = (
      await client.query(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'P301-S', 'Sub') RETURNING id`,
        [ids.group],
      )
    ).rows[0].id;
    ids.item = (
      await client.query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ('P301-I', 'Dressing', $1, 300, 'procedure') RETURNING id`,
        [ids.subgroup],
      )
    ).rows[0].id;
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates the payment rules table, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toContain(TABLE);
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice and has exactly the planned columns", async () => {
    expect(await columnsOf(db.client, TABLE)).toEqual([...COLUMNS].sort());
  });

  test("3. names are unique per category ignoring case, and the lookups are indexed", async () => {
    const indexes = await indexesOf(db.client, [TABLE]);
    expect(indexes.category_payment_rules_scheme_name_key).toMatch(
      /UNIQUE INDEX .*\(scheme_code, lower\(name\)\)/,
    );
    expect(indexes.category_payment_rules_active_idx).toMatch(
      /\(scheme_code, priority\) WHERE is_active/,
    );
    for (const column of ["group_id", "subgroup_id", "service_item_id"]) {
      expect(Object.values(indexes).join("\n"), column).toMatch(
        new RegExp(`\\(${column}\\) WHERE \\(${column} IS NOT NULL\\)`),
      );
    }
  });

  test("4. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, [TABLE]);
    expect(rls).toEqual([{ relname: TABLE, relrowsecurity: true, relforcerowsecurity: true }]);
    expect(publicGrants).toEqual([]);
  });

  test("5. no payment rules are seeded", async () => {
    expect((await db.client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(0);
  });

  test("6. the allowed values match the shared billing vocabulary", async () => {
    expect(await allowedValuesOf(db.client, TABLE, "patient_pays")).toEqual(
      [...PATIENT_PAYS].sort(),
    );
    expect(await allowedValuesOf(db.client, TABLE, "remainder")).toEqual([...REMAINDERS].sort());
    for (const visit of VISIT_TYPES) {
      expect(
        await db.refused(addRule, rule({ name: `Visit ${visit}`, visits: [visit] })),
        visit,
      ).toBeNull();
    }
    expect(await db.refused(addRule, rule({ name: "All visits", visits: VISIT_TYPES }))).toBeNull();
  });

  test("7. a valid rule saves with the planned defaults", async () => {
    const { rows } = await db.client.query(
      `${addRule} RETURNING remainder, priority, is_active, valid_to`,
      rule({ name: "CGHS Paid consultation", item: ids.item, pays: "amount", value: 700 }),
    );
    expect(rows[0]).toEqual({ remainder: "claim", priority: 100, is_active: true, valid_to: null });
    const defaults = await db.client.query(
      `INSERT INTO ${TABLE} (scheme_code, name, patient_pays) VALUES ('p301_echs', 'Default day', 'nothing')
       RETURNING valid_from = (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS india_today`,
    );
    expect(defaults.rows[0].india_today, "the start date defaults to today in India").toBe(true);
  });

  test("8. the rules hold", async () => {
    const { refused } = db;
    const bad = [
      ["blank name", { name: "  " }],
      ["two scopes", { name: "Two", group: ids.group, item: ids.item }],
      ["amount without a value", { name: "A", pays: "amount" }],
      ["percent without a value", { name: "P", pays: "percent" }],
      ["full with a value", { name: "F", pays: "full", value: 10 }],
      ["nothing with a value", { name: "N", pays: "nothing", value: 0 }],
      ["over 100 per cent", { name: "P101", pays: "percent", value: 100.01 }],
      ["negative amount", { name: "Neg", pays: "amount", value: -1 }],
      ["unknown patient_pays", { name: "U", pays: "half" }],
      ["unknown remainder", { name: "R", remainder: "waive" }],
      ["end before start", { name: "D", from: "2026-10-10", to: "2026-10-09" }],
      ["an empty visit list", { name: "V0", visits: [] }],
      ["an unknown visit type", { name: "V1", visits: ["Tele"] }],
      ["a blank in the visit list", { name: "V2", visits: ["New", null] }],
      ["negative priority", { name: "Pr", priority: -1 }],
      ["a visit type twice", { name: "V3", visits: ["New", "New"] }],
      ["a name with a trailing space", { name: "Spaced " }],
      ["a name with a leading space", { name: " Spaced" }],
      ["a name of only a tab and a line break", { name: "\t\n" }],
    ];
    for (const [why, o] of bad) expect(await refused(addRule, rule(o)), why).toBe(REFUSED.rule);

    expect(await refused(addRule, rule({ name: "Unique" }))).toBeNull();
    expect(await refused(addRule, rule({ name: "UNIQUE" })), "same name, other case").toBe(
      REFUSED.duplicate,
    );
    expect(
      await refused(addRule, rule({ name: "Unique", scheme: "p301_echs" })),
      "other category",
    ).toBeNull();
    expect(
      await refused(addRule, rule({ name: "Percent 100", pays: "percent", value: 100 })),
    ).toBeNull();
    expect(await refused(addRule, rule({ name: "Amount 0", pays: "amount", value: 0 }))).toBeNull();
    expect(await refused(addRule, rule({ name: "Group scope", group: ids.group }))).toBeNull();
    expect(await refused(addRule, rule({ name: "Sub scope", subgroup: ids.subgroup }))).toBeNull();
    expect(await refused(addRule, rule({ name: "Nowhere", scheme: "p301_nope" }))).toBe(
      REFUSED.missingParent,
    );
  });

  test("9. a category, group, subgroup or item a rule uses can't be deleted", async () => {
    const { refused } = db;
    expect(await refused(`DELETE FROM service_items WHERE id = $1`, [ids.item])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM service_subgroups WHERE id = $1`, [ids.subgroup])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM service_groups WHERE id = $1`, [ids.group])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM patient_schemes WHERE code = 'p301_echs'`)).toBe(
      REFUSED.stillUsed,
    );
  });
});

test.describe("P3-01 where-is-it-used", () => {
  test("10. the usage helper counts payment rules against categories, groups, subgroups and items", async () => {
    const { USAGE_KINDS } = await import("../../../server/services/billing/usage.js");
    const links = Object.values(USAGE_KINDS).flatMap((kind) =>
      kind.uses.filter((use) => use.table === TABLE).map((use) => `${kind.table}.${use.column}`),
    );
    expect(links.sort()).toEqual(
      [
        "patient_schemes.scheme_code",
        "service_groups.group_id",
        "service_items.service_item_id",
        "service_subgroups.subgroup_id",
      ].sort(),
    );
  });

  test("11. review: the Payment rules sheet maps every column to a real table column", async () => {
    const sheetColumns = sheetByName("Payment rules").columns.map((c) => c.name);
    expect(Object.keys(PAYMENT_RULE_DB_COLUMNS).sort()).toEqual([...sheetColumns].sort());
    const fresh = await openFreshCopy(SQL);
    try {
      const dbColumns = await columnsOf(fresh.client, TABLE);
      for (const [from, to] of Object.entries(PAYMENT_RULE_DB_COLUMNS)) {
        expect(dbColumns, `${from} → ${to}`).toContain(to);
      }
    } finally {
      await fresh.close();
    }
  });

  test("12. review: a delete refused because of a payment rule says so in plain words", async () => {
    const { whereUsed } = await import("../../../server/services/billing/usage.js");
    const fresh = await openFreshCopy(SQL);
    try {
      const { client } = fresh;
      await client.query(`INSERT INTO patient_schemes (code, label) VALUES ('p301_x', 'X scheme')`);
      const group = (
        await client.query(
          `INSERT INTO service_groups (code, name) VALUES ('P301-X', 'Lab X') RETURNING id`,
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO category_payment_rules (scheme_code, name, group_id, patient_pays, patient_value)
         VALUES ('p301_x', 'Lab 20%', $1, 'percent', 20), ('p301_x', 'Lab 10%', $1, 'percent', 10)`,
        [group],
      );
      expect((await whereUsed("group", group, client)).uses.map((u) => u.text)).toEqual([
        "2 payment rules cover Lab X",
      ]);
      expect((await whereUsed("category", "p301_x", client)).uses.map((u) => u.text)).toEqual([
        "2 payment rules for X scheme",
      ]);
    } finally {
      await fresh.close();
    }
  });
});
