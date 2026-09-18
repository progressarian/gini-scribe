import { test, expect } from "@playwright/test";
import { getPool, one } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  CATEGORY_DB_COLUMNS,
  sheetByName,
} from "../../../server/services/billing/importColumns.js";
import {
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  indexesOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-09_billing_categories.sql");
const ORIGINAL_COLUMNS = [
  "code",
  "label",
  "color",
  "is_active",
  "requires_ref",
  "daily_cap",
  "sort_order",
  "created_at",
  "updated_at",
];
const NEW_COLUMNS = {
  parent_code: { type: "text", nullable: "YES", default: null },
  payer_name: { type: "text", nullable: "YES", default: null },
  requires_referral: { type: "boolean", nullable: "NO", default: "false" },
  requires_referral_doc: { type: "boolean", nullable: "NO", default: "false" },
  print_category_on_bill: { type: "boolean", nullable: "NO", default: "false" },
  allow_pay_later: { type: "boolean", nullable: "YES", default: null },
};
const UNDO = `
  DROP TRIGGER IF EXISTS patient_schemes_two_levels_only ON patient_schemes;
  DROP FUNCTION IF EXISTS patient_schemes_two_levels_only();
  ALTER TABLE patient_schemes
    ${Object.keys(NEW_COLUMNS)
      .map((c) => `DROP COLUMN IF EXISTS ${c} CASCADE`)
      .join(",\n    ")};`;

const originalRows = (client) =>
  client
    .query(`SELECT ${ORIGINAL_COLUMNS.join(", ")} FROM patient_schemes ORDER BY code`)
    .then((r) => r.rows);

let db = null;
const add = `INSERT INTO patient_schemes (code, label, parent_code) VALUES ($1, $2, $3)`;

test.describe.serial("P1-08 migration: extend patient_schemes", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL, { undo: UNDO, before: originalRows });
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file alters patient_schemes without recreating it, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).not.toContain("patient_schemes");
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
    expect(SQL).not.toMatch(/\bDROP\b/i);
  });

  test("2. existing categories are untouched and get the defaults", async () => {
    expect(db.snapshot.length).toBeGreaterThan(0);
    expect(await originalRows(db.client)).toEqual(db.snapshot);
    const { rows } = await db.client.query(
      `SELECT count(*)::int AS n FROM patient_schemes
        WHERE parent_code IS NULL AND payer_name IS NULL AND allow_pay_later IS NULL
          AND NOT requires_referral AND NOT requires_referral_doc AND NOT print_category_on_bill`,
    );
    expect(rows[0].n).toBe(db.snapshot.length);
  });

  test("3. the new columns have the planned types, nullability and defaults", async () => {
    const { rows } = await db.client.query(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'patient_schemes'
          AND column_name = ANY($1)`,
      [Object.keys(NEW_COLUMNS)],
    );
    const got = Object.fromEntries(
      rows.map((r) => [
        r.column_name,
        { type: r.data_type, nullable: r.is_nullable, default: r.column_default },
      ]),
    );
    expect(got).toEqual(NEW_COLUMNS);
  });

  test("4. the parent link, its index and the trigger exist", async () => {
    const indexes = await indexesOf(db.client, ["patient_schemes"]);
    expect(indexes.idx_patient_schemes_parent_code).toMatch(
      /\(parent_code\) WHERE \(parent_code IS NOT NULL\)/,
    );
    const { rows } = await db.client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'patient_schemes'::regclass AND conname LIKE 'patient_schemes_%'`,
    );
    const defs = Object.fromEntries(rows.map((r) => [r.conname, r.def]));
    expect(defs.patient_schemes_parent_code_fkey).toMatch(
      /FOREIGN KEY \(parent_code\) REFERENCES patient_schemes\(code\) ON DELETE RESTRICT/,
    );
    expect(defs.patient_schemes_parent_not_self_check).toMatch(/parent_code <> code/);
    const trigger = await db.client.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'patient_schemes'::regclass AND NOT tgisinternal`,
    );
    expect(trigger.rows.map((r) => r.tgname)).toEqual(["patient_schemes_two_levels_only"]);
  });

  test("5. CGHS › Pensioner is allowed, a third level is refused", async () => {
    const { refused } = db;
    expect(await refused(add, ["e2e_cghs", "CGHS test", null])).toBeNull();
    expect(await refused(add, ["e2e_pensioner", "Pensioner", "e2e_cghs"])).toBeNull();
    expect(await refused(add, ["e2e_referral", "CGHS Referral", "e2e_cghs"])).toBeNull();
    expect(await refused(add, ["e2e_paid", "CGHS Paid", "e2e_cghs"])).toBeNull();
    expect(
      await refused(add, ["e2e_under_pensioner", "Too deep", "e2e_pensioner"]),
      "third level on insert",
    ).toBe(REFUSED.rule);
  });

  test("6. moving rows can't create a third level either", async () => {
    const { client, refused } = db;
    await client.query(add, ["e2e_echs", "ECHS test", null]);
    expect(
      await refused(
        `UPDATE patient_schemes SET parent_code = 'e2e_pensioner' WHERE code = 'e2e_echs'`,
      ),
      "a top-level row moved under a sub-category",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE patient_schemes SET parent_code = 'e2e_echs' WHERE code = 'e2e_cghs'`),
      "a category with sub-categories moved under another",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE patient_schemes SET parent_code = 'e2e_echs' WHERE code = 'e2e_paid'`),
      "a sub-category moved to another parent",
    ).toBeNull();
    expect(
      await refused(
        `UPDATE patient_schemes SET label = 'Pensioner (CGHS)' WHERE code = 'e2e_pensioner'`,
      ),
      "editing a sub-category's label",
    ).toBeNull();
  });

  test("7. other rules: no self-parent, no unknown parent, no blank payer, no deleting a parent", async () => {
    const { refused } = db;
    expect(await refused(add, ["e2e_self", "Self", "e2e_self"]), "own parent").toBe(REFUSED.rule);
    expect(await refused(add, ["e2e_orphan", "Orphan", "nope"]), "unknown parent").toBe(
      REFUSED.missingParent,
    );
    expect(
      await refused(`UPDATE patient_schemes SET payer_name = '  ' WHERE code = 'e2e_cghs'`),
      "blank payer name",
    ).toBe(REFUSED.rule);
    expect(
      await refused(
        `UPDATE patient_schemes SET payer_name = 'CGHS Wellness Centre' WHERE code = 'e2e_cghs'`,
      ),
    ).toBeNull();
    expect(
      await refused(`DELETE FROM patient_schemes WHERE code = 'e2e_cghs'`),
      "a parent with sub-categories",
    ).toBe(REFUSED.stillUsed);
  });

  test("8. the refusal message says why", async () => {
    const { client } = db;
    await client.query("SAVEPOINT message");
    const error = await client
      .query(add, ["e2e_deep", "Deep", "e2e_pensioner"])
      .then(() => null)
      .catch((e) => e);
    await client.query("ROLLBACK TO SAVEPOINT message");
    expect(error?.message).toMatch(/already a sub-category.*only two levels are allowed/);
  });

  test("9. the existing scheme service still reads the table", async () => {
    if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
    const { listSchemes } = await import("../../../server/services/patientSchemes.js");
    const rows = await listSchemes({ all: true }, db.client);
    expect(rows.map((r) => r.code)).toEqual(expect.arrayContaining(db.snapshot.map((r) => r.code)));
  });

  test("10. every Categories sheet column maps to a real patient_schemes column", async () => {
    const sheetColumns = sheetByName("Categories").columns.map((c) => c.name);
    expect(Object.keys(CATEGORY_DB_COLUMNS).sort()).toEqual([...sheetColumns].sort());
    const { rows } = await db.client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'patient_schemes'`,
    );
    const dbColumns = rows.map((r) => r.column_name);
    for (const [sheetColumn, dbColumn] of Object.entries(CATEGORY_DB_COLUMNS)) {
      expect(dbColumns, `${sheetColumn} → ${dbColumn}`).toContain(dbColumn);
    }
  });

  test("11. the test database was built with this migration applied", async () => {
    const row = await one(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'patient_schemes' AND column_name = ANY($1)`,
      [Object.keys(NEW_COLUMNS)],
    );
    expect(row.n).toBe(Object.keys(NEW_COLUMNS).length);
  });
});

test.describe("P1-08 trigger under concurrent edits", () => {
  test("12. two simultaneous edits can't create a third level", async () => {
    const pool = getPool();
    const first = await pool.connect();
    const second = await pool.connect();
    const codes = ["e2e_race_top", "e2e_race_other", "e2e_race_child"];
    try {
      await first.query(`DELETE FROM patient_schemes WHERE code = ANY($1)`, [codes]);
      await first.query(
        `INSERT INTO patient_schemes (code, label) VALUES ('e2e_race_top', 'Top'), ('e2e_race_other', 'Other')`,
      );
      await first.query("BEGIN");
      await first.query(
        `UPDATE patient_schemes SET parent_code = 'e2e_race_other' WHERE code = 'e2e_race_top'`,
      );
      await second.query("BEGIN");
      const racing = second
        .query(
          `INSERT INTO patient_schemes (code, label, parent_code) VALUES ('e2e_race_child', 'Child', 'e2e_race_top')`,
        )
        .then(() => null)
        .catch((e) => e.code);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await first.query("COMMIT");
      expect(await racing, "the second edit sees the first and is refused").toBe(REFUSED.rule);
      await second.query("ROLLBACK");
      const { rows } = await first.query(
        `SELECT count(*)::int AS n FROM patient_schemes c
           JOIN patient_schemes p ON p.code = c.parent_code
          WHERE p.parent_code IS NOT NULL`,
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await second.query("ROLLBACK").catch(() => {});
      await first.query("ROLLBACK").catch(() => {});
      await first.query(`UPDATE patient_schemes SET parent_code = NULL WHERE code = ANY($1)`, [
        codes,
      ]);
      await first.query(`DELETE FROM patient_schemes WHERE code = ANY($1)`, [codes]);
      first.release();
      second.release();
    }
  });
});
