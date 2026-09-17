import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { CATALOG_TESTS } from "../../fixtures/data.mjs";
import { getPool, one, query } from "../../helpers/db.mjs";
import { buildTestEnv, repoRoot } from "../../setup/testEnv.mjs";
import {
  TEST_LIST_COLUMNS,
  collectTestList,
  lastColumnLetter,
  mergeTestList,
  normalizeTestName,
} from "../../../server/services/billing/testListExport.js";

const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");
const SCRIPT = path.join(repoRoot, "server", "scripts", "export-billing-test-list.mjs");

const REPORTS = [
  { name: "HBA1C", aliases: ["Glycated Haemoglobin"], active: true },
  { name: "Lipid Profile", aliases: [], active: true },
  { name: "E2E Kidney Function Test", aliases: ["E2E KFT"], active: true },
  { name: "E2E Retired Report", aliases: [], active: false },
];

async function readList(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const ws = workbook.getWorksheet("Tests to price");
  const headers = ws.getRow(1).values.slice(1);
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    rows.push(Object.fromEntries(headers.map((h, i) => [h, row.values[i + 1] ?? null])));
  });
  return { ws, headers, rows };
}

async function tableCounts() {
  const row = await one(
    `SELECT (SELECT COUNT(*) FROM giniflow_test_catalog)::int AS catalog,
            (SELECT COUNT(*) FROM lab_report_catalog)::int AS reports,
            (SELECT COUNT(*) FROM flow_step_catalog)::int AS steps`,
  );
  return row;
}

test.describe("P0-03 export the test list", () => {
  test.beforeAll(async () => {
    await query(`DELETE FROM lab_report_catalog WHERE name = ANY($1)`, [
      REPORTS.map((r) => r.name),
    ]);
    for (const r of REPORTS) {
      await query(
        `INSERT INTO lab_report_catalog (name, aliases, is_active, source) VALUES ($1, $2, $3, 'manual')`,
        [r.name, r.aliases, r.active],
      );
    }
  });

  test.afterAll(async () => {
    await query(`DELETE FROM lab_report_catalog WHERE name = ANY($1)`, [
      REPORTS.map((r) => r.name),
    ]);
  });

  test("the script exports every test once, grouped, without writing to the database", async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-tests-")), "list.xlsx");
    const before = await tableCounts();
    const result = spawnSync(process.execPath, [SCRIPT, out], {
      cwd: path.join(repoRoot, "server"),
      env: buildTestEnv(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("read-only");
    expect(result.stdout).toContain("localhost:5435/gini_scribe_test");
    expect(await tableCounts()).toEqual(before);

    const { ws, headers, rows } = await readList(out);
    expect(headers).toEqual(TEST_LIST_COLUMNS.map((c) => c.header));
    expect(headers.slice(0, 4)).toEqual([
      "test_name",
      "category",
      "current_price",
      "suggested_group",
    ]);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(lastColumnLetter()).toBe(String.fromCharCode(64 + headers.length));
    const filter = ws.autoFilter;
    const filterRef = typeof filter === "string" ? filter : `${filter?.from}:${filter?.to}`;
    expect(filterRef).toContain(`${lastColumnLetter()}${rows.length + 1}`);

    const keys = rows.map((r) => normalizeTestName(r.test_name));
    expect(new Set(keys).size, "no duplicate test names").toBe(keys.length);

    for (const fixture of CATALOG_TESTS) {
      const matches = rows.filter(
        (r) => normalizeTestName(r.test_name) === normalizeTestName(fixture.test_name),
      );
      expect(matches.length, `${fixture.test_name} appears once`).toBe(1);
      expect(matches[0].category).toBe(fixture.category);
      expect(Number(matches[0].current_price)).toBe(fixture.price);
    }

    const byName = Object.fromEntries(rows.map((r) => [r.test_name, r]));
    expect(byName.HbA1c.found_in).toBe("test catalogue, lab report catalogue");
    expect(byName.HbA1c.suggested_group).toBe("Lab");
    expect(byName["Lipid Profile"].found_in).toBe("test catalogue, lab report catalogue");
    expect(byName.HBA1C).toBeUndefined();

    const kft = byName["E2E Kidney Function Test"];
    expect(kft).toMatchObject({
      category: "lab",
      current_price: null,
      suggested_group: "Lab",
      found_in: "lab report catalogue",
    });
    expect(kft.note).toContain("No price yet");
    expect(byName["E2E Retired Report"]).toBeUndefined();

    expect(byName.ABI.suggested_group).toBe("Machine");
    expect(byName.VPT.suggested_group).toBe("Machine");
    const echo = rows.find((r) => normalizeTestName(r.test_name) === "2decho");
    expect(echo?.suggested_group).toBe("ECHO");

    const groups = rows.map((r) => r.suggested_group);
    const order = ["Lab", "Machine", "ECHO", "X-ray", "Offsite"];
    expect([...groups].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(groups);

    const placeholders = await query(
      `SELECT test_name FROM giniflow_test_catalog WHERE is_active AND source = 'prototype_placeholder'`,
    );
    for (const { test_name: name } of placeholders.rows) {
      expect(byName[name]?.note, `${name} flagged as placeholder`).toContain("placeholder");
    }
  });

  test("the export runs inside a read-only transaction and only reads", async () => {
    const real = getPool();
    const seen = [];
    const spyPool = {
      connect: async () => {
        const client = await real.connect();
        return {
          query: (text, params) => {
            seen.push(String(text).trim());
            return client.query(text, params);
          },
          release: () => client.release(),
        };
      },
    };
    const rows = await collectTestList(spyPool);
    expect(rows.length).toBeGreaterThan(0);
    expect(seen[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(seen[seen.length - 1]).toBe("COMMIT");
    for (const text of seen.slice(1, -1)) {
      expect(text, "only SELECT statements").toMatch(/^SELECT\b/i);
    }
  });

  test("names that probably mean the same test are flagged, not merged", () => {
    const rows = mergeTestList({
      catalog: [
        { test_name: "CBC", category: "lab", price: "200", source: "admin" },
        { test_name: "Fasting Insulin", category: "lab", price: "700", source: "admin" },
        { test_name: "Vit B12", category: "lab", price: "900", source: "admin" },
        { test_name: "Vit D", category: "lab", price: "900", source: "admin" },
        { test_name: "TSH", category: "lab", price: "280", source: "admin" },
      ],
      reports: [
        { name: "Complete Blood Count(CBC)", aliases: [] },
        { name: "Insulin Fasting", aliases: [] },
        { name: "Vitamin - B12", aliases: [] },
        { name: "VITAMIN - D3", aliases: [] },
      ],
      machines: [],
    });
    const same = Object.fromEntries(rows.map((r) => [r.test_name, r.possibly_same_as]));
    expect(rows).toHaveLength(9);
    expect(same.CBC).toBe("Complete Blood Count(CBC)");
    expect(same["Complete Blood Count(CBC)"]).toBe("CBC");
    expect(same["Fasting Insulin"]).toBe("Insulin Fasting");
    expect(same["Vit B12"]).toBe("Vitamin - B12");
    expect(same["Vit D"]).toBe("");
    expect(same.TSH).toBe("");
  });

  test("a name that adds more than its bracket is not flagged", () => {
    const rows = mergeTestList({
      catalog: [{ test_name: "LFT", category: "lab", price: "350", source: "admin" }],
      reports: [
        { name: "LIVER FUNCTION TEST (LFT)", aliases: [] },
        { name: "Liver Function Test (LFT) with GGT", aliases: [] },
        { name: "Thyroid Panel (TSH) + FT4", aliases: [] },
      ],
      machines: [],
    });
    const same = Object.fromEntries(rows.map((r) => [r.test_name, r.possibly_same_as]));
    expect(same.LFT).toBe("LIVER FUNCTION TEST (LFT)");
    expect(same["Liver Function Test (LFT) with GGT"]).toBe("");
    expect(same["Thyroid Panel (TSH) + FT4"]).toBe("");
  });

  test("catalogue names that differ only in spelling are kept once with a note", () => {
    const rows = mergeTestList({
      catalog: [
        { test_name: "Vit-D", category: "lab", price: "900", source: "admin" },
        { test_name: "VIT D", category: "lab", price: "1200", source: "admin" },
      ],
      reports: [],
      machines: [],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].test_name).toBe("Vit-D");
    expect(rows[0].current_price).toBe(900);
    expect(rows[0].note).toBe('Also listed as "VIT D" (₹1200) — keep one of the two');
  });

  test("a lab report for a retired catalogue test is marked, not shown as new", () => {
    const rows = mergeTestList({
      catalog: [
        {
          test_name: "Vitamin D",
          category: "lab",
          price: "1200",
          source: "admin",
          is_active: false,
        },
        { test_name: "TSH", category: "lab", price: "280", source: "admin", is_active: true },
        {
          test_name: "Old ECG",
          category: "machine",
          price: "300",
          source: "admin",
          is_active: false,
        },
      ],
      reports: [
        { name: "VITAMIN D", aliases: [] },
        { name: "Serum Ferritin", aliases: [] },
      ],
      machines: [],
    });
    const byName = Object.fromEntries(rows.map((r) => [r.test_name, r]));
    expect(byName["Vitamin D"]).toBeUndefined();
    expect(byName["Old ECG"]).toBeUndefined();
    expect(byName["VITAMIN D"]).toMatchObject({
      found_in: "lab report catalogue, retired in test catalogue",
      current_price: null,
    });
    expect(byName["VITAMIN D"].note).toBe(
      '"Vitamin D" was retired in the test catalogue — check before pricing',
    );
    expect(byName["Serum Ferritin"].note).toBe("No price yet — enter the price");
    expect(byName.TSH.found_in).toBe("test catalogue");
  });

  test("the script reports a retired test found in the lab reports", async () => {
    await query(
      `INSERT INTO giniflow_test_catalog (test_name, category, price, is_active, source)
       VALUES ('E2E Retired Panel', 'lab', 450, FALSE, 'e2e_fixture')
       ON CONFLICT (test_name) DO UPDATE SET is_active = FALSE`,
    );
    await query(
      `INSERT INTO lab_report_catalog (name, aliases, is_active, source)
       VALUES ('E2E RETIRED PANEL', '{}', TRUE, 'manual')`,
    );
    try {
      const rows = await collectTestList(getPool());
      const row = rows.find((r) => r.test_name === "E2E RETIRED PANEL");
      expect(row?.found_in).toBe("lab report catalogue, retired in test catalogue");
      expect(rows.find((r) => r.test_name === "E2E Retired Panel")).toBeUndefined();
    } finally {
      await query(`DELETE FROM lab_report_catalog WHERE name = 'E2E RETIRED PANEL'`);
      await query(`DELETE FROM giniflow_test_catalog WHERE test_name = 'E2E Retired Panel'`);
    }
  });

  test("X-ray and offsite tests get their own groups", () => {
    const machines = [
      { id: "xray", station: "xray", tests: ["Chest X-ray PA"] },
      { id: "abi", station: "machine_room", tests: ["ABI"] },
    ];
    const rows = mergeTestList({
      catalog: [
        { test_name: "Chest X-ray PA", category: "machine", price: "400", source: "admin" },
        { test_name: "Outside MRI", category: "offsite", price: "0", source: "admin" },
        { test_name: "chest x-ray pa", category: "machine", price: "1", source: "admin" },
      ],
      reports: [],
      machines,
    });
    expect(rows.map((r) => [r.test_name, r.suggested_group])).toEqual([
      ["Chest X-ray PA", "X-ray"],
      ["Outside MRI", "Offsite"],
    ]);
    expect(rows[0].note).toBe('Also listed as "chest x-ray pa" (₹1) — keep one of the two');
    expect(rows[1].note).toBe("");
  });
});
