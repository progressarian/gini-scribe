import path from "node:path";
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import { repoRoot } from "../../setup/testEnv.mjs";
import { tokensFor } from "../../helpers/auth.mjs";

const express = createRequire(path.join(repoRoot, "server", "package.json"))("express");
const { authMiddleware, requireAuth } = await import("../../../server/middleware/auth.js");
const { default: router } = await import("../../../server/routes/billingReports.js");

export const REPORTS_PATH = "/api/billing/reports";

export async function mountReports() {
  const app = express();
  app.use(authMiddleware);
  app.use(requireAuth);
  app.use("/api", router);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function callAs(base, role, route, query = {}) {
  const headers = {};
  if (role) headers.authorization = `Bearer ${(await tokensFor(role)).access}`;
  const search = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null),
  ).toString();
  const res = await fetch(`${base}${route}${search ? `?${search}` : ""}`, { headers });
  const type = res.headers.get("content-type") ?? "";
  return {
    status: res.status,
    headers: res.headers,
    body: type.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()),
  };
}

export async function readWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook.worksheets.map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      rows.push(row.values.slice(1).map((v) => (v && typeof v === "object" ? v.result : v)));
    });
    return { name: ws.name, rows };
  });
}

export async function proxyReports(page, base) {
  await page.route(`**${REPORTS_PATH}**`, async (route) => {
    const asked = new URL(route.request().url());
    const sent = route.request().headers();
    const res = await fetch(`${base}${asked.pathname}${asked.search}`, {
      headers: Object.fromEntries(
        ["authorization", "x-auth-token"].filter((n) => sent[n]).map((n) => [n, sent[n]]),
      ),
    });
    const headers = Object.fromEntries(
      ["content-type", "content-disposition"]
        .filter((name) => res.headers.has(name))
        .map((name) => [name, res.headers.get(name)]),
    );
    const body = Buffer.from(await res.arrayBuffer());
    await route.fulfill({ status: res.status, headers, body }).catch(() => {});
  });
}
