// Genie → Scribe periodic catch-up sync.
//
// On boot we run a full sweep of every Genie-linked patient so that any data
// the patient logged while scribe was down lands in scribe Postgres without
// waiting for a doctor to open the visit page. We then run a lighter
// "recent-activity" sweep on an interval to keep things current.
//
// Lazy require for genie-sync.cjs (CJS) — same pattern other ESM modules in
// this folder use to interop with the bridge.
import { createRequire } from "module";
import pool from "../../config/db.js";

const require = createRequire(import.meta.url);

let genieSync = null;
try {
  genieSync = require("../../genie-sync.cjs");
} catch (err) {
  console.warn("[GenieCron] genie-sync.cjs not loadable:", err?.message || err);
}

const STARTUP_DELAY_MS = 20 * 1000; // let DB pool warm up
const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // every 30 min
const RECENT_WINDOW_MS = 35 * 60 * 1000; // overlaps interval slightly
const PER_PATIENT_GAP_MS = 150; // gentle pacing so we don't hammer Supabase

let bootTimeoutId = null;
let intervalId = null;
let running = false;

function isEnabled() {
  return Boolean(
    process.env.GENIE_SUPABASE_URL &&
      process.env.GENIE_SUPABASE_SERVICE_KEY &&
      genieSync?.syncPatientLogsFromGenieThrottled,
  );
}

async function listLinkedScribePatientIds({ since = null } = {}) {
  if (!genieSync?.getGenieDb) return [];
  const db = genieSync.getGenieDb();
  if (!db) return [];

  // Strategy: ask Genie which patients are linked (gini_patient_id NOT NULL).
  // For the recent-activity sweep we narrow further by checking which of
  // those have a recently-updated row in the high-traffic tables.
  const { data: linked, error } = await db
    .from("patients")
    .select("id, gini_patient_id, updated_at")
    .not("gini_patient_id", "is", null);
  if (error) {
    console.error("[GenieCron] list linked patients failed:", error.message);
    return [];
  }
  if (!Array.isArray(linked) || linked.length === 0) return [];

  if (!since) {
    return linked
      .map((r) => r.gini_patient_id)
      .filter(Boolean)
      .map(String);
  }

  // Recent-activity filter: union of patient_ids touched in the last window
  // across the tables our pull mirrors. One round-trip per table; small
  // tables (or no recent activity) just return [].
  const sinceIso = new Date(since).toISOString();
  const tables = [
    { name: "vitals", col: "created_at" },
    { name: "lab_results", col: "created_at" },
    { name: "activity_logs", col: "created_at" },
    { name: "symptom_logs", col: "created_at" },
    { name: "meal_logs", col: "created_at" },
    { name: "medication_logs", col: "created_at" },
  ];
  const activeUuids = new Set();
  await Promise.all(
    tables.map(async ({ name, col }) => {
      try {
        const { data, error: e2 } = await db
          .from(name)
          .select("patient_id")
          .gte(col, sinceIso)
          .limit(2000);
        if (e2) {
          console.warn(`[GenieCron] recent-scan ${name} failed:`, e2.message);
          return;
        }
        for (const row of data || []) {
          if (row?.patient_id) activeUuids.add(row.patient_id);
        }
      } catch (err) {
        console.warn(`[GenieCron] recent-scan ${name} threw:`, err.message);
      }
    }),
  );

  return linked
    .filter((r) => activeUuids.has(r.id))
    .map((r) => r.gini_patient_id)
    .filter(Boolean)
    .map(String);
}

async function runSweep({ mode = "recent" } = {}) {
  if (!isEnabled()) return { synced: 0, skipped: "disabled" };
  if (running) return { synced: 0, skipped: "already running" };
  running = true;
  const started = Date.now();
  try {
    const since = mode === "full" ? null : Date.now() - RECENT_WINDOW_MS;
    const ids = await listLinkedScribePatientIds({ since });
    if (ids.length === 0) {
      console.log(
        `[GenieCron] ${mode} sweep: no candidate patients (took ${Date.now() - started}ms)`,
      );
      return { synced: 0 };
    }
    console.log(`[GenieCron] ${mode} sweep starting for ${ids.length} patient(s)`);

    let ok = 0;
    let fail = 0;
    for (const idStr of ids) {
      // Scribe patient ids are integers in Postgres but stored as strings on
      // Genie. The sync helper accepts either; throttle map normalizes.
      const id = Number(idStr);
      if (!Number.isFinite(id)) continue;
      try {
        await genieSync.syncPatientLogsFromGenieThrottled(id, pool);
        ok++;
      } catch (err) {
        fail++;
        console.error(`[GenieCron] sync failed for patient ${id}:`, err.message);
      }
      if (PER_PATIENT_GAP_MS > 0) {
        await new Promise((r) => setTimeout(r, PER_PATIENT_GAP_MS));
      }
    }
    console.log(
      `[GenieCron] ${mode} sweep done: ok=${ok} fail=${fail} in ${Date.now() - started}ms`,
    );
    return { synced: ok, failed: fail };
  } finally {
    running = false;
  }
}

export function startGenieSyncCron() {
  if (!isEnabled()) {
    console.log(
      "[GenieCron] Genie credentials missing or genie-sync.cjs unavailable — disabled",
    );
    return;
  }
  console.log(
    `[GenieCron] catch-up scheduled in ${Math.round(STARTUP_DELAY_MS / 1000)}s, then every ${SWEEP_INTERVAL_MS / 60000} min`,
  );
  bootTimeoutId = setTimeout(() => {
    runSweep({ mode: "full" }).catch((e) =>
      console.error("[GenieCron] startup sweep failed:", e.message),
    );
    intervalId = setInterval(() => {
      runSweep({ mode: "recent" }).catch((e) =>
        console.error("[GenieCron] interval sweep failed:", e.message),
      );
    }, SWEEP_INTERVAL_MS);
  }, STARTUP_DELAY_MS);
}

export function stopGenieSyncCron() {
  if (bootTimeoutId) {
    clearTimeout(bootTimeoutId);
    bootTimeoutId = null;
  }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[GenieCron] stopped");
  }
}

// Manual trigger for ops/scripts.
export async function runGenieSyncNow({ mode = "full" } = {}) {
  return runSweep({ mode });
}
