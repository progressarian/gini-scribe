import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const APPLY = process.argv.includes("--apply");
const PER_PAGE = Number(arg("per-page", 100));
const PAUSE_MS = Number(arg("pause", 45)) * 1000;
const MAX_PAGES = Number(arg("max-pages", 1000));
process.env.HEALTHRAY_MAX_RPS ||= "0.5";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.resolve(here, "../../reports/healthray-backfill");
const stateFile = path.join(stateDir, `patients-${APPLY ? "apply" : "dry-run"}.json`);

const { default: pool } = await import("../config/db.js");
const { fetchPatientList } = await import("../services/healthray/client.js");
const { importHealthrayPatient } = await import("../services/healthray/patientImport.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const yearOf = (row) => String(row.registration_date || "").match(/\d{4}/)?.[0] || "unknown";

async function loadState() {
  if (process.argv.includes("--reset")) return null;
  return JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "null"));
}

async function existingIdentities(rows) {
  const healthIds = rows
    .map((r) => r.family_member?.healthray_id)
    .filter(Boolean)
    .map(String);
  const fileNos = rows
    .map((r) => r.patient_case_id)
    .filter(Boolean)
    .map(String);
  const { rows: found } = await pool.query(
    `SELECT health_id, file_no FROM patients WHERE health_id = ANY($1::text[]) OR file_no = ANY($2::text[])`,
    [healthIds, fileNos],
  );
  return {
    healthIds: new Set(found.map((r) => r.health_id).filter(Boolean)),
    fileNos: new Set(found.map((r) => r.file_no).filter(Boolean)),
  };
}

await fs.mkdir(stateDir, { recursive: true });
const state = (await loadState()) || { page: 0, seen: 0, missing: 0, imported: 0, byYear: {} };
console.log(
  `${APPLY ? "APPLY" : "DRY RUN (no writes)"} · ${PER_PAGE} per page · ${PAUSE_MS / 1000}s between pages · resuming after page ${state.page}`,
);

try {
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = state.page + 1;
    const rows = (await fetchPatientList({ page, perPage: PER_PAGE })) || [];
    if (!rows.length) {
      state.done = true;
      break;
    }
    const known = await existingIdentities(rows);
    const missing = rows.filter(
      (r) =>
        !known.healthIds.has(String(r.family_member?.healthray_id || "")) &&
        !known.fileNos.has(String(r.patient_case_id || "")),
    );
    for (const r of rows) {
      const y = (state.byYear[yearOf(r)] ||= { inHealthray: 0, missingInScribe: 0 });
      y.inHealthray += 1;
    }
    for (const r of missing) state.byYear[yearOf(r)].missingInScribe += 1;
    if (APPLY) {
      for (const r of missing) {
        await importHealthrayPatient(r);
        state.imported += 1;
      }
    }
    state.page = page;
    state.seen += rows.length;
    state.missing += missing.length;
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
    console.log(
      `page ${page}: ${rows.length} patients, ${missing.length} not in Scribe${APPLY ? ` (imported)` : ""} · total seen ${state.seen}, missing ${state.missing}`,
    );
    if (rows.length < PER_PAGE) {
      state.done = true;
      break;
    }
    await sleep(PAUSE_MS);
  }
} catch (error) {
  console.error(
    `Stopped at page ${state.page + 1}: ${error.healthrayBlocked ? "HealthRay blocked the request — wait before resuming" : error.message}`,
  );
  process.exitCode = 1;
} finally {
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
  console.log(
    `${state.done ? "Finished" : "Paused"} · seen ${state.seen} · not in Scribe ${state.missing} · imported ${state.imported}`,
  );
  console.table(state.byYear);
  await pool.end();
}
