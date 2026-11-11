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
process.env.HEALTHRAY_MAX_RPS ||= "0.5";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.resolve(here, "../../reports/healthray-backfill");
const stateFile = path.join(stateDir, `days-${APPLY ? "apply" : "dry-run"}-${FROM}_${TO}.json`);

const { default: pool } = await import("../config/db.js");
const { fetchDoctors, fetchAppointments } = await import("../services/healthray/client.js");
const { runSync } = await import("../services/cron/healthraySync.js");
const { syncDoctors } = await import("../services/healthray/db.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function datesBetween(from, to, every) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let i = 0; d <= end; i++, d.setUTCDate(d.getUTCDate() + 1))
    if (i % every === 0) out.push(d.toISOString().slice(0, 10));
  return out;
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
  return {
    appointments: appts.length,
    alreadyInScribe: appts.length - fresh.length,
    new: fresh.length,
    newCompleted: fresh.filter((a) => /complete|checkout|seen/i.test(String(a.status || "")))
      .length,
    doctorsWithMoreThan100: fullPages,
  };
}

await fs.mkdir(stateDir, { recursive: true });
const state = process.argv.includes("--reset")
  ? null
  : JSON.parse(await fs.readFile(stateFile, "utf8").catch(() => "null"));
const progress = state || {
  days: {},
  totals: { appointments: 0, alreadyInScribe: 0, new: 0, newCompleted: 0 },
};
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
    progress.days[date] = day;
    for (const k of Object.keys(progress.totals)) progress.totals[k] += day[k] || 0;
    await fs.writeFile(stateFile, JSON.stringify(progress, null, 2));
    console.log(
      `${date}: ${day.appointments} appointments, ${day.alreadyInScribe} already in Scribe, ${day.new} new (${day.newCompleted} completed)${day.doctorsWithMoreThan100 ? `, ${day.doctorsWithMoreThan100} doctor(s) hit 100` : ""} · ${day.seconds}s`,
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
  if (!APPLY && EVERY > 1)
    console.log(
      `Estimate for every day in the range: about ${Math.round(progress.totals.new * EVERY)} new appointments, about ${Math.round(progress.totals.newCompleted * EVERY)} AI note reads`,
    );
  await pool.end();
}
