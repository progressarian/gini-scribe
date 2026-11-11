import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { buildDmOutcomes, DM_PERIOD, sameGroupFromRows } from "../services/analytics/dmOutcomes.js";
import { renderDmScorecard } from "../services/analytics/render/dmScorecard.js";
import { renderDmDashboard } from "../services/analytics/render/dmDashboard.js";
import { buildDmWorkbook } from "../services/analytics/render/dmWorkbook.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};

const period = { start: arg("start", DM_PERIOD.start), end: arg("end", DM_PERIOD.end) };
const outDir = path.resolve(
  arg("out", `reports/dm-outcomes/${new Date().toISOString().slice(0, 10)}`),
);
await fs.mkdir(outDir, { recursive: true });

const fromJson = arg("from-json", null);
let report = fromJson ? JSON.parse(await fs.readFile(path.resolve(fromJson), "utf8")) : null;
const cronPool = fromJson ? null : (await import("../config/db.js")).cronPool;
const client = fromJson ? null : await cronPool.connect();
if (client)
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '180s'");
    const timed = {
      query: async (sql, params) => {
        const t = Date.now();
        const result = await client.query(sql, params);
        const label = String(sql).replace(/\s+/g, " ").trim().slice(0, 60);
        console.log(`  ${((Date.now() - t) / 1000).toFixed(1)}s  ${label}`);
        return result;
      },
    };
    report = await buildDmOutcomes(timed, period, { audit: Number(arg("audit", 0)), rows: true });
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`Stopped: ${error.message}`);
    process.exitCode = 1;
  } finally {
    client.release();
  }
await cronPool?.end();
if (report) {
  if (report.audit_sample) {
    await fs.writeFile(
      path.join(outDir, "audit-sample.local.json"),
      JSON.stringify(report.audit_sample, null, 2),
    );
    delete report.audit_sample;
  }
  const rowsFile = path.join(outDir, "dashboard-rows.local.json");
  let rows = report.dashboard_rows;
  delete report.dashboard_rows;
  if (rows) await fs.writeFile(rowsFile, JSON.stringify(rows));
  else rows = JSON.parse(await fs.readFile(rowsFile, "utf8").catch(() => "null"));
  if (rows && !report.new_patients.same_patients)
    report.new_patients.same_patients = sameGroupFromRows(rows);
  if (rows) {
    const dashboard = renderDmDashboard(report, rows);
    if (/https?:\/\/|<script\s+src|@import/.test(dashboard))
      throw new Error("dashboard references external resources");
    await fs.writeFile(path.join(outDir, "dashboard.html"), dashboard);
  }
  await fs.writeFile(path.join(outDir, "outcomes.xlsx"), await buildDmWorkbook(report));
  const file = path.join(outDir, "dm-outcomes.json");
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  const all = JSON.parse(
    await fs.readFile(path.join(outDir, "all-patients.json"), "utf8").catch(() => "null"),
  );
  const html = renderDmScorecard(report, all);
  if (/https?:\/\/|<script\s+src|@import/.test(html))
    throw new Error("scorecard references external resources");
  await fs.writeFile(path.join(outDir, "scorecard.html"), html);
  console.log(`Built in ${(report.meta.build_ms / 1000).toFixed(1)}s -> ${file}`);
}
