import { test, expect } from "@playwright/test";
import {
  BILLING_ROLES,
  DISCOUNT_KINDS,
  DISCOUNT_METHODS,
  GENDERS,
  VISIT_TYPES,
} from "../../../shared/billingVocab.js";
import {
  DISCOUNT_DB_COLUMNS,
  parseRow,
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

const { whereUsed } = await import("../../../server/services/billing/usage.js");
const { saveRate } = await import("../../../server/services/billing/categoryRates.js");
const { checkMasterRows } = await import("../../../server/services/billing/importValidate.js");

const SQL = readMigration("2026-10-14_billing_rules.sql");
const TABLE = "discount_rules";
const COLUMNS = [
  "id",
  "code",
  "name",
  "method",
  "kind",
  "value",
  "max_discount",
  "group_ids",
  "subgroup_ids",
  "service_item_ids",
  "doctor_ids",
  "visit_types",
  "scheme_codes",
  "min_age",
  "max_age",
  "gender",
  "valid_from",
  "valid_to",
  "max_uses_total",
  "max_uses_per_patient",
  "max_uses_per_day",
  "max_uses_per_doctor_per_day",
  "applies_per",
  "priority",
  "stackable",
  "applies_on_scheme_rate",
  "allowed_roles",
  "is_active",
  ...AUDIT_COLUMNS,
];

let db = null;
const ids = {};

const FIELDS = [
  "code",
  "name",
  "method",
  "kind",
  "value",
  "max_discount",
  "group_ids",
  "subgroup_ids",
  "service_item_ids",
  "doctor_ids",
  "visit_types",
  "scheme_codes",
  "min_age",
  "max_age",
  "gender",
  "valid_from",
  "valid_to",
  "max_uses_total",
  "max_uses_per_patient",
  "max_uses_per_day",
  "max_uses_per_doctor_per_day",
  "priority",
  "allowed_roles",
];
const addDiscount = `INSERT INTO discount_rules (${FIELDS.join(", ")})
  VALUES (${FIELDS.map((_, i) => `$${i + 1}`).join(", ")})`;
const discount = (o = {}) => {
  const d = {
    code: null,
    name: "Rule",
    method: "auto",
    kind: "percent",
    value: 10,
    priority: 100,
    ...o,
  };
  return FIELDS.map((f) => d[f] ?? null);
};

test.describe.serial("P3-02 migration: discount rules", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    const { client } = db;
    await client.query(
      `INSERT INTO patient_schemes (code, label) VALUES ('p302_cghs', 'CGHS test')`,
    );
    ids.group = (
      await client.query(
        `INSERT INTO service_groups (code, name) VALUES ('P302-G', 'Lab test') RETURNING id`,
      )
    ).rows[0].id;
    ids.subgroup = (
      await client.query(
        `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'P302-S', 'Bio test') RETURNING id`,
        [ids.group],
      )
    ).rows[0].id;
    ids.item = (
      await client.query(
        `INSERT INTO service_items (code, name, subgroup_id, base_price, kind)
         VALUES ('P302-I', 'Dressing test', $1, 300, 'procedure') RETURNING id`,
        [ids.subgroup],
      )
    ).rows[0].id;
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates the discount rules table too, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toEqual(["category_payment_rules", TABLE]);
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice and has exactly the planned columns", async () => {
    expect(await columnsOf(db.client, TABLE)).toEqual([...COLUMNS].sort());
  });

  test("3. codes and names are unique ignoring case, and active rules are indexed", async () => {
    const indexes = await indexesOf(db.client, [TABLE]);
    expect(indexes.discount_rules_code_key).toMatch(
      /UNIQUE INDEX .*\(lower\(code\)\) WHERE \(code IS NOT NULL\)/,
    );
    expect(indexes.discount_rules_name_key).toMatch(/UNIQUE INDEX .*\(lower\(name\)\)/);
    expect(indexes.discount_rules_active_idx).toMatch(/\(priority\) WHERE is_active/);
  });

  test("4. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, [TABLE]);
    expect(rls).toEqual([{ relname: TABLE, relrowsecurity: true, relforcerowsecurity: true }]);
    expect(publicGrants).toEqual([]);
  });

  test("5. no discount rules are seeded", async () => {
    expect((await db.client.query(`SELECT count(*)::int AS n FROM ${TABLE}`)).rows[0].n).toBe(0);
  });

  test("6. the allowed values match the shared vocabulary, and the defaults are the planned ones", async () => {
    const { client, refused } = db;
    expect(await allowedValuesOf(client, TABLE, "method")).toEqual([...DISCOUNT_METHODS].sort());
    expect(await allowedValuesOf(client, TABLE, "kind")).toEqual([...DISCOUNT_KINDS].sort());
    expect(await allowedValuesOf(client, TABLE, "gender")).toEqual([...GENDERS].sort());
    expect(await allowedValuesOf(client, TABLE, "applies_per")).toEqual(["bill", "line"]);
    expect(
      await refused(addDiscount, discount({ name: "All visits", visit_types: VISIT_TYPES })),
    ).toBeNull();
    expect(
      await refused(addDiscount, discount({ name: "All roles", allowed_roles: BILLING_ROLES })),
    ).toBeNull();
    const { rows } = await client.query(
      `INSERT INTO ${TABLE} (name, method, kind, value) VALUES ('Defaults', 'auto', 'flat', 50)
       RETURNING applies_per, priority, stackable, applies_on_scheme_rate, is_active`,
    );
    expect(rows[0]).toEqual({
      applies_per: "line",
      priority: 100,
      stackable: false,
      applies_on_scheme_rate: false,
      is_active: true,
    });
  });

  test("7. a doctor coupon with every limit saves", async () => {
    expect(
      await db.refused(
        addDiscount,
        discount({
          name: "Dr coupon",
          method: "code",
          code: "DRA10",
          value: 10,
          max_discount: 500,
          doctor_ids: [9101],
          group_ids: [ids.group],
          subgroup_ids: [ids.subgroup],
          service_item_ids: [ids.item],
          scheme_codes: ["general", "p302_cghs"],
          visit_types: ["New"],
          min_age: 60,
          max_age: 90,
          gender: "Female",
          valid_from: "2026-10-01",
          valid_to: "2026-12-31",
          max_uses_total: 100,
          max_uses_per_patient: 1,
          max_uses_per_day: 10,
          max_uses_per_doctor_per_day: 5,
          allowed_roles: ["reception_admin", "admin"],
        }),
      ),
    ).toBeNull();
  });

  test("8. the rules hold", async () => {
    const { refused } = db;
    const bad = [
      ["a code with a space", { name: "B1", method: "code", code: "STAFF 10" }],
      ["a code rule without a code", { name: "B2", method: "code" }],
      ["an automatic rule with a code", { name: "B3", code: "AUTO1" }],
      ["over 100 per cent", { name: "B4", value: 100.01 }],
      ["a negative value", { name: "B5", kind: "flat", value: -1 }],
      ["a cap on a flat discount", { name: "B6", kind: "flat", value: 50, max_discount: 20 }],
      ["a negative cap", { name: "B7", max_discount: -1 }],
      ["an unknown kind", { name: "B8", kind: "free" }],
      ["an unknown method", { name: "B9", method: "manual" }],
      ["ages the wrong way round", { name: "B10", min_age: 70, max_age: 60 }],
      ["an age over 150", { name: "B11", min_age: 151 }],
      ["an unknown gender", { name: "B12", gender: "F" }],
      [
        "an end before the start",
        { name: "B13", valid_from: "2026-10-10", valid_to: "2026-10-09" },
      ],
      ["a total limit of 0", { name: "B14", max_uses_total: 0 }],
      ["a per-patient limit of 0", { name: "B15", max_uses_per_patient: 0 }],
      ["a daily limit of 0", { name: "B16", max_uses_per_day: 0 }],
      ["a per-doctor daily limit of 0", { name: "B17", max_uses_per_doctor_per_day: 0 }],
      ["an empty group list", { name: "B18", group_ids: [] }],
      ["a group listed twice", { name: "B19", group_ids: [ids.group, ids.group] }],
      ["a blank in the item list", { name: "B20", service_item_ids: [ids.item, null] }],
      ["an unknown visit type", { name: "B21", visit_types: ["Tele"] }],
      ["a category listed twice", { name: "B22", scheme_codes: ["general", "general"] }],
      ["an unknown role", { name: "B23", allowed_roles: ["lab"] }],
      ["a doctor listed twice", { name: "B24", doctor_ids: [9101, 9101] }],
      ["a name with a trailing space", { name: "Spaced " }],
      ["a blank name", { name: "   " }],
      ["a negative priority", { name: "B25", priority: -1 }],
    ];
    for (const [why, o] of bad)
      expect(await refused(addDiscount, discount(o)), why).toBe(REFUSED.rule);
    expect(
      await refused(
        `INSERT INTO ${TABLE} (name, method, kind, value, applies_per) VALUES ('B26', 'auto', 'flat', 5, 'visit')`,
      ),
      "an unknown applies_per",
    ).toBe(REFUSED.rule);

    expect(
      await refused(addDiscount, discount({ name: "Staff", method: "code", code: "STAFF10" })),
    ).toBeNull();
    expect(
      await refused(addDiscount, discount({ name: "Staff two", method: "code", code: "staff10" })),
      "the same code in other letters",
    ).toBe(REFUSED.duplicate);
    expect(await refused(addDiscount, discount({ name: "STAFF" })), "the same name").toBe(
      REFUSED.duplicate,
    );
    expect(
      await refused(addDiscount, discount({ name: "Fixed", kind: "fixed_price", value: 250 })),
    ).toBeNull();
    expect(await refused(addDiscount, discount({ name: "Full off", value: 100 }))).toBeNull();
  });

  test("9. a discount code and a category bill code can never be the same, either way round", async () => {
    const { client, refused } = db;
    await client.query(
      `INSERT INTO category_item_rates (scheme_code, service_item_id, rate, bill_code)
       VALUES ('p302_cghs', $1, 200, 'CC02')`,
      [ids.item],
    );
    await client.query("SAVEPOINT clash");
    const error = await client
      .query(addDiscount, discount({ name: "Clash", method: "code", code: "cc02" }))
      .catch((e) => e);
    await client.query("ROLLBACK TO SAVEPOINT clash");
    expect(error.code).toBe(REFUSED.duplicate);
    expect(error.message).toBe(
      "The discount code cc02 is already a category bill code; choose another code",
    );

    expect(
      await refused(addDiscount, discount({ name: "Camp", method: "code", code: "CAMP5" })),
    ).toBeNull();
    const rateError = await refused(
      `UPDATE category_item_rates SET bill_code = 'camp5' WHERE scheme_code = 'p302_cghs'`,
    );
    expect(rateError, "a bill code changed to a discount code").toBe(REFUSED.duplicate);
    expect(
      await refused(`UPDATE discount_rules SET code = 'CC02' WHERE name = 'Camp'`),
      "a discount code changed to a bill code",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(`UPDATE category_item_rates SET rate = 250 WHERE scheme_code = 'p302_cghs'`),
      "editing a rate without touching its bill code is fine",
    ).toBeNull();
  });

  test("10. a group, subgroup, item or category a discount targets can't be deleted without saying why", async () => {
    const { client } = db;
    await client.query(
      addDiscount,
      discount({
        name: "Targets",
        group_ids: [ids.group],
        subgroup_ids: [ids.subgroup],
        service_item_ids: [ids.item],
        scheme_codes: ["p302_cghs"],
      }),
    );
    const texts = async (kind, key) =>
      (await whereUsed(kind, key, client)).uses.filter((u) => u.table === TABLE).map((u) => u.text);
    expect(await texts("group", ids.group)).toEqual(["2 discount rules cover Lab test"]);
    expect(await texts("subgroup", ids.subgroup)).toEqual(["2 discount rules cover Bio test"]);
    expect(await texts("item", ids.item)).toEqual(["2 discount rules cover Dressing test"]);
    expect(await texts("category", "p302_cghs")).toEqual(["2 discount rules are for CGHS test"]);
  });

  test("11b. review: category codes in the list must look like category codes", async () => {
    const { client, refused } = db;
    for (const [why, codes] of [
      ["capital letters", ["P302_CGHS"]],
      ["a space", ["p302 cghs"]],
      ["one letter", ["x"]],
      ["one good, one bad", ["p302_cghs", "CGHS"]],
    ]) {
      expect([REFUSED.rule, REFUSED.missingParent], why).toContain(
        await refused(addDiscount, discount({ name: `Shape ${why}`, scheme_codes: codes })),
      );
    }
    await client.query(
      `INSERT INTO patient_schemes (code, label) VALUES ('P302_UP', 'Upper test')`,
    );
    expect(
      await refused(addDiscount, discount({ name: "Shape upper", scheme_codes: ["P302_UP"] })),
      "even a category that exists with capitals is refused by the shape rule",
    ).toBe(REFUSED.rule);
    expect(
      await refused(
        addDiscount,
        discount({ name: "Shape ok", scheme_codes: ["general", "p302_cghs"] }),
      ),
    ).toBeNull();
  });

  test("11c. review: every group, subgroup, item, doctor and category a discount names must exist", async () => {
    const { client, refused } = db;
    for (const [why, o] of [
      ["an unknown category", { scheme_codes: ["p302_nope"] }],
      ["an unknown group", { group_ids: [999999] }],
      ["an unknown subgroup", { subgroup_ids: [999999] }],
      ["an unknown item", { service_item_ids: [999999] }],
      ["an unknown doctor", { doctor_ids: [999999] }],
    ]) {
      expect(await refused(addDiscount, discount({ name: `Gone ${why}`, ...o })), why).toBe(
        REFUSED.missingParent,
      );
    }
    await client.query("SAVEPOINT gone");
    const error = await client
      .query(
        addDiscount,
        discount({ name: "Gone both", group_ids: [ids.group, 999998], scheme_codes: ["p302_zz"] }),
      )
      .catch((e) => e);
    await client.query("ROLLBACK TO SAVEPOINT gone");
    expect(error.message).toBe(
      'The discount "Gone both" points at something that does not exist: group 999998, category p302_zz',
    );
    expect(
      await refused(
        addDiscount,
        discount({
          name: "All there",
          group_ids: [ids.group],
          subgroup_ids: [ids.subgroup],
          service_item_ids: [ids.item],
          doctor_ids: [9101],
          scheme_codes: ["general", "p302_cghs"],
        }),
      ),
    ).toBeNull();
    expect(
      await refused(`UPDATE discount_rules SET group_ids = ARRAY[999997] WHERE name = 'All there'`),
      "changing a list to a missing group",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(`UPDATE discount_rules SET value = 12 WHERE name = 'All there'`),
      "changing only the value",
    ).toBeNull();
  });

  test("11. the Category rates screen refuses a bill code that is already a discount code", async () => {
    const error = await saveRate(
      {
        scheme_code: "p302_cghs",
        service_item_id: ids.item,
        rate: 150,
        bill_code: "Staff10",
        valid_from: "2027-01-01",
      },
      { actorId: null },
      db.client,
    ).catch((e) => e);
    expect(error).toMatchObject({
      status: 409,
      message: 'STAFF10 is already the code of the discount "Staff"; choose another bill code',
    });
  });
});

test.describe("P3-02 checks outside the database", () => {
  test("12. the Discounts sheet maps every column to a real table column", async () => {
    const sheetColumns = sheetByName("Discounts").columns.map((c) => c.name);
    expect(Object.keys(DISCOUNT_DB_COLUMNS).sort()).toEqual([...sheetColumns].sort());
    const fresh = await openFreshCopy(SQL);
    try {
      const dbColumns = await columnsOf(fresh.client, TABLE);
      for (const [from, to] of Object.entries(DISCOUNT_DB_COLUMNS)) {
        expect(dbColumns, `${from} → ${to}`).toContain(to);
      }
    } finally {
      await fresh.close();
    }
  });

  test("13. an upload's category rate can't use a discount code as its bill code", () => {
    const sheet = {
      name: "Category rates",
      later: false,
      notImported: 0,
      rows: [
        {
          row: 2,
          input: {},
          ...parseRow(sheetByName("Category rates"), {
            category_code: "cghs",
            item_code: "LAB-A1C",
            valid_from: "2027-01-01",
            rate: 400,
            bill_code: "staff10",
          }),
        },
      ],
    };
    const ref = {
      groups: [{ id: 1, code: "LAB", name: "Lab", is_active: true }],
      subgroups: [{ id: 11, code: "BIO", name: "Bio", group_id: 1, is_active: true }],
      items: [
        {
          id: 101,
          code: "LAB-A1C",
          name: "HbA1c",
          subgroup_id: 11,
          kind: "other",
          is_active: true,
        },
      ],
      doctors: [],
      tests: [],
      taxCodes: [],
      machines: [],
      categories: [
        {
          code: "cghs",
          label: "CGHS",
          parent_code: null,
          is_active: true,
          requires_ref: false,
          daily_cap: null,
        },
      ],
      rules: [],
      rates: [],
      discountCodes: [{ code: "STAFF10", name: "Staff" }],
    };
    const [row] = checkMasterRows([sheet], ref, { canChangeDailyCap: true })[0].rows;
    expect(row.errors).toEqual([
      {
        column: "bill_code",
        message: 'STAFF10 is already the code of the discount "Staff"; choose another bill code',
      },
    ]);
  });
});
