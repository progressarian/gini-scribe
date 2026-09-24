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
const SESSIONS = `${BASE}/sessions`;
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
const ROUTES = [
  ["post", SESSIONS],
  ["post", `${SESSIONS}/${UNKNOWN}/commit`],
  ["get", `${SESSIONS}/${UNKNOWN}/failed`],
  ["get", `${BASE}/history`],
];
const RETIRED = ["preview", "commit", "errors"];

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

const upload = async (role, file, fileName) =>
  asRole(role, (api) => send(api, "post", SESSIONS, { file, fileName }));

const commit = (role, id) => asRole(role, (api) => send(api, "post", `${SESSIONS}/${id}/commit`));

const rowsOf = async (role, id, params = {}) =>
  (await asRole(role, (api) => send(api, "get", `${SESSIONS}/${id}/rows`, { params }))).json.rows;

const sessionIds = {};

test.describe.serial("P2-10 import routes", () => {
  test.afterAll(async () => {
    await query(`DELETE FROM billing_import_sessions WHERE file_name ILIKE $1`, [`%${tag}%`]);
    await query(`DELETE FROM patient_schemes WHERE code LIKE $1`, ["p210%"]);
    await query(`DELETE FROM service_subgroups WHERE code ILIKE $1`, ["P210S%"]);
    await query(`DELETE FROM service_groups WHERE code ILIKE $1`, ["P210G%"]);
  });

  test("1. upload: admin and reception_admin get a session with row statuses and counts, nothing is saved", async () => {
    for (const role of ALLOWED) {
      const fileName = `p210-upload-${tag}.xlsx`;
      const response = await upload(role, await workbook(clean(role)), fileName);
      expect(response.status, role).toBe(201);
      const body = response.json;
      expect(body).toMatchObject({
        file_name: fileName,
        status: "open",
        uploaded_by: USERS[role].id,
        live: { status: { ready: 2, override: 0, unchanged: 0, failed: 0 } },
      });
      const rows = await rowsOf(role, body.id, { sheet: "Groups" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: "ready",
        key: groupCode(role),
        values: { group_code: groupCode(role) },
      });
    }
    const groups = await query(`SELECT 1 FROM service_groups WHERE code ILIKE $1`, ["P210G%"]);
    expect(groups.rows).toEqual([]);
    expect(await importsNamed(`p210-upload-${tag}.xlsx`)).toEqual([]);
  });

  test("2. commit: a clean file saves for admin and reception_admin; the same file again has nothing to save; a file with an error row saves only its good rows", async () => {
    for (const role of ALLOWED) {
      const fileName = `p210-${role}-${tag}.xlsx`;
      const file = await workbook(clean(role));
      const created = (await upload(role, file, fileName)).json;
      sessionIds[role] = created.id;
      const saved = await commit(role, created.id);
      expect(saved.status, role).toBe(200);
      const body = saved.json;
      expect(body).toMatchObject({
        saved: true,
        outcome: { saved: 2, kept: 0, failed: 0, unchanged: 0 },
        session: { id: created.id, status: "committed", import_id: body.importId },
      });
      expect(body.importId).toBeTruthy();
      expect(body.importedAt).toBeTruthy();
      expect(await importsNamed(fileName)).toEqual([
        { id: String(body.importId), status: "saved", imported_by: USERS[role].id },
      ]);
      const group = await query(`SELECT name FROM service_groups WHERE code = $1`, [
        groupCode(role),
      ]);
      expect(group.rows).toEqual([{ name: `P210 Group ${role} ${T}` }]);

      const againName = `p210-again-${role}-${tag}.xlsx`;
      const again = (await upload(role, file, againName)).json;
      expect(again.live.status, `${role} same file again`).toEqual({
        ready: 0,
        override: 0,
        unchanged: 2,
        failed: 0,
      });
      const nothing = await commit(role, again.id);
      expect(nothing.status, `${role} same file again`).toBe(409);
      expect(nothing.json.error).toMatch(/^Nothing to save: no row is ready/);
      expect(await importsNamed(againName)).toEqual([]);
    }

    const badName = `p210-bad-${tag}.xlsx`;
    const bad = (await upload("admin", await workbook(withBadRow("bad")), badName)).json;
    sessionIds.bad = bad.id;
    expect(bad.live.status).toEqual({ ready: 1, override: 0, unchanged: 0, failed: 1 });
    const partial = await commit("admin", bad.id);
    expect(partial.status).toBe(200);
    expect(partial.json).toMatchObject({
      saved: true,
      outcome: { saved: 1, kept: 0, failed: 1, unchanged: 0 },
    });
    const good = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [groupCode("bad")]);
    expect(good.rows, "the good row of the file was saved").toHaveLength(1);
    const failed = await query(`SELECT 1 FROM service_subgroups WHERE code = $1`, [subCode("bad")]);
    expect(failed.rows, "the failed row was not saved").toEqual([]);
    expect(await importsNamed(badName)).toMatchObject([{ status: "saved" }]);
  });

  test("3. failed rows file: an .xlsx attachment marking the bad row, which can be fixed and uploaded again", async () => {
    for (const role of ALLOWED) {
      const created = (
        await upload(role, await workbook(withBadRow(`err_${role}`)), `P210 rates ${tag}.XLSX`)
      ).json;
      const response = await asRole(role, (api) =>
        send(api, "get", `${SESSIONS}/${created.id}/failed`),
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

      const reupload = async (buffer) =>
        (await upload(role, buffer, `p210-fixed-${tag}.xlsx`)).json;
      const asIs = await reupload(file);
      expect(asIs.live.status, "the error file itself reads back cleanly").toMatchObject({
        ready: 1,
        failed: 1,
      });

      ws.getRow(2).getCell(headings.indexOf("group_code") + 1).value = groupCode(`err_${role}`);
      const fixed = await reupload(Buffer.from(await wb.xlsx.writeBuffer()));
      expect(fixed.live.status).toMatchObject({ ready: 2, failed: 0 });
    }

    const tidy = (await upload("admin", await workbook(clean("none")), `p210-none-${tag}.xlsx`))
      .json;
    const none = await asRole("admin", (api) => send(api, "get", `${SESSIONS}/${tidy.id}/failed`));
    expect(none.status).toBe(422);
    expect(none.json).toEqual({
      error: "No row in this import failed, so there is no file of failed rows",
    });

    const unreadable = await upload(
      "admin",
      Buffer.from("not a spreadsheet"),
      `p210-junk-${tag}.xlsx`,
    );
    expect(unreadable.status).toBe(422);
    expect(unreadable.json.error).toMatch(/fix the problems listed/);
    expect(unreadable.json.problems).toEqual([
      "This isn't an Excel .xlsx file; save it as an Excel Workbook (.xlsx) and upload again",
    ]);
    const groups = await query(`SELECT 1 FROM service_groups WHERE code ILIKE $1`, ["P210G_ERR%"]);
    expect(groups.rows).toEqual([]);
  });

  test("4. history: newest first, with who imported, file name, when, status, counts and the session report; paged", async () => {
    for (const role of ALLOWED) {
      const response = await asRole(role, (api) =>
        send(api, "get", `${BASE}/history`, { params: { limit: "100" } }),
      );
      expect(response.status, role).toBe(200);
      const body = response.json;
      expect(body).toMatchObject({ limit: 100, offset: 0 });
      expect(body.total).toBeGreaterThanOrEqual(3);
      const ours = body.imports.filter((i) => i.file_name.endsWith(`-${tag}.xlsx`));
      expect(ours.map((i) => i.file_name)).toEqual([
        `p210-bad-${tag}.xlsx`,
        `p210-reception_admin-${tag}.xlsx`,
        `p210-admin-${tag}.xlsx`,
      ]);
      expect(ours[1]).toMatchObject({
        status: "saved",
        imported_by: USERS.reception_admin.id,
        imported_by_name: USERS.reception_admin.name,
        session_id: sessionIds.reception_admin,
        counts: { Groups: { new: 1, update: 0, unchanged: 0, kept: 0, failed: 0 } },
      });
      expect(ours[0]).toMatchObject({
        session_id: sessionIds.bad,
        counts: { Groups: { new: 1, failed: 0 }, Subgroups: { new: 0, failed: 1 } },
      });
      expect(ours[2].session_id).toBe(sessionIds.admin);
      expect(Object.keys(ours[1]).sort()).toEqual(
        [
          "counts",
          "file_name",
          "id",
          "imported_at",
          "imported_by",
          "imported_by_name",
          "session_id",
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
    const sessions = await query(`SELECT 1 FROM billing_import_sessions WHERE file_name = $1`, [
      `p210-refused-${tag}.xlsx`,
    ]);
    expect(sessions.rows).toEqual([]);
    const groups = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [
      groupCode("refused"),
    ]);
    expect(groups.rows).toEqual([]);
  });

  test("6. a daily_cap change fails for reception_admin and is saved for admin", async () => {
    const file = await workbook({
      Categories: [{ category_code: CAPPED, label: `P210 Capped ${T}`, daily_cap: 7 }],
    });
    const fileName = `p210-cap-${tag}.xlsx`;

    const refusedSession = (await upload("reception_admin", file, fileName)).json;
    expect(refusedSession.live.status).toMatchObject({ ready: 0, failed: 1 });
    const [row] = await rowsOf("reception_admin", refusedSession.id, { sheet: "Categories" });
    expect(row.status).toBe("failed");
    expect(row.errors).toEqual([
      expect.objectContaining({
        column: "daily_cap",
        message: expect.stringMatching(/^Only an admin can change a category's patients-per-day/),
      }),
    ]);
    const refused = await commit("reception_admin", refusedSession.id);
    expect(refused.status).toBe(409);
    expect((await query(`SELECT 1 FROM patient_schemes WHERE code = $1`, [CAPPED])).rows).toEqual(
      [],
    );
    expect(await importsNamed(fileName)).toEqual([]);

    const allowedSession = (await upload("admin", file, fileName)).json;
    expect(allowedSession.live.status).toMatchObject({ ready: 1, failed: 0 });
    const allowed = await commit("admin", allowedSession.id);
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
      for (const [fileName, message] of [
        [undefined, "File name is required"],
        ["   ", "File name can't be blank"],
        ["rates.csv", "File name must end in .xlsx — upload the Excel template"],
        [`${"a".repeat(196)}.xlsx`, "File name can be at most 200 characters"],
      ]) {
        const response = await send(api, "post", SESSIONS, { file, fileName });
        expect(response.status, `${fileName}`).toBe(400);
        expect(response.json.error, `${fileName}`).toBe(message);
      }
      const empty = await send(api, "post", SESSIONS, { fileName: "rates.xlsx" });
      expect(empty.status, "empty").toBe(400);
      expect(empty.json.error).toBe("Attach the filled-in .xlsx file as the body of the request");
      const json = await api.post(SESSIONS, { params: { fileName: "rates.xlsx" }, data: {} });
      expect(json.status(), "JSON body").toBe(400);
      expect((await json.json()).error).toBe(
        "Attach the filled-in .xlsx file as the body of the request",
      );
    });
    const groups = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [
      groupCode("names"),
    ]);
    expect(groups.rows).toEqual([]);
  });

  test("8. review: a file over the limit is refused with the same 5 MB the reader uses", async () => {
    await asRole("admin", async (api) => {
      const response = await send(api, "post", SESSIONS, {
        file: Buffer.alloc(MAX_UPLOAD_BYTES + 1, 1),
        fileName: "big.xlsx",
      });
      expect(response.status).toBe(413);
      expect(response.json.error).toBe("The file is larger than 5 MB; split it into smaller files");
    });
  });

  test("9. the old all-or-nothing preview, commit and errors routes are gone", async () => {
    const file = await workbook(clean("retired"));
    await asRole("admin", async (api) => {
      for (const route of RETIRED) {
        const response = await send(api, "post", `${BASE}/${route}`, {
          file,
          fileName: `p210-retired-${tag}.xlsx`,
        });
        expect(response.status, route).toBe(404);
      }
    });
    expect(await importsNamed(`p210-retired-${tag}.xlsx`)).toEqual([]);
    const groups = await query(`SELECT 1 FROM service_groups WHERE code = $1`, [
      groupCode("retired"),
    ]);
    expect(groups.rows).toEqual([]);
  });
});
