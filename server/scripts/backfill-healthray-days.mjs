import "../loadEnv.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : fallback;
};
const APPLY = process.argv.includes("--apply");
const FROM = arg("from", "2024-04-01");
const TO = arg("to", "2025-02-28");
const EVERY = Number(arg("every", 1));
const DAY_PAUSE_MS = Number(arg("day-pause", 60)) * 1000;
const MAX_DAYS = Number(arg("max-days", 10000));
const PATIENTS_SINCE = arg("patients-created-after", null);
const SKIP_LAB = process.argv.includes("--skip-lab");
process.env.HEALTHRAY_MAX_RPS ||= "0.5";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.resolve(here, "../../reports/healthray-backfill");
const stateFile = path.join(stateDir, `days-${APPLY ? "apply" : "dry-run"}-${FROM}_${TO}.json`);

const { default: pool } = await import("../config/db.js");
const { fetchDoctors, fetchAppointments } = await import("../services/healthray/client.js");
const { runSync } = await import("../services/cron/healthraySync.js");
const { syncDoctors } = await import("../services/healthray/db.js");
const { fetchLabCasesForDate } = await import("../services/lab/labHealthrayApi.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function datesBetween(from, to, every) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end; i++, d.setUTCDate(d.getUTCDate() + 1))
    if (i % every === 0) out.push(d.toISOString().slice(0, 10));
  return out;
}

async function trackedPatientIds({ healthIds = [], uhids = [] }) {
  if (!PATIENTS_SINCE) return [];
  const { rows } = await pool.query(
    `SELECT id FROM patients
      WHERE created_at >= $3::timestamptz
        AND (health_id = ANY($1::text[]) OR file_no = ANY($2::text[]))`,
    [healthIds, uhids, PATIENTS_SINCE],
  );
  return rows.map((r) => r.id);
}

async function countLabCases(date) {
  if (SKIP_LAB) return { labCases: 0, newLabCases: 0, trackedLab: [] };
  const cases = ((await fetchLabCasesForDate(date)) || []).filter(
    (c) => c.case_status !== "Cancelled",
  );
  const { rows } = await pool.query(
    `SELECT case_no FROM lab_cases WHERE case_no = ANY($1::text[])`,
    [cases.map((c) => String(c.case_no))],
  );
  const inScribe = new Set(rows.map((r) => r.case_no));
  const fresh = cases.filter((c) => !inScribe.has(String(c.case_no)));
  const tracked = await trackedPatientIds({
    uhids: fresh.map((c) => String(c.patient_case_no || "")).filter(Boolean),
  });
  return { labCases: cases.length, newLabCases: fresh.length, trackedLab: tracked };
}

async function countDay(date, doctors) {
  const appts = [];
  let fullPages = 0;
  for (const doc of doctors) {
    const list = (await fetchAppointments(doc.id, date)) || [];
    if (list.length >= 100) fullPages += 1;
    appts.push(...list);
  }
  const ids = appts.map((a) => String(a.id)).filter((id) => /^\d+$/.test(id));
  const { rows } = await pool.query(
    `SELECT healthray_id::text AS healthray_id FROM appointments WHERE healthray_id = ANY($1::bigint[])`,
    [ids],
  );
  const inScribe = new Set(rows.map((r) => r.healthray_id));
  const fresh = appts.filter((a) => !inScribe.has(String(a.id)));
  const trackedVisit = await trackedPatientIds({
    healthIds: fresh.map((a) => String(a.family_member?.healthray_id || "")).filter(Boolean),
    uhids: fresh.map((a) => String(a.patient_case_id || "")).filter(Boolean),
  });
  const lab = await countLabCases(date);
  return {
    appointments: appts.length,
    alreadyInScribe: appts.length - fresh.length,
    new: fresh.length,
    newCompleted: fresh.filter((a) => /complete|checkout|seen/i.test(String(a.status || "")))
      .length,
    labCases: lab.labCases,
    newLabCases: lab.newLabCases,
    doctorsWithMoreThan100: fullPages,
    trackedVisit,
    trackedLab: lab.trackedLab,
  };
}

await fs.mkdir(stateDir, { recursive: true });
const state = process.argv.includes("--reset")
  ? null
  : JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "null"));
const progress = state || {
  days: {},
  totals: {
    appointments: 0,
    alreadyInScribe: 0,
    new: 0,
    newCompleted: 0,
    labCases: 0,
    newLabCases: 0,
  },
  trackedWithVisit: [],
  trackedWithLab: [],
};
const withVisit = new Set(progress.trackedWithVisit || []);
const withLab = new Set(progress.trackedWithLab || []);
const dates = datesBetween(FROM, TO, EVERY).filter((d) => !progress.days[d]);
console.log(
  `${APPLY ? "APPLY (writes + AI reading)" : "DRY RUN (count only, no writes, no AI)"} · ${FROM} → ${TO}${EVERY > 1 ? ` · every ${EVERY}th day` : ""} · ${dates.length} day(s) left`,
);

try {
  const rayDoctors = (await fetchDoctors()) || [];
  const active = rayDoctors.filter((d) => !d.is_deactivated);
  const prefetched = APPLY ? { rayDoctors, doctorMap: await syncDoctors(rayDoctors) } : null;
  console.log(`${active.length} active HealthRay doctors`);
  for (const date of dates.slice(0, MAX_DAYS)) {
    const started = Date.now();
    const day = await countDay(date, active);
    if (APPLY) {
      const result = await runSync(date, prefetched);
      day.sync = result && typeof result === "object" ? result : null;
    }
    day.seconds = Math.round((Date.now() - started) / 1000);
    day.trackedVisit.forEach((id) => withVisit.add(id));
    day.trackedLab.forEach((id) => withLab.add(id));
    progress.trackedWithVisit = [...withVisit];
    progress.trackedWithLab = [...withLab];
    const { trackedVisit, trackedLab, ...summary } = day;
    progress.days[date] = {
      ...summary,
      trackedVisit: trackedVisit.length,
      trackedLab: trackedLab.length,
    };
    for (const k of Object.keys(progress.totals)) progress.totals[k] += summary[k] || 0;
    await fs.writeFile(stateFile, JSON.stringify(progress, null, 2));
    console.log(
      `${date}: ${day.appointments} appointments, ${day.alreadyInScribe} already in Scribe, ${day.new} new (${day.newCompleted} completed), ${day.newLabCases}/${day.labCases} lab cases new${PATIENTS_SINCE ? ` · tracked patients: ${trackedVisit.length} visit, ${trackedLab.length} lab` : ""}${day.doctorsWithMoreThan100 ? `, ${day.doctorsWithMoreThan100} doctor(s) hit 100` : ""} · ${day.seconds}s`,
    );
    await sleep(DAY_PAUSE_MS);
  }
} catch (error) {
  console.error(
    `Stopped: ${error.healthrayBlocked ? "HealthRay blocked the request — wait before resuming" : error.message}`,
  );
  process.exitCode = 1;
} finally {
  await fs.writeFile(stateFile, JSON.stringify(progress, null, 2));
  const counted = Object.keys(progress.days).length;
  console.log(`Days done: ${counted}`);
  console.table(progress.totals);
  if (PATIENTS_SINCE)
    console.log(
      `Patients created after ${PATIENTS_SINCE}: ${withVisit.size} with a new visit, ${withLab.size} with a new lab case, ${new Set([...withVisit, ...withLab]).size} with either`,
    );
  if (!APPLY && EVERY > 1)
    console.log(
      `Estimate for every day in the range: about ${Math.round(progress.totals.new * EVERY)} new appointments, about ${Math.round(progress.totals.newCompleted * EVERY)} AI note reads`,
    );
  await pool.end();
}
