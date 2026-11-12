import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";
import { getPool, query } from "../helpers/db.mjs";
import { buildTestEnv, repoRoot } from "../setup/testEnv.mjs";
import { LAB_REPORTS, removeLabCatalog, seedLabCatalog } from "../fixtures/labCatalog.mjs";
import { catalogRowsFor } from "../../server/services/giniflow/labCatalog.js";

const SCRIPT = path.join(repoRoot, "server", "scripts", "link-test-catalog-reports.mjs");
const [LIPID, HBA1C, RFT] = LAB_REPORTS;
const MAN = { sex: "Male", ageYears: 40 };

const fieldsFor = async (name) =>
  ((await catalogRowsFor([name], MAN, getPool())).get(name) || []).map((r) => r.testName);

const runScript = (...args) => {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.join(repoRoot, "server"),
    env: buildTestEnv(),
    encoding: "utf8",
  });
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
};

const linkOf = async (testName) =>
  (
    await query(`SELECT lab_report_id::int AS id FROM giniflow_test_catalog WHERE test_name = $1`, [
      testName,
    ])
  ).rows[0]?.id ?? null;

test.describe.serial("LC02 a test finds its result fields through its link", () => {
  test.beforeEach(async () => {
    await seedLabCatalog(query);
  });
  test.afterAll(async () => {
    await query(`DELETE FROM giniflow_test_catalog WHERE test_name = 'Kidney Panel LC02'`);
    await removeLabCatalog(query);
  });

  test("1. renaming the report keeps the fields, because the test is linked", async () => {
    await query(`UPDATE lab_report_catalog SET name = 'Lipid Panel LC02' WHERE id = $1`, [
      LIPID.id,
    ]);
    expect(await fieldsFor("Lipid Profile")).toEqual(LIPID.fields.map((f) => f.name));
  });

  test("2. without the link the same rename loses the fields — the old name-only behaviour", async () => {
    await query(
      `UPDATE giniflow_test_catalog SET lab_report_id = NULL WHERE test_name = 'Lipid Profile'`,
    );
    await query(`UPDATE lab_report_catalog SET name = 'Lipid Panel LC02' WHERE id = $1`, [
      LIPID.id,
    ]);
    expect(await fieldsFor("Lipid Profile")).toEqual([]);
  });

  test("3. a test whose name matches no report is found by its link alone", async () => {
    await query(
      `INSERT INTO giniflow_test_catalog (test_name, category, price, source, lab_report_id)
       VALUES ('Kidney Panel LC02', 'lab', 700, 'e2e_fixture', $1)`,
      [RFT.id],
    );
    expect(await fieldsFor("Kidney Panel LC02")).toEqual(RFT.fields.map((f) => f.name));
  });

  test("4. a link wins over a different report that only matches by name", async () => {
    await query(
      `INSERT INTO lab_report_catalog (id, name, aliases, source) VALUES (990099, 'HbA1c', '{}', 'manual')`,
    );
    await query(
      `INSERT INTO lab_report_tests (report_id, test_id, sequence) VALUES (990099, 990303, 1)`,
    );
    try {
      await query(`UPDATE giniflow_test_catalog SET lab_report_id = $1 WHERE test_name = 'HbA1c'`, [
        HBA1C.id,
      ]);
      expect(await fieldsFor("HbA1c")).toEqual(["HbA1c"]);
      await query(
        `UPDATE giniflow_test_catalog SET lab_report_id = NULL WHERE test_name = 'HbA1c'`,
      );
      expect((await fieldsFor("HbA1c")).sort()).toEqual(["Creatinine, Serum", "HbA1c"]);
    } finally {
      await query(`DELETE FROM lab_report_catalog WHERE id = 990099`);
    }
  });

  test("5. a link to a switched-off report falls back to the name match", async () => {
    await query(`UPDATE lab_report_catalog SET is_active = FALSE WHERE id = $1`, [LIPID.id]);
    expect(await fieldsFor("Lipid Profile")).toEqual([]);
    await query(`UPDATE lab_report_catalog SET is_active = TRUE WHERE id = $1`, [LIPID.id]);
    expect(await fieldsFor("LIPID PROFILE")).toEqual(LIPID.fields.map((f) => f.name));
  });
});

const countAfter = (output, label) => {
  const match = output.match(new RegExp(`${label}: (\\d+)`));
  return match ? Number(match[1]) : null;
};
const TO_LINK = "tests to link \\(exactly one report\\)";
const NO_REPORT = "tests with no report \\(left unlinked\\)";

test.describe.serial("LC02 backfill script", () => {
  let startedAt = null;
  let toLink = null;

  test.beforeAll(async () => {
    await seedLabCatalog(query);
    await query(`UPDATE giniflow_test_catalog SET lab_report_id = NULL`);
    startedAt = (await query(`SELECT now() AS t`)).rows[0].t;
  });
  test.afterAll(async () => {
    await query(`UPDATE giniflow_test_catalog SET results_as_file = FALSE WHERE test_name = 'ABI'`);
    await removeLabCatalog(query);
  });

  test("1. the dry run lists the seeded tests, writes nothing, and skips file-only tests", async () => {
    const before = (await query(`SELECT count(*)::int AS n FROM lab_catalog_audit`)).rows[0].n;
    const run = runScript();
    expect(run.status, run.output).toBe(0);
    toLink = countAfter(run.output, TO_LINK);
    expect(toLink).toBeGreaterThanOrEqual(3);
    for (const name of ["Lipid Profile", "HbA1c", "RFT"]) expect(run.output).toContain(`'${name}'`);
    expect(run.output).toContain(`dry run: first batch would link ${toLink} test(s); rolled back`);
    expect(await linkOf("Lipid Profile")).toBeNull();
    expect((await query(`SELECT count(*)::int AS n FROM lab_catalog_audit`)).rows[0].n).toBe(
      before,
    );

    const unlinked = countAfter(run.output, NO_REPORT);
    await query(`UPDATE giniflow_test_catalog SET results_as_file = TRUE WHERE test_name = 'ABI'`);
    const again = runScript();
    expect(countAfter(again.output, NO_REPORT)).toBe(unlinked - 1);
  });

  test("2. --apply links each test to its one report and records it in the history", async () => {
    const run = runScript("--apply");
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain(`done: ${toLink} test(s) linked`);
    expect(await linkOf("Lipid Profile")).toBe(LIPID.id);
    expect(await linkOf("HbA1c")).toBe(HBA1C.id);
    expect(await linkOf("RFT")).toBe(RFT.id);
    expect(await linkOf("ABI")).toBeNull();
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM lab_catalog_audit
        WHERE entity = 'link' AND action = 'backfill' AND at >= $1`,
      [startedAt],
    );
    expect(rows[0].n).toBe(toLink);
  });
  test("3. a second run finds nothing left to do", async () => {
    const run = runScript("--apply");
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("tests to link (exactly one report): 0");
    expect(run.output).toContain("done: 0 test(s) linked");
  });

  test("4. a test matching two reports is listed and left unlinked", async () => {
    await query(`UPDATE giniflow_test_catalog SET lab_report_id = NULL WHERE test_name = 'HbA1c'`);
    await query(
      `INSERT INTO lab_report_catalog (id, name, aliases, source) VALUES (990098, 'Glycated Hb', '{HbA1c}', 'manual')`,
    );
    try {
      const run = runScript();
      expect(run.output).toContain("tests matching more than one report (left unlinked): 1");
      expect(run.output).toMatch(/HbA1c.*(Glycated Hb.*HBA1C|HBA1C.*Glycated Hb)/);
    } finally {
      await query(`DELETE FROM lab_report_catalog WHERE id = 990098`);
    }
  });
});
