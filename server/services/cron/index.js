import {
  syncTodayWalkingAppointments,
  syncWalkingAppointments,
  syncWalkingAppointmentsByDate,
  syncDateRange,
  getRangeSyncStatus,
  runDailyOpdBackfill,
  runStuckStatusRecovery,
  runMissingMedsRecovery,
} from "./healthraySync.js";
import {
  runLabSync,
  retryPendingLabCases,
  getLabSyncStatus,
  backfillLabRanges,
  backfillLabPdfs,
} from "./labSync.js";
import { runDocumentRecovery } from "./documentRecovery.js";

// ── Sync interval (every 5 minutes) ────────────────────────────────────────
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 15 * 60 * 1000;
const DOC_RECOVERY_INTERVAL_MS = 3 * 60 * 1000;

let intervalId = null;
let labIntervalId = null;
let recoveryIntervalId = null;
let dailyBackfillIntervalId = null;
let stuckStatusIntervalId = null;
let docRecoveryIntervalId = null;
let missingMedsIntervalId = null;

export function startCronJobs() {
  if (!process.env.HEALTHRAY_MOBILE && !process.env.HEALTHRAY_SESSION) {
    console.log("[Cron] HealthRay credentials not set — walking appointment sync disabled");
  } else {
    console.log("[Cron] Starting walking appointment sync (every 5 min)...");

    // Run initial full sync on startup
    syncWalkingAppointments().catch((e) => console.error("[Cron] Initial sync failed:", e.message));

    // Then sync today's walkins every 5 minutes
    intervalId = setInterval(() => {
      syncTodayWalkingAppointments().catch((e) =>
        console.error("[Cron] Scheduled sync failed:", e.message),
      );
    }, SYNC_INTERVAL_MS);
  }

  // ── Lab HealthRay sync (every 5 min, staggered) ───────────────────────────
  // Offset by ~2.5 min so the lab sync and healthray sync never start at the
  // same moment — the global advisory lock would still serialize them, but
  // staggering spreads the load across the 5-min window so users see fewer
  // back-to-back latency spikes.
  const LAB_SYNC_OFFSET_MS = Math.floor(SYNC_INTERVAL_MS / 2); // 2.5 min offset
  console.log("[Cron] Starting lab sync (every 5 min, staggered +2.5 min)...");

  setTimeout(() => {
    runLabSync().catch((e) => console.error("[Cron] Lab initial sync failed:", e.message));
    labIntervalId = setInterval(() => {
      runLabSync().catch((e) => console.error("[Cron] Lab sync failed:", e.message));
    }, SYNC_INTERVAL_MS);
  }, LAB_SYNC_OFFSET_MS);

  // Recovery job every 15 min
  recoveryIntervalId = setInterval(() => {
    retryPendingLabCases().catch((e) => console.error("[Cron] Lab recovery failed:", e.message));
  }, RECOVERY_INTERVAL_MS);

  // ── Daily OPD re-parse: fixes diagnoses + medicines for today's patients ──
  // Runs 30 min after startup (lets initial sync settle), then every 24 hours.
  // Re-parses clinical notes to correct stale "Absent" diagnoses in JSONB.
  const DAILY_BACKFILL_DELAY_MS = 30 * 60 * 1000; // 30 min initial delay
  const DAILY_BACKFILL_INTERVAL_MS = 24 * 60 * 60 * 1000; // every 24 hours
  setTimeout(() => {
    runDailyOpdBackfill().catch((e) =>
      console.error("[Cron] Daily OPD backfill failed:", e.message),
    );
    dailyBackfillIntervalId = setInterval(() => {
      runDailyOpdBackfill().catch((e) =>
        console.error("[Cron] Daily OPD backfill failed:", e.message),
      );
    }, DAILY_BACKFILL_INTERVAL_MS);
  }, DAILY_BACKFILL_DELAY_MS);

  // ── Stuck-status recovery: appointments enriched but never marked 'seen' ──
  // Window defaults to 5 days, override via STUCK_STATUS_WINDOW_DAYS.
  // Runs 2 min after startup, then every 30 min.
  const STUCK_STATUS_DELAY_MS = 2 * 60 * 1000;
  const STUCK_STATUS_INTERVAL_MS = 30 * 60 * 1000;
  setTimeout(() => {
    runStuckStatusRecovery().catch((e) =>
      console.error("[Cron] Stuck status recovery failed:", e.message),
    );
    stuckStatusIntervalId = setInterval(() => {
      runStuckStatusRecovery().catch((e) =>
        console.error("[Cron] Stuck status recovery failed:", e.message),
      );
    }, STUCK_STATUS_INTERVAL_MS);
  }, STUCK_STATUS_DELAY_MS);

  // ── Missing medications recovery ───────────────────────────────────────
  // Detects patients with an upcoming appointment whose latest HealthRay
  // prescription has zero active healthray-tagged rows in `medications` and
  // re-runs the chronological sync. First run 10 min after startup, then hourly.
  const MISSING_MEDS_DELAY_MS = 10 * 60 * 1000;
  const MISSING_MEDS_INTERVAL_MS = 60 * 60 * 1000;
  setTimeout(() => {
    runMissingMedsRecovery().catch((e) =>
      console.error("[Cron] Missing meds recovery failed:", e.message),
    );
    missingMedsIntervalId = setInterval(() => {
      runMissingMedsRecovery().catch((e) =>
        console.error("[Cron] Missing meds recovery failed:", e.message),
      );
    }, MISSING_MEDS_INTERVAL_MS);
  }, MISSING_MEDS_DELAY_MS);

  // ── Document recovery: clean orphans + re-kick stuck extractions ──
  // Every 3 min. Handles the refresh-mid-upload case where /upload-file
  // never completed (→ orphan) and the case where the server restarted
  // between upload-file and its fire-and-forget extraction (→ stuck
  // pending with a file). First run delayed by 90s to let startup settle.
  console.log("[Cron] Starting document recovery (every 3 min)...");
  setTimeout(() => {
    runDocumentRecovery().catch((e) =>
      console.error("[Cron] Document recovery failed:", e.message),
    );
    docRecoveryIntervalId = setInterval(() => {
      runDocumentRecovery().catch((e) =>
        console.error("[Cron] Document recovery failed:", e.message),
      );
    }, DOC_RECOVERY_INTERVAL_MS);
  }, 90 * 1000);
}

export function stopCronJobs() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[Cron] Walking appointment sync stopped");
  }
  if (labIntervalId) {
    clearInterval(labIntervalId);
    labIntervalId = null;
  }
  if (recoveryIntervalId) {
    clearInterval(recoveryIntervalId);
    recoveryIntervalId = null;
    console.log("[Cron] Lab sync stopped");
  }
  if (dailyBackfillIntervalId) {
    clearInterval(dailyBackfillIntervalId);
    dailyBackfillIntervalId = null;
    console.log("[Cron] Daily OPD backfill stopped");
  }
  if (stuckStatusIntervalId) {
    clearInterval(stuckStatusIntervalId);
    stuckStatusIntervalId = null;
    console.log("[Cron] Stuck status recovery stopped");
  }
  if (docRecoveryIntervalId) {
    clearInterval(docRecoveryIntervalId);
    docRecoveryIntervalId = null;
    console.log("[Cron] Document recovery stopped");
  }
  if (missingMedsIntervalId) {
    clearInterval(missingMedsIntervalId);
    missingMedsIntervalId = null;
    console.log("[Cron] Missing meds recovery stopped");
  }
}

// Manual trigger exports
export {
  syncWalkingAppointments,
  syncTodayWalkingAppointments,
  syncWalkingAppointmentsByDate,
  syncDateRange,
  getRangeSyncStatus,
  runLabSync,
  getLabSyncStatus,
  backfillLabRanges,
  backfillLabPdfs,
  runDailyOpdBackfill,
  runStuckStatusRecovery,
  runMissingMedsRecovery,
  runDocumentRecovery,
};
