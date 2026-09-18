import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import {
  AUDIT_COLUMNS,
  REFUSED,
  HAS_COMMENTS,
  SEEDS_ROWS,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-08_billing_service_master.sql");
const COLUMNS = ["id", "code", "sac_hsn", "rate_pct", "is_active", ...AUDIT_COLUMNS];

let db = null;

test.describe.serial("P1-05 migration: tax codes", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates tax_codes, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toContain("tax_codes");
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. the whole file runs twice on fresh tables and tax_codes has the planned columns", async () => {
    expect(await columnsOf(db.client, "tax_codes")).toEqual([...COLUMNS].sort());
    const { rows } = await db.client.query(
      `SELECT data_type, numeric_precision, numeric_scale, column_default
         FROM information_schema.columns
        WHERE table_name = 'tax_codes' AND column_name = 'rate_pct'`,
    );
    expect(rows[0]).toMatchObject({ data_type: "numeric", numeric_precision: 5, numeric_scale: 2 });
    expect(rows[0].column_default).toBe("0");
  });

  test("3. codes are unique ignoring case", async () => {
    const indexes = await indexesOf(db.client, ["tax_codes"]);
    expect(indexes.tax_codes_code_key).toMatch(/UNIQUE INDEX .*lower\(code\)/);
  });

  test("4. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, ["tax_codes"]);
    expect(rls).toEqual([
      { relname: "tax_codes", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(publicGrants).toEqual([]);
  });

  test("5. no tax code is seeded", async () => {
    const { rows } = await db.client.query(`SELECT count(*)::int AS n FROM tax_codes`);
    expect(rows[0].n).toBe(0);
  });

  test("6. the rules hold", async () => {
    const { client, refused } = db;
    const add = `INSERT INTO tax_codes (code, sac_hsn, rate_pct) VALUES ($1, $2, $3)`;
    await client.query(add, ["EXEMPT-HC", "999312", 0]);
    await client.query(add, ["GST18", null, 18]);
    const row = await client.query(
      `SELECT rate_pct, is_active FROM tax_codes WHERE code = 'EXEMPT-HC'`,
    );
    expect(row.rows[0]).toEqual({ rate_pct: "0.00", is_active: true });
    expect(await refused(add, ["gst18", null, 5]), "case duplicate").toBe(REFUSED.duplicate);
    expect(await refused(add, ["GST 5", null, 5]), "space in code").toBe(REFUSED.rule);
    expect(await refused(add, ["", null, 5]), "blank code").toBe(REFUSED.rule);
    expect(await refused(add, ["NEG", null, -1]), "negative rate").toBe(REFUSED.rule);
    expect(await refused(add, ["BIG", null, 100.01]), "rate over 100").toBe(REFUSED.rule);
    expect(await refused(add, ["SAC1", "99-31", 5]), "SAC with a dash").toBe(REFUSED.rule);
    expect(await refused(add, ["SAC2", "123", 5]), "SAC too short").toBe(REFUSED.rule);
    expect(await refused(add, ["SAC5", "12345", 5]), "5-digit SAC/HSN").toBe(REFUSED.rule);
    expect(await refused(add, ["SAC7", "1234567", 5]), "7-digit SAC/HSN").toBe(REFUSED.rule);
    expect(await refused(add, ["SAC9", "123456789", 5]), "9-digit SAC/HSN").toBe(REFUSED.rule);
    for (const [code, sac] of [
      ["HSN4", "3004"],
      ["HSN8", "30049099"],
    ])
      expect(await refused(add, [code, sac, 12]), `${sac} is accepted`).toBeNull();
    expect(await refused(add, ["FULL", "999312", 100]), "a 100% rate is accepted").toBeNull();
  });

  test("7. the test database was built with tax_codes", async () => {
    const row = await one(`SELECT to_regclass('public.tax_codes') AS t`);
    expect(row.t).toBe("tax_codes");
  });
});
