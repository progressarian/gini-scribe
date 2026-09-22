import crypto from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { anonymousApi, apiAs } from "../../helpers/auth.mjs";
import { query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { templateBuffer } from "../../../server/services/billing/importTemplate.js";
import { ERROR_COLUMN } from "../../../server/services/billing/importColumns.js";
import { MAX_UPLOAD_BYTES } from "../../../server/services/billing/importParse.js";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const ExcelJS = createRequire(path.join(repoRoot, "server", "package.json"))("exceljs");

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BASE = "/api/billing/import";
const tag = crypto.randomBytes(3).toString("hex");
const T = tag.toUpperCase();
const ALLOWED = ["admin", "reception_admin"];
const REFUSED = ["reception", "coordinator", "lab", "banshali"];
const ROUTES = [
  ["post", `${BASE}/preview`],
  ["post", `${BASE}/commit`],
  ["post", `${BASE}/errors`],
  ["get", `${BASE}/history`],
];

const groupCode = (who) => `P210G_${who}_${T}`;
const subCode = (who) => `P210S_${who}_${T}`;
const CAPPED = `p210_cap_${tag}`;

async function workbook(sheets) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await templateBuffer({ examples: false }));
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.getWorksheet(name);
    const headers = ws.getRow(1).values.slice(1);
    for (const cells of rows) ws.addRow(headers.map((h) => cells[h] ?? null));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const clean = (who) => ({
  Groups: [{ group_code: groupCode(who), name: `P210 Group ${who} ${T}` }],
  Subgroups: [{ subgroup_code: subCode(who), group_code: groupCode(who), name: "P210 Sub" }],
});

const withBadRow = (who) => ({
  Groups: [{ group_code: groupCode(who), name: `P210 Group ${who} ${T}` }],
  Subgroups: [{ subgroup_code: subCode(who), group_code: `P210_NOPE_${T}`, name: "P210 Sub" }],
});

async function send(api, method, url, { file, fileName, params = {} } = {}) {
  const options = { params: fileName === undefined ? params : { ...params, fileName } };
  if (file !== undefined) {
    options.data = file;
    options.headers = { "Content-Type": XLSX_TYPE };
  }
  const response = await api[method](url, options);
  const headers = response.headers();
  const body = await response.body();
  const json = headers["content-type"]?.includes("json") ? JSON.parse(body) : null;
  return { status: response.status(), headers, body, json };
}

async function asRole(role, work) {
  const api = await apiAs(role);
  try {
    return await work(api);
  } finally {
    await api.dispose();
  }
}

const importsNamed = async (fileName) =>
  (
    await query(
      `SELECT id, status, imported_by FROM billing_imports WHERE file_name = $1 ORDER BY id`,
      [fileName],
    )
  ).rows;

test.describe.serial("P2-10 import routes", () => {
  test.afterAll(async () => {
    await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, ["p210%"]);
    await query(`DELETE FROM service_subgroups WHERE code ILIKE $1`, ["P210S%"]);
    await query(`DELETE FROM service_groups WHERE code ILIKE $1`, ["P210G%"]);
  });

  test("1. preview: admin and reception_admin see row statuses and counts, nothing is saved", async () => {
    for (const role of ALLOWED) {
      const response = await asRole(role, async (api) =>
        send(api, "post", `${BASE}/preview`, {
          file: await workbook(clean(role)),
          fileName: `p210-preview-${tag}.xlsx`,
        }),
      );
      expect(response.status, role).toBe(200);
      const body = response.json;
      expect(Object.keys(body).sort()).toEqual(["canImport", "counts", "problems", "sheets"]);
      expect(body).toMatchObject({ problems: [], canImport: true });
      expect(body.counts).toMatchObject({ new: 2, update: 0, error: 0 });
      expect(body.sheets.find((s) => s.name === "Groups").rows[0]).toMatchObject({
        status: "new",
        values: { group_code: groupCode(role) },
      });
    }
    const groups = await query(`SELECT 1 FROM service_groups WHERE code ILIKE $1`, ["P210G%"]);
    expect(groups.rows).toEqual([]);
    expect(await importsNamed(`p210-preview-${tag}.xlsx`)).toEqual([]);
  });

  test("2. commit: a clean file saves for admin and reception_admin; the same file again and a file with an error row save nothing", async () => {
    for (const role of ALLOWED) {
      const fileName = `p210-${role}-${tag}.xlsx`;
      const file = await workbook(clean(role));
      const saved = await asRole(role, (api) =>
        send(api, "post", `${BASE}/commit`, { file, fileName }),
      );
      expect(saved.status, role).toBe(200);
      const body = saved.json;
      expect(body).toMatchObject({ saved: true, preview: { canImport: true } });
      expect(body.importId).toBeTruthy();
      expect(body.importedAt).toBeTruthy();
      expect(await importsNamed(fileName)).toEqual([
        { id: body.importId, status: "saved", imported_by: USERS[role].id },
      ]);
      const group = await query(`SELECT name FROM service_groups WHERE code = $1`, [
        groupCode(role),
      ]);
      expect(group.rows).toEqual([{ name: `P210 Group ${role} ${T}` }]);

      const again = await asRole(role, (api) =>
        send(api, "post", `${BASE}/commit`, { file, fileName: `p210-again-${role}-${tag}.xlsx` }),
      );
      expect(again.status, `${role} same file again`).toBe(200);
      const againBody = again.json;
      expect(againBody.saved).toBe(false);
      expect(againBody.importId).toBeUndefined();
      expect(againBody.preview.counts).toMatchObject({ new: 0, update: 0, unchanged: 2 });
      expect(await importsNamed(`p210-again-${role}-${tag}.xlsx`)).toEqual([]);
    }

    const refused = await asRole("admin", async (api) =>
      send(api, "post", `${BASE}/commit`, {
        file: await workbook(withBadRow("bad")),
        fileName: `p210-bad-${tag}.xlsx`,
      }),
    );
    expect(refused.status).toBe(200);
    const refusedBody = refused.json;
    expect(refusedBody).toMatchObject({ saved: false, preview: { canImport: false } });
    expect(refusedBody.preview.counts).toMatchObject({ new: 1, error: 1 });
    const bad = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [groupCode("bad")]);
    expect(bad.rows, "nothing from the refused file was saved").toEqual([]);
    expect(await importsNamed(`p210-bad-${tag}.xlsx`)).toEqual([]);
  });

  test("3. error file: an .xlsx attachment marking the bad row, which can be fixed and uploaded again", async () => {
    for (const role of ALLOWED) {
      const response = await asRole(role, async (api) =>
        send(api, "post", `${BASE}/errors`, {
          file: await workbook(withBadRow(`err_${role}`)),
          fileName: `P210 rates ${tag}.XLSX`,
        }),
      );
      expect(response.status, role).toBe(200);
      const headers = response.headers;
      expect(headers["content-type"]).toContain(XLSX_TYPE);
      expect(headers["content-disposition"]).toBe(
        `attachment; filename="P210 rates ${tag} - errors.xlsx"`,
      );
      expect(headers["cache-control"]).toBe("no-store");
      const file = response.body;
      expect(file.subarray(0, 2).toString()).toBe("PK");

      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file);
      const ws = wb.getWorksheet("Subgroups");
      const headings = ws.getRow(1).values.slice(1);
      const errorCol = headings.indexOf(ERROR_COLUMN) + 1;
      expect(errorCol, "the Subgroups sheet gets an error column").toBeGreaterThan(0);
      expect(String(ws.getRow(2).getCell(errorCol).value)).toMatch(/P210_NOPE/i);

      const reupload = (buffer) =>
        asRole(role, (api) =>
          send(api, "post", `${BASE}/preview`, { file: buffer, fileName: "fixed.xlsx" }),
        );
      const asIs = (await reupload(file)).json;
      expect(asIs.problems, "the error file itself reads back cleanly").toEqual([]);
      expect(asIs.counts).toMatchObject({ error: 1 });

      ws.getRow(2).getCell(headings.indexOf("group_code") + 1).value = groupCode(`err_${role}`);
      const fixed = Buffer.from(await wb.xlsx.writeBuffer());
      const fixedPreview = (await reupload(fixed)).json;
      expect(fixedPreview).toMatchObject({ problems: [], canImport: true });
      expect(fixedPreview.counts).toMatchObject({ new: 2, error: 0 });
    }

    const none = await asRole("admin", async (api) =>
      send(api, "post", `${BASE}/errors`, {
        file: await workbook(clean("none")),
        fileName: `p210-none-${tag}.xlsx`,
      }),
    );
    expect(none.status).toBe(422);
    expect(none.json).toEqual({
      error: "No row in this file has an error, so there is no error file",
      problems: [],
    });

    const unreadable = await asRole("admin", (api) =>
      send(api, "post", `${BASE}/errors`, {
        file: Buffer.from("not a spreadsheet"),
        fileName: `p210-junk-${tag}.xlsx`,
      }),
    );
    expect(unreadable.status).toBe(422);
    const unreadableBody = unreadable.json;
    expect(unreadableBody.error).toMatch(/fix the problems listed first/);
    expect(unreadableBody.problems).toEqual([
      "This isn't an Excel .xlsx file; save it as an Excel Workbook (.xlsx) and upload again",
    ]);
  });

  test("4. history: newest first, with who imported, file name, when, status and counts; paged", async () => {
    for (const role of ALLOWED) {
      const response = await asRole(role, (api) =>
        send(api, "get", `${BASE}/history`, { params: { limit: "100" } }),
      );
      expect(response.status, role).toBe(200);
      const body = response.json;
      expect(body).toMatchObject({ limit: 100, offset: 0 });
      expect(body.total).toBeGreaterThanOrEqual(2);
      const ours = body.imports.filter((i) => i.file_name.endsWith(`-${tag}.xlsx`));
      expect(ours.map((i) => i.file_name)).toEqual([
        `p210-reception_admin-${tag}.xlsx`,
        `p210-admin-${tag}.xlsx`,
      ]);
      expect(ours[0]).toMatchObject({
        status: "saved",
        imported_by: USERS.reception_admin.id,
        imported_by_name: USERS.reception_admin.name,
        counts: { Groups: { new: 1, update: 0, unchanged: 0 } },
      });
      expect(Object.keys(ours[0]).sort()).toEqual(
        [
          "counts",
          "file_name",
          "id",
          "imported_at",
          "imported_by",
          "imported_by_name",
          "status",
        ].sort(),
      );
      const times = body.imports.map((i) => Date.parse(i.imported_at));
      expect(times).toEqual([...times].sort((a, b) => b - a));
    }

    const page = await asRole("admin", async (api) => {
      const first = (await send(api, "get", `${BASE}/history`, { params: { limit: "1" } })).json;
      const second = (
        await send(api, "get", `${BASE}/history`, { params: { limit: "1", offset: "1" } })
      ).json;
      const all = (await send(api, "get", `${BASE}/history`)).json;
      return { first, second, all };
    });
    expect(page.first.imports).toHaveLength(1);
    expect(page.second.imports).toHaveLength(1);
    expect(page.second.imports[0].id).not.toBe(page.first.imports[0].id);
    expect(page.all.limit, "a sane default page size").toBe(25);
    expect(page.first.total).toBe(page.all.total);

    await asRole("admin", async (api) => {
      for (const [params, message] of [
        [{ limit: "0" }, "Page size must be between 1 and 100"],
        [{ limit: "101" }, "Page size must be between 1 and 100"],
        [{ limit: "ten" }, "Page size must be a whole number"],
        [{ offset: "-1" }, "Offset must be a whole number"],
        [{ sort: "name" }, "Unknown field: sort"],
      ]) {
        const response = await send(api, "get", `${BASE}/history`, { params });
        expect(response.status, JSON.stringify(params)).toBe(400);
        expect(response.json.error).toBe(message);
      }
    });
  });

  test("5. every route is refused to reception, coordinator, lab, a consultant and no login", async () => {
    const file = await workbook(clean("refused"));
    for (const role of REFUSED) {
      await asRole(role, async (api) => {
        for (const [method, url] of ROUTES) {
          const response = await send(api, method, url, {
            file: method === "post" ? file : undefined,
            fileName: method === "post" ? `p210-refused-${tag}.xlsx` : undefined,
          });
          expect(response.status, `${role} ${method} ${url}`).toBe(403);
        }
      });
    }
    const anonymous = await anonymousApi();
    for (const [method, url] of ROUTES) {
      const response = await send(anonymous, method, url, {
        file: method === "post" ? file : undefined,
        fileName: method === "post" ? `p210-refused-${tag}.xlsx` : undefined,
      });
      expect(response.status, `anonymous ${method} ${url}`).toBe(403);
      expect(response.json.error).toBe("Doctor account required");
    }
    await anonymous.dispose();
    expect(await importsNamed(`p210-refused-${tag}.xlsx`)).toEqual([]);
    const groups = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [
      groupCode("refused"),
    ]);
    expect(groups.rows).toEqual([]);
  });

  test("6. a daily_cap change is refused for reception_admin and allowed for admin", async () => {
    const file = await workbook({
      Categories: [{ category_code: CAPPED, label: `P210 Capped ${T}`, daily_cap: 7 }],
    });
    const fileName = `p210-cap-${tag}.xlsx`;

    const preview = await asRole("reception_admin", (api) =>
      send(api, "post", `${BASE}/preview`, { file, fileName }),
    );
    const previewBody = preview.json;
    expect(previewBody.canImport).toBe(false);
    expect(previewBody.sheets.find((s) => s.name === "Categories").rows[0].errors).toEqual([
      expect.objectContaining({
        column: "daily_cap",
        message: expect.stringMatching(/^Only an admin can change a category's patients-per-day/),
      }),
    ]);

    const refused = await asRole("reception_admin", (api) =>
      send(api, "post", `${BASE}/commit`, { file, fileName }),
    );
    expect(refused.status).toBe(200);
    expect(refused.json).toMatchObject({ saved: false, preview: { canImport: false } });
    expect((await query(`SELECT 1 FROM patient_schemes WHERE code = $1`, [CAPPED])).rows).toEqual(
      [],
    );

    const allowed = await asRole("admin", (api) =>
      send(api, "post", `${BASE}/commit`, { file, fileName }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.json.saved).toBe(true);
    const saved = await query(`SELECT daily_cap FROM patient_schemes WHERE code = $1`, [CAPPED]);
    expect(saved.rows).toEqual([{ daily_cap: 7 }]);
    expect(await importsNamed(fileName)).toMatchObject([
      { status: "saved", imported_by: USERS.admin.id },
    ]);
  });

  test("7. a bad file name or a missing file is a 400 with a readable message", async () => {
    const file = await workbook(clean("names"));
    await asRole("admin", async (api) => {
      for (const [method, url] of ROUTES.filter(([m]) => m === "post")) {
        for (const [fileName, message] of [
          [undefined, "File name is required"],
          ["   ", "File name can't be blank"],
          ["rates.csv", "File name must end in .xlsx — upload the Excel template"],
          [`${"a".repeat(196)}.xlsx`, "File name can be at most 200 characters"],
        ]) {
          const response = await send(api, method, url, { file, fileName });
          expect(response.status, `${url} ${fileName}`).toBe(400);
          expect(response.json.error, `${url} ${fileName}`).toBe(message);
        }
        const empty = await send(api, method, url, { fileName: "rates.xlsx" });
        expect(empty.status, `${url} empty`).toBe(400);
        expect(empty.json.error).toBe("Attach the filled-in .xlsx file as the body of the request");
        const json = await api.post(url, { params: { fileName: "rates.xlsx" }, data: {} });
        expect(json.status(), `${url} JSON body`).toBe(400);
        expect((await json.json()).error).toBe(
          "Attach the filled-in .xlsx file as the body of the request",
        );
      }
    });
    const groups = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [
      groupCode("names"),
    ]);
    expect(groups.rows).toEqual([]);
  });

  test("8. review: a file over the limit is refused with the same 5 MB the reader uses", async () => {
    await asRole("admin", async (api) => {
      for (const [method, url] of ROUTES.filter(([m]) => m === "post")) {
        const response = await send(api, method, url, {
          file: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1),
          fileName: "big.xlsx",
        });
        expect(response.status, url).toBe(413);
        expect(response.json.error, url).toBe(
          "The file is larger than 5 MB; split it into smaller files",
        );
      }
    });
  });
});
