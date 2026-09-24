import path from "node:path";
import { createRequire } from "node:module";
import { test, expect } from "@playwright/test";
import { query } from "../../helpers/db.mjs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { cleanUp, newTag, readWorkbook, seed, workbook } from "./p2b-fixture.mjs";

const express = createRequire(path.join(repoRoot, "server", "package.json"))("express");
const { default: router } = await import("../../../server/routes/billingImport.js");

const { P, p, T } = newTag("P2B08");
const file = (name) => `${p}-${name}.xlsx`;
const BASE = "/api/billing/import/sessions";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const UNKNOWN = "00000000-0000-4000-8000-000000000000";
let server = null;
let url = null;
let sessionId = null;

async function call(method, route, { as = "admin", body, raw, type } = {}) {
  const user = USERS[as];
  const headers = {};
  if (user) headers["x-test-user"] = String(user.id);
  if (raw) headers["content-type"] = type ?? "application/octet-stream";
  else if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${url}${route}`, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const kind = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    headers: res.headers,
    body: kind.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
  };
}

const upload = async (sheets, name, as = "admin") =>
  call("POST", `${BASE}?fileName=${encodeURIComponent(name)}`, {
    as,
    raw: await workbook(sheets),
  });

test.describe.serial("P2b-08 schemas and routes", () => {
  test.beforeAll(async () => {
    await cleanUp(P, p);
    await seed({ Groups: [{ group_code: `${P}-EG`, name: `Exist ${T}` }] }, file("base"));
    const app = express();
    app.use((req, res, next) => {
      if (req.headers["content-type"] === "application/json") return express.json()(req, res, next);
      next();
    });
    app.use((req, res, next) => {
      const user = Object.values(USERS).find((u) => String(u.id) === req.headers["x-test-user"]);
      if (user) req.doctor = { doctor_id: user.id, role: user.role };
      next();
    });
    app.use("/api", router);
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
  });

  test.afterAll(async () => {
    server?.close();
    await cleanUp(P, p);
  });

  test("1. upload creates a session (201) and returns it with its counts", async () => {
    const res = await upload(
      {
        Groups: [
          { group_code: `${P}-NG`, name: `New ${T}` },
          { group_code: `${P}-EG`, name: `Exist renamed ${T}` },
          { group_code: `${P}-BAD`, name: null },
        ],
      },
      file("routes"),
      "reception_admin",
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      file_name: file("routes"),
      status: "open",
      expired: false,
      uploaded_by: USERS.reception_admin.id,
      live: { status: { ready: 1, override: 1, unchanged: 0, failed: 1 } },
    });
    expect(res.body.file).toBeUndefined();
    sessionId = res.body.id;
    const read = await call("GET", `${BASE}/${sessionId}`);
    expect(read.status).toBe(200);
    expect(read.body.id).toBe(sessionId);
    expect(read.body.live.plan).toEqual({
      save: 1,
      keep: 1,
      undecided: 1,
      failed: 1,
      unchanged: 0,
    });
  });

  test("2. rows: filtered and paged, with the chip counts", async () => {
    const res = await call("GET", `${BASE}/${sessionId}/rows?status=override&sheet=Groups&page=1`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, page_size: 50, total: 1, pages: 1 });
    expect(res.body.counts.status).toEqual({
      all: 3,
      ready: 1,
      override: 1,
      unchanged: 0,
      failed: 1,
    });
    const [row] = res.body.rows;
    expect(Object.keys(row).sort()).toEqual(
      [
        "before",
        "changes",
        "decision",
        "depends_on",
        "errors",
        "id",
        "input",
        "key",
        "label",
        "outcome",
        "reason",
        "row",
        "sheet",
        "status",
        "values",
        "warnings",
      ].sort(),
    );
    expect(row).toMatchObject({ sheet: "Groups", row: 3, key: `${P}-EG`, decision: "pending" });
    const q = await call("GET", `${BASE}/${sessionId}/rows?q=${encodeURIComponent("renamed")}`);
    expect(q.body.rows.map((r) => r.key)).toEqual([`${P}-EG`]);
  });

  test("3. decide one row, or every row matching a filter", async () => {
    const rows = await call("GET", `${BASE}/${sessionId}/rows?status=override`);
    const one = await call("POST", `${BASE}/${sessionId}/decisions`, {
      as: "reception_admin",
      body: { decision: "keep", row_ids: [rows.body.rows[0].id] },
    });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ decision: "keep", matched: 1, changed: 1 });
    const all = await call("POST", `${BASE}/${sessionId}/decisions`, {
      as: "reception_admin",
      body: { decision: "override", filter: { sheet: "Groups" } },
    });
    expect(all.body).toMatchObject({ matched: 1, changed: 1 });
    expect(all.body.counts.decision).toEqual({ pending: 0, override: 1, keep: 0 });
  });

  test("4. every bad parameter is a readable 4xx", async () => {
    const cases = [
      ["GET", `${BASE}/not-a-uuid`, {}, 400, "Choose a valid import session"],
      ["GET", `${BASE}/${UNKNOWN}`, {}, 404, /no longer exists/],
      ["GET", `${BASE}/${UNKNOWN}/rows`, {}, 404, /no longer exists/],
      ["GET", `${BASE}/${sessionId}/rows?status=done`, {}, 400, /Status must be one of: ready/],
      ["GET", `${BASE}/${sessionId}/rows?sheet=Nope`, {}, 400, /Sheet must be one of: Groups/],
      [
        "GET",
        `${BASE}/${sessionId}/rows?page=0`,
        {},
        400,
        "Page must be a whole number, 1 or more",
      ],
      ["GET", `${BASE}/${sessionId}/rows?page=abc`, {}, 400, /Page must be a whole number/],
      ["GET", `${BASE}/${sessionId}/rows?q=${"x".repeat(101)}`, {}, 400, /Search/],
      ["GET", `${BASE}/${sessionId}/rows?sort=row`, {}, 400, "Unknown field: sort"],
      ["GET", `${BASE}/${sessionId}/rows?status=ready&status=failed`, {}, 400, /Status/],
      ["POST", `${BASE}/${sessionId}/decisions`, { body: {} }, 400, /Decision/],
      [
        "POST",
        `${BASE}/${sessionId}/decisions`,
        { body: { decision: "keep" } },
        400,
        "Send either row_ids or a filter, not both",
      ],
      [
        "POST",
        `${BASE}/${sessionId}/decisions`,
        { body: { decision: "keep", row_ids: [0] } },
        400,
        /Rows must be row ids/,
      ],
      [
        "POST",
        `${BASE}/${sessionId}/decisions`,
        { body: { decision: "keep", filter: { status: "ready" } } },
        400,
        /Unknown field/,
      ],
      [
        "POST",
        `${BASE}/${sessionId}/decisions`,
        { body: { decision: "keep", row_ids: [1], extra: 1 } },
        400,
        "Unknown field: extra",
      ],
      ["POST", `${BASE}/${sessionId}/decisions`, { raw: Buffer.from("x") }, 400, /object/],
      ["POST", `${BASE}/not-a-uuid/commit`, {}, 400, "Choose a valid import session"],
      ["POST", `${BASE}/${UNKNOWN}/abandon`, {}, 404, /no longer exists/],
      ["GET", `${BASE}/${UNKNOWN}/failed`, {}, 404, /no longer exists/],
      ["POST", `${BASE}`, { raw: Buffer.from("x") }, 400, /File name is required|fileName/i],
      ["POST", `${BASE}?fileName=a.csv`, { raw: Buffer.from("x") }, 400, /must end in .xlsx/],
      ["POST", `${BASE}?fileName=a.xlsx`, {}, 400, /Attach the filled-in .xlsx file/],
      [
        "POST",
        `${BASE}?fileName=a.xlsx`,
        { raw: Buffer.from("not a workbook") },
        422,
        /can't be checked row by row/,
      ],
    ];
    for (const [method, route, options, status, message] of cases) {
      const res = await call(method, route, options);
      expect(res.status, `${method} ${route}`).toBe(status);
      expect(typeof res.body.error, `${method} ${route}`).toBe("string");
      if (message instanceof RegExp) expect(res.body.error, `${method} ${route}`).toMatch(message);
      else expect(res.body.error, `${method} ${route}`).toBe(message);
    }
    const junk = await call("POST", `${BASE}?fileName=a.xlsx`, {
      raw: Buffer.from("not a workbook"),
    });
    expect(junk.body.problems[0]).toMatch(/isn't an Excel .xlsx file/);
  });

  test("5. failed rows download as the admin's workbook", async () => {
    const res = await call("GET", `${BASE}/${sessionId}/failed`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="${p}-routes - errors.xlsx"`,
    );
    const wb = await readWorkbook(res.body);
    expect(wb.getWorksheet("Groups").getCell("A4").value).toBe(`${P}-BAD`);
  });

  test("6. commit saves the good rows and reports every row", async () => {
    const res = await call("POST", `${BASE}/${sessionId}/commit`, { as: "reception_admin" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      saved: true,
      outcome: { saved: 2, kept: 0, failed: 1, unchanged: 0 },
      session: { status: "committed", committed_by: USERS.reception_admin.id },
    });
    expect(typeof res.body.importId).toBe("number");
    const report = await call("GET", `${BASE}/${sessionId}/rows?outcome=saved`);
    expect(report.body.rows.map((r) => r.key)).toEqual([`${P}-NG`, `${P}-EG`]);
    const again = await call("POST", `${BASE}/${sessionId}/commit`, { as: "reception_admin" });
    expect(again.status).toBe(409);
  });

  test("7. abandon on request", async () => {
    const created = await upload(
      { Groups: [{ group_code: `${P}-AB`, name: `Ab ${T}` }] },
      file("ab"),
    );
    const res = await call("POST", `${BASE}/${created.body.id}/abandon`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: created.body.id, status: "abandoned", rows_removed: 1 });
  });

  test("8. every route needs BILLING_MASTER, and deciding needs the uploader or an admin", async () => {
    const created = await upload({ Groups: [{ group_code: `${P}-X`, name: `X ${T}` }] }, file("x"));
    const id = created.body.id;
    const routes = [
      ["POST", `${BASE}?fileName=a.xlsx`, { raw: Buffer.from("x") }],
      ["GET", `${BASE}/${id}`, {}],
      ["GET", `${BASE}/${id}/rows`, {}],
      ["POST", `${BASE}/${id}/decisions`, { body: { decision: "keep", filter: {} } }],
      ["POST", `${BASE}/${id}/commit`, {}],
      ["GET", `${BASE}/${id}/failed`, {}],
      ["POST", `${BASE}/${id}/abandon`, {}],
    ];
    for (const [method, route, options] of routes) {
      for (const as of ["reception", "coordinator", "lab", null]) {
        const res = await call(method, route, { ...options, as });
        expect(res.status, `${as} ${method} ${route}`).toBe(403);
      }
    }
    const byOther = await call("POST", `${BASE}/${id}/commit`, { as: "reception_admin" });
    expect(byOther.status).toBe(403);
    expect(byOther.body.error).toBe(
      "Only the person who uploaded this file, or an admin, can change this import",
    );
    const { rows } = await query(`SELECT status FROM billing_import_sessions WHERE id = $1`, [id]);
    expect(rows[0].status).toBe("open");
  });
});
