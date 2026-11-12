import { test, expect } from "@playwright/test";
import { getPool, query } from "../helpers/db.mjs";
import {
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  allowedValuesOf,
  columnsOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
} from "../helpers/migration.mjs";
import {
  LAB_FIELDS,
  LAB_REPORTS,
  removeLabCatalog,
  seedLabCatalog,
} from "../fixtures/labCatalog.mjs";
import { CAPABILITIES, hasCapability } from "../../shared/permissions.js";
import { catalogRowsFor } from "../../server/services/giniflow/labCatalog.js";
import { formulaInputs } from "../../shared/labFormula.js";

const SQL = readMigration("2026-12-31_lab_test_parameters_editor.sql");

let db = null;

test.describe.serial("LC01 lab catalogue editor: migration", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
  });
  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file inserts no rows, has no comments and runs twice", () => {
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. the orderable test can point at its report and be marked file-only", async () => {
    const columns = await columnsOf(db.client, "giniflow_test_catalog");
    expect(columns).toEqual(expect.arrayContaining(["lab_report_id", "results_as_file"]));
    const missing = await db.refused(
      `UPDATE giniflow_test_catalog SET lab_report_id = -1 WHERE id = (SELECT id FROM giniflow_test_catalog LIMIT 1)`,
    );
    expect(missing).toBe(REFUSED.missingParent);
  });

  test("3. fields gain pick-list options, decimals and an explicit no-unit tick", async () => {
    const columns = await columnsOf(db.client, "lab_test_catalog");
    expect(columns).toEqual(expect.arrayContaining(["options", "decimals", "no_unit"]));
    expect(await allowedValuesOf(db.client, "lab_test_catalog", "input_type")).toEqual([
      "group",
      "numeric",
      "select",
      "text",
    ]);
    const insert = (type, options, decimals) =>
      db.refused(
        `INSERT INTO lab_test_catalog (name, input_type, options, decimals) VALUES ('LC01 probe', $1, $2, $3)`,
        [type, options, decimals],
      );
    expect(await insert("select", ["Nil"], null)).toBe(REFUSED.rule);
    expect(await insert("select", null, null)).toBe(REFUSED.rule);
    expect(await insert("numeric", null, 5)).toBe(REFUSED.rule);
    expect(await insert("select", ["Nil", "Trace", "+"], null)).toBeNull();
    expect(await insert("numeric", null, 1)).toBeNull();
  });

  test("4. the catalogue history is append-only and locked down", async () => {
    await db.client.query(
      `INSERT INTO lab_catalog_audit (entity, entity_id, action, after) VALUES ('field', '1', 'update', '{}')`,
    );
    expect(await db.refused(`UPDATE lab_catalog_audit SET action = 'x'`)).toBe(REFUSED.appendOnly);
    expect(await db.refused(`DELETE FROM lab_catalog_audit`)).toBe(REFUSED.appendOnly);
    expect(
      await db.refused(
        `INSERT INTO lab_catalog_audit (entity, entity_id, action) VALUES ('nonsense', '1', 'update')`,
      ),
    ).toBe(REFUSED.rule);
    const { rls, publicGrants } = await lockdownOf(db.client, ["lab_catalog_audit"]);
    expect(rls).toEqual([
      { relname: "lab_catalog_audit", relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(publicGrants).toEqual([]);
  });
});

test.describe("LC01 lab catalogue editor: who may edit", () => {
  test("admin and lab admin hold LAB_TEST_CATALOG; the lab bench and reception do not", () => {
    const can = (role) => hasCapability({ role }, CAPABILITIES.LAB_TEST_CATALOG);
    expect(can("admin")).toBe(true);
    expect(can("lab_admin")).toBe(true);
    expect(can("lab")).toBe(false);
    expect(can("reception")).toBe(false);
  });
});

test.describe.serial("LC01 lab catalogue editor: test seed", () => {
  test.beforeAll(async () => {
    await seedLabCatalog(query);
  });
  test.afterAll(async () => {
    await removeLabCatalog(query);
  });

  test("every seeded report is linked to its orderable test", async () => {
    const { rows } = await query(
      `SELECT c.test_name, c.lab_report_id::int AS report
         FROM giniflow_test_catalog c WHERE c.lab_report_id IS NOT NULL ORDER BY c.test_name`,
    );
    expect(rows).toEqual(
      LAB_REPORTS.map((r) => ({ test_name: r.catalogTest, report: r.id })).sort((a, b) =>
        a.test_name.localeCompare(b.test_name),
      ),
    );
  });

  test("every formula points at a seeded field", () => {
    const ids = new Set(Object.values(LAB_FIELDS).map((f) => f.id));
    for (const field of Object.values(LAB_FIELDS).filter((f) => f.formula)) {
      for (const input of formulaInputs(field.formula))
        expect(ids.has(input), field.name).toBe(true);
    }
  });

  test("the bench reads Lipid Profile as 8 fields in print order, and a man's HbA1c range", async () => {
    const pool = getPool();
    const rows = await catalogRowsFor(
      ["Lipid Profile", "HbA1c"],
      { sex: "Male", ageYears: 40 },
      pool,
    );
    expect(rows.get("Lipid Profile").map((r) => r.testName)).toEqual(
      LAB_REPORTS[0].fields.map((f) => f.name),
    );
    expect(
      rows.get("Lipid Profile").find((r) => r.testName === "VLDL Cholesterol").calculated,
    ).toBe(true);
    expect(rows.get("HbA1c")[0].refRange).toBe("4 - 6");
  });
});
