import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
import {
  CONSULTATION_VISIT_TYPES,
  ITEM_KINDS,
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

const SQL = readMigration("2026-10-08_billing_service_master.sql");
const TABLES = ["service_items", "service_item_price_history"];
const COLUMNS = {
  service_items: [
    "id",
    "code",
    "name",
    "subgroup_id",
    "base_price",
    "unit",
    "allow_quantity",
    "max_quantity",
    "tax_code_id",
    "price_includes_tax",
    "kind",
    "doctor_id",
    "visit_type",
    "test_catalog_id",
    "is_active",
    ...AUDIT_COLUMNS,
  ],
  service_item_price_history: [
    "id",
    "service_item_id",
    "old_price",
    "new_price",
    "reason",
    "changed_by",
    "changed_at",
  ],
};

let db = null;
let subgroupId = null;
let catalogIds = [];

const ADD = `INSERT INTO service_items
  (code, name, subgroup_id, base_price, kind, doctor_id, visit_type, test_catalog_id,
   allow_quantity, max_quantity, is_active)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, FALSE), $10, COALESCE($11, TRUE))
  RETURNING id`;

const item = (overrides = {}) => {
  const row = {
    code: "ITEM",
    name: "Item",
    subgroup: subgroupId,
    price: 100,
    kind: "other",
    doctor: null,
    visitType: null,
    catalog: null,
    allowQuantity: null,
    maxQuantity: null,
    active: null,
    ...overrides,
  };
  return [
    row.code,
    row.name,
    row.subgroup,
    row.price,
    row.kind,
    row.doctor,
    row.visitType,
    row.catalog,
    row.allowQuantity,
    row.maxQuantity,
    row.active,
  ];
};

test.describe.serial("P1-06 migration: service items and price history", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    const group = await db.client.query(
      `INSERT INTO service_groups (code, name) VALUES ('T-G', 'Test group') RETURNING id`,
    );
    const sub = await db.client.query(
      `INSERT INTO service_subgroups (group_id, code, name) VALUES ($1, 'T-S', 'Test sub') RETURNING id`,
      [group.rows[0].id],
    );
    subgroupId = sub.rows[0].id;
    const catalog = await db.client.query(
      `SELECT id FROM giniflow_test_catalog ORDER BY test_name LIMIT 2`,
    );
    catalogIds = catalog.rows.map((r) => r.id);
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

  test("3. the planned indexes exist", async () => {
    const indexes = await indexesOf(db.client, TABLES);
    expect(indexes.service_items_code_key).toMatch(/UNIQUE INDEX .*lower\(code\)/);
    expect(indexes.service_items_consultation_key).toMatch(
      /UNIQUE INDEX .*\(doctor_id, visit_type\) NULLS NOT DISTINCT WHERE \(\(kind = 'consultation'::text\) AND is_active\)/,
    );
    expect(indexes.service_items_test_catalog_key).toMatch(
      /UNIQUE INDEX .*\(test_catalog_id\) WHERE \(test_catalog_id IS NOT NULL\)/,
    );
    expect(indexes.service_items_subgroup_id_idx).toMatch(/\(subgroup_id\)/);
    expect(indexes.service_items_tax_code_id_idx).toMatch(/\(tax_code_id\)/);
    expect(indexes.service_item_price_history_item_idx).toMatch(
      /\(service_item_id, changed_at DESC\)/,
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

  test("5. no items or price history are seeded", async () => {
    for (const table of TABLES) {
      const { rows } = await db.client.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  test("6. a plain item gets the planned defaults", async () => {
    const { rows } = await db.client.query(ADD, item({ code: "DRESS", name: "Dressing" }));
    const saved = await db.client.query(
      `SELECT unit, allow_quantity, max_quantity, tax_code_id, price_includes_tax, is_active
         FROM service_items WHERE id = $1`,
      [rows[0].id],
    );
    expect(saved.rows[0]).toEqual({
      unit: "each",
      allow_quantity: false,
      max_quantity: null,
      tax_code_id: null,
      price_includes_tax: false,
      is_active: true,
    });
  });

  test("7. codes, names, prices and quantities follow the rules", async () => {
    const { refused } = db;
    expect(await refused(ADD, item({ code: "dress" })), "case duplicate").toBe(REFUSED.duplicate);
    expect(await refused(ADD, item({ code: "A B" })), "space in code").toBe(REFUSED.rule);
    expect(await refused(ADD, item({ code: "BLANKNAME", name: " " })), "blank name").toBe(
      REFUSED.rule,
    );
    expect(await refused(ADD, item({ code: "NEG", price: -1 })), "negative price").toBe(
      REFUSED.rule,
    );
    expect(await refused(ADD, item({ code: "NOSUB", subgroup: -1 })), "missing subgroup").toBe(
      REFUSED.missingParent,
    );
    expect(await refused(ADD, item({ code: "BADKIND", kind: "package" })), "unknown kind").toBe(
      REFUSED.rule,
    );
    expect(
      await refused(ADD, item({ code: "MAXNOQTY", maxQuantity: 3 })),
      "max quantity without allow_quantity",
    ).toBe(REFUSED.rule);
    expect(
      await refused(ADD, item({ code: "MAXZERO", allowQuantity: true, maxQuantity: 0 })),
      "max quantity 0",
    ).toBe(REFUSED.rule);
    expect(
      await refused(ADD, item({ code: "QTY", allowQuantity: true, maxQuantity: 5 })),
    ).toBeNull();
    expect(await refused(ADD, item({ code: "FREE", price: 0 })), "a 0 price is allowed").toBeNull();
  });

  test("8. consultation items need a New or Follow Up visit type, one per doctor", async () => {
    const { refused } = db;
    const doctor = CONSULTANTS.rahul.id;
    const consult = (code, extra) => item({ code, kind: "consultation", doctor, ...extra });
    expect(await refused(ADD, consult("C-NEW", { visitType: "New" }))).toBeNull();
    expect(await refused(ADD, consult("C-FU", { visitType: "Follow Up" }))).toBeNull();
    expect(
      await refused(ADD, consult("C-INV", { visitType: "Investigation" })),
      "no fee for Investigation",
    ).toBe(REFUSED.rule);
    expect(await refused(ADD, consult("C-NOVT", {})), "no visit type").toBe(REFUSED.rule);
    expect(
      await refused(ADD, consult("C-NEW2", { visitType: "New" })),
      "second active New item for the same doctor",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(ADD, consult("C-OLD", { visitType: "New", active: false })),
      "an inactive duplicate is allowed",
    ).toBeNull();
    expect(
      await refused(ADD, item({ code: "P-DR", kind: "procedure", doctor })),
      "doctor on a non-consultation item",
    ).toBe(REFUSED.rule);
    expect(
      await refused(ADD, item({ code: "P-VT", kind: "procedure", visitType: "New" })),
      "visit type on a non-consultation item",
    ).toBe(REFUSED.rule);
  });

  test("9. one hospital default consultation item per visit type, with no doctor", async () => {
    const { refused } = db;
    const fallback = (code, visitType, extra = {}) =>
      item({ code, kind: "consultation", visitType, ...extra });
    expect(await refused(ADD, fallback("D-NEW", "New")), "default New fee").toBeNull();
    expect(await refused(ADD, fallback("D-FU", "Follow Up")), "default Follow Up fee").toBeNull();
    expect(await refused(ADD, fallback("D-NEW2", "New")), "a second active default New fee").toBe(
      REFUSED.duplicate,
    );
    expect(
      await refused(ADD, fallback("D-OLD", "New", { active: false })),
      "an inactive old default is allowed",
    ).toBeNull();
    expect(
      await refused(ADD, fallback("D-INV", "Investigation")),
      "no default fee for Investigation",
    ).toBe(REFUSED.rule);
  });

  test("10. test items need a catalogue test, and each test has one item", async () => {
    const { refused } = db;
    expect(catalogIds).toHaveLength(2);
    const [first, second] = catalogIds;
    expect(await refused(ADD, item({ code: "T1", kind: "test", catalog: first }))).toBeNull();
    expect(
      await refused(ADD, item({ code: "T1-DUP", kind: "test", catalog: first })),
      "second item for the same test",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(ADD, item({ code: "T1-OLD", kind: "test", catalog: first, active: false })),
      "even an inactive second item",
    ).toBe(REFUSED.duplicate);
    expect(await refused(ADD, item({ code: "T-NOCAT", kind: "test" })), "no test link").toBe(
      REFUSED.rule,
    );
    expect(
      await refused(ADD, item({ code: "O-CAT", kind: "other", catalog: second })),
      "test link on a non-test item",
    ).toBe(REFUSED.rule);
    expect(
      await refused(
        ADD,
        item({ code: "T-BADCAT", kind: "test", catalog: "00000000-0000-0000-0000-000000000000" }),
      ),
      "unknown catalogue test",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(`DELETE FROM giniflow_test_catalog WHERE id = $1`, [first]),
      "a priced catalogue test can't be deleted",
    ).toBe(REFUSED.stillUsed);
  });

  test("11. price history needs a reason and follows its item", async () => {
    const { client, refused } = db;
    const { rows } = await client.query(ADD, item({ code: "HIST", price: 500 }));
    const itemId = rows[0].id;
    const addHistory = `INSERT INTO service_item_price_history
      (service_item_id, old_price, new_price, reason, changed_by) VALUES ($1, $2, $3, $4, $5)`;
    const by = CONSULTANTS.banshali.id;
    expect(await refused(addHistory, [itemId, null, 500, "Created", by])).toBeNull();
    expect(await refused(addHistory, [itemId, 500, 600, "New rate card", by])).toBeNull();
    expect(await refused(addHistory, [itemId, 600, 700, "  ", by]), "blank reason").toBe(
      REFUSED.rule,
    );
    expect(await refused(addHistory, [itemId, 600, -1, "Typo", by]), "negative price").toBe(
      REFUSED.rule,
    );
    expect(await refused(addHistory, [-1, 1, 2, "Orphan", by]), "unknown item").toBe(
      REFUSED.missingParent,
    );
    const history = await client.query(
      `SELECT old_price, new_price FROM service_item_price_history
        WHERE service_item_id = $1 ORDER BY id`,
      [itemId],
    );
    expect(history.rows).toEqual([
      { old_price: null, new_price: "500.00" },
      { old_price: "500.00", new_price: "600.00" },
    ]);
    await client.query(`DELETE FROM service_items WHERE id = $1`, [itemId]);
    const left = await client.query(
      `SELECT count(*)::int AS n FROM service_item_price_history WHERE service_item_id = $1`,
      [itemId],
    );
    expect(left.rows[0].n).toBe(0);
  });

  test("12. a subgroup or tax code in use can't be deleted", async () => {
    const { client, refused } = db;
    const tax = await client.query(
      `INSERT INTO tax_codes (code, rate_pct) VALUES ('T-GST', 18) RETURNING id`,
    );
    await client.query(`UPDATE service_items SET tax_code_id = $1 WHERE code = 'DRESS'`, [
      tax.rows[0].id,
    ]);
    expect(await refused(`DELETE FROM tax_codes WHERE id = $1`, [tax.rows[0].id])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM service_subgroups WHERE id = $1`, [subgroupId])).toBe(
      REFUSED.stillUsed,
    );
  });

  test("13. the database and the Excel template allow the same kinds and visit types", async () => {
    expect(await allowedValuesOf(db.client, "service_items", "kind")).toEqual(
      [...ITEM_KINDS].sort(),
    );
    expect(await allowedValuesOf(db.client, "service_items", "visit_type")).toEqual(
      [...CONSULTATION_VISIT_TYPES].sort(),
    );
  });

  test("14. the test database was built with both tables", async () => {
    for (const table of TABLES) {
      const row = await one(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
      expect(row.t, table).toBe(table);
    }
  });
});
