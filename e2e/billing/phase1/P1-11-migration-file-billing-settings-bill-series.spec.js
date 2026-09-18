import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import {
  HAS_COMMENTS,
  REFUSED,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-10_billing_settings_audit.sql");
const TABLES = ["billing_settings", "bill_series", "billing_audit"];
const COLUMNS = {
  billing_settings: [
    "id",
    "discount_stacking",
    "allow_pay_later",
    "max_codes_per_bill",
    "gst_enabled",
    "gstin",
    "state_code",
    "legal_name",
    "bill_footer",
    "updated_at",
    "updated_by",
  ],
  bill_series: [
    "series",
    "fy",
    "prefix",
    "number_width",
    "next_no",
    "created_at",
    "created_by",
    "updated_at",
    "updated_by",
  ],
  billing_audit: ["id", "entity", "entity_id", "action", "before", "after", "actor_id", "at", "ip"],
};
const VALID_GSTIN = "03AAAAA0000A1Z5";

let db = null;

test.describe.serial("P1-11 migration: billing settings, bill series, audit", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates the three tables, inserts only the settings row and has no comments", () => {
    for (const table of TABLES) expect(tablesCreatedBy(SQL)).toContain(table);
    const writes = [...SQL.matchAll(/^\s*(INSERT|COPY|UPDATE|DELETE)\b.*$/gim)].map((m) =>
      m[0].trim(),
    );
    expect(writes).toEqual([
      "INSERT INTO billing_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;",
    ]);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. the tables have exactly the planned columns", async () => {
    for (const table of TABLES) {
      expect(await columnsOf(db.client, table), table).toEqual([...COLUMNS[table]].sort());
    }
  });

  test("3. after running twice there is exactly one settings row, with the safe defaults", async () => {
    const { rows } = await db.client.query(
      `SELECT discount_stacking, allow_pay_later, max_codes_per_bill, gst_enabled, gstin,
              state_code, legal_name, bill_footer FROM billing_settings`,
    );
    expect(rows).toEqual([
      {
        discount_stacking: "best_only",
        allow_pay_later: false,
        max_codes_per_bill: null,
        gst_enabled: false,
        gstin: null,
        state_code: null,
        legal_name: null,
        bill_footer: null,
      },
    ]);
    for (const table of ["bill_series", "billing_audit"]) {
      const count = await db.client.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(count.rows[0].n, table).toBe(0);
    }
  });

  test("4. a second settings row is impossible", async () => {
    const { refused } = db;
    expect(await refused(`INSERT INTO billing_settings (id) VALUES (TRUE)`)).toBe(
      REFUSED.duplicate,
    );
    expect(await refused(`INSERT INTO billing_settings (id) VALUES (FALSE)`)).toBe(REFUSED.rule);
    expect(await refused(`DELETE FROM billing_settings`), "deleting the only row").toBe(
      REFUSED.appendOnly,
    );
    const { rows } = await db.client.query(`SELECT count(*)::int AS n FROM billing_settings`);
    expect(rows[0].n).toBe(1);
  });

  test("5. settings rules", async () => {
    const { refused } = db;
    const set = (sql) => refused(`UPDATE billing_settings SET ${sql}`);
    expect(await set(`discount_stacking = 'stack_all'`), "unknown stacking").toBe(REFUSED.rule);
    expect(await set(`max_codes_per_bill = 0`)).toBe(REFUSED.rule);
    expect(await set(`max_codes_per_bill = 2`)).toBeNull();
    expect(await set(`gstin = '03aaaaa0000a1z5'`), "lower-case GSTIN").toBe(REFUSED.rule);
    expect(await set(`gstin = '03AAAAA0000A1Z'`), "short GSTIN").toBe(REFUSED.rule);
    expect(await set(`state_code = '3'`), "one-digit state").toBe(REFUSED.rule);
    expect(
      await set(`gstin = '${VALID_GSTIN}', state_code = '04'`),
      "GSTIN from another state",
    ).toBe(REFUSED.rule);
    expect(await set(`legal_name = '  '`), "blank legal name").toBe(REFUSED.rule);
    expect(await set(`gst_enabled = TRUE`), "GST on without details").toBe(REFUSED.rule);
    expect(
      await set(
        `gstin = '${VALID_GSTIN}', state_code = '03', legal_name = 'Hospital Ltd', gst_enabled = TRUE`,
      ),
      "GST on with full details",
    ).toBeNull();
    expect(await set(`gstin = NULL`), "clearing the GSTIN while GST is on").toBe(REFUSED.rule);
  });

  test("6. bill series rules", async () => {
    const { refused } = db;
    const add = `INSERT INTO bill_series (series, fy, prefix, next_no) VALUES ($1, $2, $3, $4)`;
    expect(await refused(add, ["MAIN", "2026-27", "GAC/26-27/", 1])).toBeNull();
    expect(await refused(add, ["RCPT", "2026-27", "RCPT/26-27/", 1])).toBeNull();
    expect(
      await refused(add, ["MAIN", "2099-00", "X/", 1]),
      "a year that rolls over the century",
    ).toBeNull();
    expect(await refused(add, ["MAIN", "2026-27", "", 1]), "same series and year").toBe(
      REFUSED.duplicate,
    );
    expect(await refused(add, ["MAIN", "2026-28", "", 1]), "years not consecutive").toBe(
      REFUSED.rule,
    );
    expect(await refused(add, ["MAIN", "26-27", "", 1]), "short year").toBe(REFUSED.rule);
    expect(await refused(add, ["MAIN", "ab-cd", "", 1]), "letters for a year").toBe(REFUSED.rule);
    expect(await refused(add, ["MAIN", "2026-2", "", 1]), "one-digit end year").toBe(REFUSED.rule);
    expect(await refused(add, ["MA IN", "2027-28", "", 1]), "space in series").toBe(REFUSED.rule);
    expect(await refused(add, ["MAIN", "2027-28", "", 0]), "number 0").toBe(REFUSED.rule);
    const saved = await db.client.query(
      `SELECT prefix, number_width, next_no FROM bill_series WHERE series = 'MAIN' AND fy = '2026-27'`,
    );
    expect(saved.rows[0]).toEqual({ prefix: "GAC/26-27/", number_width: 6, next_no: "1" });
  });

  test("7. the audit log is append-only", async () => {
    const { client, refused } = db;
    const add = `INSERT INTO billing_audit (entity, entity_id, action, before, after, actor_id, ip)
                 VALUES ($1, $2, $3, $4, $5, NULL, $6)`;
    expect(
      await refused(add, [
        "service_items",
        "12",
        "update",
        { base_price: 500 },
        { base_price: 600 },
        "10.0.0.1",
      ]),
    ).toBeNull();
    expect(await refused(add, [" ", "1", "create", null, {}, null]), "blank entity").toBe(
      REFUSED.rule,
    );
    const { rows } = await client.query(`SELECT id, at IS NOT NULL AS stamped FROM billing_audit`);
    expect(rows).toHaveLength(1);
    expect(rows[0].stamped).toBe(true);
    expect(await refused(`UPDATE billing_audit SET action = 'x'`), "changing a row").toBe(
      REFUSED.appendOnly,
    );
    expect(await refused(`DELETE FROM billing_audit`), "deleting a row").toBe(REFUSED.appendOnly);
    await client.query(
      `INSERT INTO doctors (id, name, role, pin, is_active) VALUES (99001, 'E2E Audit Actor', 'reception', 'x', TRUE)`,
    );
    await client.query(
      `INSERT INTO billing_audit (entity, entity_id, action, actor_id) VALUES ('probe', '1', 'create', 99001)`,
    );
    expect(
      await refused(`DELETE FROM doctors WHERE id = 99001`),
      "a user in the log can't be deleted (deactivate instead)",
    ).toBe(REFUSED.stillUsed);
  });

  test("8. indexes, RLS and no public access", async () => {
    const indexes = await indexesOf(db.client, TABLES);
    expect(indexes.bill_series_pkey).toMatch(/\(series, fy\)/);
    expect(indexes.billing_audit_entity_idx).toMatch(/\(entity, entity_id, at DESC\)/);
    expect(indexes.billing_audit_at_idx).toMatch(/\(at DESC\)/);
    expect(indexes.billing_audit_actor_idx).toMatch(/\(actor_id, at DESC\)/);
    const { rls, publicGrants } = await lockdownOf(db.client, TABLES);
    expect(rls).toHaveLength(TABLES.length);
    for (const row of rls) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
    expect(publicGrants).toEqual([]);
  });
});

test.describe("P1-11 settings row in the test database", () => {
  test("9. the test database has the settings row, even after a reset", async () => {
    const row = await one(
      `SELECT count(*)::int AS n, bool_and(NOT gst_enabled) AS gst_off FROM billing_settings`,
    );
    expect(row).toEqual({ n: 1, gst_off: true });
  });
});
