import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { cronPool } from "../config/db.js";
import { buildFullReport } from "../services/analytics/index.js";
import { renderHtmlReport } from "../services/analytics/render/html.js";
import { buildWorkbook } from "../services/analytics/render/xlsx.js";
import { pruneSnapshots, writeSnapshot } from "../services/analytics/snapshot.js";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
}

const asOf = arg("as-of", new Date().toISOString().slice(0, 10));
const outDir = path.resolve(arg("out", "reports"));
const writeJson = process.argv.includes("--json");
const alsoSnapshot = process.argv.includes("--snapshot");

await fs.mkdir(outDir, { recursive: true });

const fromJson = arg("from-json", null);
const started = Date.now();
let report;
if (fromJson) {
  console.log(`Re-rendering from ${fromJson} ...`);
  report = JSON.parse(await fs.readFile(path.resolve(fromJson), "utf8"));
} else {
  console.log(`Building Gini outcomes report as at ${asOf} ...`);
  report = await buildFullReport(cronPool, { asOf });
  console.log(`  engine finished in ${(report.meta.build_ms / 1000).toFixed(1)}s`);
}

const html = renderHtmlReport(report);
const htmlPath = path.join(outDir, `gini-outcomes-report-${asOf}.html`);
await fs.writeFile(htmlPath, html, "utf8");

const external = html.match(/https?:\/\/|<script\s+src|@import|url\(/g);
if (external) {
  console.error(`  FAIL: report references external resources: ${[...new Set(external)].join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`  html  ${htmlPath}  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, fully self-contained)`);
}

const workbook = await buildWorkbook(report);
const xlsxPath = path.join(outDir, `gini-outcomes-data-${asOf}.xlsx`);
await fs.writeFile(xlsxPath, workbook);
console.log(`  xlsx  ${xlsxPath}  (${(workbook.length / 1024).toFixed(0)} KB)`);

if (writeJson) {
  const jsonPath = path.join(outDir, `gini-outcomes-${asOf}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  console.log(`  json  ${jsonPath}`);
}

if (alsoSnapshot) {
  const id = await writeSnapshot(cronPool, report);
  await pruneSnapshots(cronPool);
  console.log(`  snapshot ${id} written — the /analytics page now serves this build`);
}

console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await cronPool.end();
