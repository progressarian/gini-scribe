import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { anonymousApi, apiAs } from "../../helpers/auth.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import {
  IMPORT_SHEETS,
  LATER_SHEETS,
  TEMPLATE_SHEET_NAMES,
} from "../../../server/services/billing/importColumns.js";
import {
  LATER_TAB_COLOR,
  TEMPLATE_FILE_NAME,
  templateBuffer,
} from "../../../server/services/billing/importTemplate.js";
import {
  LATER_SHEET_NOTE,
  SHEET_EXAMPLES,
  laterSheetsRule,
} from "../../../server/services/billing/importReadme.js";

const URL = "/api/billing/import/template";
const COMMITTED = path.join(repoRoot, "docs", "gini-flow", "billing-template.xlsx");
const serverRequire = createRequire(path.join(repoRoot, "server", "package.json"));
const ExcelJS = serverRequire("exceljs");
const JSZip = createRequire(serverRequire.resolve("exceljs"))("jszip");

async function entries(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const out = {};
  for (const name of Object.keys(zip.files).sort()) {
    if (!zip.files[name].dir) out[name] = await zip.files[name].async("string");
  }
  return out;
}

async function load(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

async function download(role) {
  const api = await apiAs(role);
  const response = await api.get(URL);
  const result = {
    status: response.status(),
    headers: response.headers(),
    body: response.ok() ? await response.body() : null,
  };
  await api.dispose();
  return result;
}

const readmeRows = (workbook) => {
  const rows = [];
  workbook.getWorksheet("Read me").eachRow((row) => {
    rows.push(row.values.slice(1).map((v) => (v == null ? "" : String(v))));
  });
  return rows;
};

test.describe("P2-03 template download", () => {
  test("1. admin and reception_admin download the template as an .xlsx attachment", async () => {
    for (const role of ["admin", "reception_admin"]) {
      const { status, headers, body } = await download(role);
      expect(status, role).toBe(200);
      expect(headers["content-type"], role).toContain(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      expect(headers["content-disposition"], role).toBe(
        `attachment; filename="${TEMPLATE_FILE_NAME}"`,
      );
      expect(headers["cache-control"], role).toBe("no-store");
      expect(body.subarray(0, 2).toString(), `${role} gets a zip (xlsx) file`).toBe("PK");
    }
  });

  test("2. the downloaded file has exactly the content of the P0-01 template committed in docs", async () => {
    const { body } = await download("admin");
    const downloaded = await entries(body);
    expect(Object.keys(downloaded).length).toBeGreaterThan(10);
    expect(downloaded, "rebuild it with build-billing-template").toEqual(
      await entries(fs.readFileSync(COMMITTED)),
    );
    expect(downloaded).toEqual(await entries(Buffer.from(await templateBuffer())));
    const workbook = await load(body);
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(TEMPLATE_SHEET_NAMES);
    for (const sheet of IMPORT_SHEETS) {
      const ws = workbook.getWorksheet(sheet.name);
      expect(ws.getRow(1).values.slice(1), sheet.name).toEqual(sheet.columns.map((c) => c.name));
      expect(ws.rowCount, `${sheet.name} has only its example rows`).toBe(
        1 + SHEET_EXAMPLES[sheet.name].length,
      );
    }
  });

  test("3. since P3-22 no sheet is marked available after Phase 3: no grey tab, note or Read me rule", async () => {
    expect(LATER_SHEETS).toEqual([]);
    const workbook = await load((await download("admin")).body);
    for (const sheet of IMPORT_SHEETS) {
      const ws = workbook.getWorksheet(sheet.name);
      expect(ws.properties.tabColor?.argb ?? null, `${sheet.name} tab`).not.toBe(LATER_TAB_COLOR);
      expect(ws.getCell("A1").note ?? null, `${sheet.name} header note`).toBeNull();
    }
    const rows = readmeRows(workbook);
    expect(rows.filter((r) => r[1] === "(available after Phase 3)")).toEqual([]);
    expect(rows.filter((r) => r.includes(LATER_SHEET_NOTE))).toEqual([]);
    const rules = rows.filter((r) => r[0] === "All sheets").map((r) => r[4]);
    expect(rules.join("\n")).not.toContain("available after Phase 3");
    expect(rules.at(-1)).toContain("Any error stops the whole upload");
  });

  test("4. every other role is refused, and so is a request with no login", async () => {
    for (const role of ["reception", "coordinator", "lab", "banshali"]) {
      expect((await download(role)).status, role).toBe(403);
    }
    const anonymous = await anonymousApi();
    const refused = await anonymous.get(URL);
    expect(refused.status()).toBe(403);
    expect((await refused.json()).error).toBe("Doctor account required");
    await anonymous.dispose();
  });

  test("5. review: the Phase 3 rule reads right for one sheet or several", () => {
    expect(laterSheetsRule(["Discounts"])).toMatch(
      /^The Discounts sheet is available after Phase 3\. Its tab is grey and rows on it/,
    );
    expect(laterSheetsRule(["Payment rules", "Discounts"])).toMatch(
      /^The Payment rules and Discounts sheets are available after Phase 3\. Their tabs are grey/,
    );
    expect(laterSheetsRule(["Payment rules", "Consultant fees", "Discounts"])).toContain(
      "The Payment rules, Consultant fees and Discounts sheets",
    );
  });
});
