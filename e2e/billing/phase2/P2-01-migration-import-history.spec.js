import { test, expect } from "@playwright/test";
import {
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
import { USERS } from "../../fixtures/data.mjs";

const SQL = readMigration("2026-10-12_billing_imports.sql");
const COLUMNS = ["counts", "file_name", "id", "imported_at", "imported_by", "status"];

let db = null;

test.describe.serial("P2-01 migration: import history", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates only billing_imports, seeds nothing and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toEqual(["billing_imports"]);
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice and has exactly the planned columns", async () => {
    expect(await columnsOf(db.client, "billing_imports")).toEqual(COLUMNS);
    expect(await allowedValuesOf(db.client, "billing_imports", "status")).toEqual([
      "failed",
      "saved",
    ]);
  });

  test("3. a saved import records who, when and the counts per sheet", async () => {
    const { rows } = await db.client.query(
      `INSERT INTO billing_imports (file_name, imported_by, counts, status)
       VALUES ('master.xlsx', $1, $2, 'saved')
       RETURNING file_name, imported_by, counts, status, imported_at IS NOT NULL AS stamped`,
      [USERS.admin.id, { Groups: { new: 2, update: 1, unchanged: 0 } }],
    );
    expect(rows[0]).toEqual({
      file_name: "master.xlsx",
      imported_by: USERS.admin.id,
      counts: { Groups: { new: 2, update: 1, unchanged: 0 } },
      status: "saved",
      stamped: true,
    });
    const defaults = await db.client.query(
      `INSERT INTO billing_imports (file_name, status) VALUES ('empty.xlsx', 'failed')
       RETURNING counts, imported_by`,
    );
    expect(defaults.rows[0]).toEqual({ counts: {}, imported_by: null });
  });

  test("4. bad rows are refused", async () => {
    const add = `INSERT INTO billing_imports (file_name, imported_by, counts, status) VALUES ($1, $2, $3, $4)`;
    const { refused } = db;
    expect(await refused(add, ["  ", null, {}, "saved"]), "blank file name").toBe(REFUSED.rule);
    expect(await refused(add, ["a.xlsx", null, {}, "previewed"]), "unknown status").toBe(
      REFUSED.rule,
    );
    expect(
      await refused(add, ["a.xlsx", null, JSON.stringify([1, 2]), "saved"]),
      "counts list",
    ).toBe(REFUSED.rule);
    expect(await refused(add, ["a.xlsx", 999999999, {}, "saved"]), "unknown user").toBe(
      REFUSED.missingParent,
    );
    expect(await refused(`INSERT INTO billing_imports (file_name) VALUES ('a.xlsx')`)).toBe(
      "23502",
    );
  });

  test("5. the history is indexed by time and locked down like the other billing tables", async () => {
    const indexes = await indexesOf(db.client, ["billing_imports"]);
    expect(indexes.billing_imports_imported_at_idx).toMatch(/\(imported_at DESC\)/);
    const { rls, publicGrants } = await lockdownOf(db.client, ["billing_imports"]);
    expect(rls).toEqual([
      { relname: "billing_imports", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(publicGrants).toEqual([]);
  });
});

const LINK_SQL = readMigration("2026-10-13_billing_imports_link.sql");

test.describe
  .serial("P2-01 review: every import names its user, and audit rows point at their import", () => {
  let link = null;
  test.beforeAll(async () => {
    link = await openFreshCopy(LINK_SQL);
  });
  test.afterAll(async () => {
    await link?.close();
  });

  test("6. the follow-up file only alters, seeds nothing, has no comments and runs twice", async () => {
    expect(tablesCreatedBy(LINK_SQL)).toEqual([]);
    expect(LINK_SQL).not.toMatch(SEEDS_ROWS);
    expect(LINK_SQL).not.toMatch(HAS_COMMENTS);
    expect(await columnsOf(link.client, "billing_audit")).toContain("import_id");
  });

  test("7. an import must name who imported it", async () => {
    expect(
      await link.refused(
        `INSERT INTO billing_imports (file_name, status) VALUES ('nobody.xlsx', 'saved')`,
      ),
    ).toBe("23502");
  });

  test("8. an audit row can point at its import; nothing else can, and the import can't then be deleted", async () => {
    const imported = await link.client.query(
      `INSERT INTO billing_imports (file_name, imported_by, status)
       VALUES ('rates.xlsx', $1, 'saved') RETURNING id`,
      [USERS.admin.id],
    );
    const importId = imported.rows[0].id;
    const audit = `INSERT INTO billing_audit (entity, entity_id, action, actor_id, import_id)
                   VALUES ('service_items', '1', 'update', $1, $2)`;
    expect(await link.refused(audit, [USERS.admin.id, importId])).toBeNull();
    expect(
      await link.refused(audit, [USERS.admin.id, null]),
      "a screen edit has no import",
    ).toBeNull();
    expect(await link.refused(audit, [USERS.admin.id, 999999999]), "an unknown import").toBe(
      REFUSED.missingParent,
    );
    expect(
      await link.refused(`DELETE FROM billing_imports WHERE id = $1`, [importId]),
      "an import its audit rows point at",
    ).toBe(REFUSED.stillUsed);
    const indexes = await indexesOf(link.client, ["billing_audit"]);
    expect(indexes.billing_audit_import_idx).toMatch(
      /\(import_id, at\) WHERE \(import_id IS NOT NULL\)/,
    );
  });
});
