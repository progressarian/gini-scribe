import {
  syncTodayWalkingAppointments,
  syncWalkingAppointments,
  syncWalkingAppointmentsByDate,
  syncDateRange,
  getRangeSyncStatus,
  runDailyOpdBackfill,
  runStuckStatusRecovery,
} from "./healthraySync.js";
import {
  runLabSync,
  retryPendingLabCases,
  getLabSyncStatus,
  backfillLabRanges,
  backfillLabPdfs,
} from "./labSync.js";

// ── Sync interval (every 5 minutes) ────────────────────────────────────────
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 15 * 60 * 1000;

let intervalId = null;
let labIntervalId = null;
let recoveryIntervalId = null;
let dailyBackfillIntervalId = null;
let stuckStatusIntervalId = null;

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

  // ── Lab HealthRay sync (every 5 min) ──────────────────────────────────────
  console.log("[Cron] Starting lab sync (every 5 min)...");

  // Run once on startup after a short delay (let server finish booting)
  setTimeout(() => {
    runLabSync().catch((e) => console.error("[Cron] Lab initial sync failed:", e.message));
  }, 10_000);

  labIntervalId = setInterval(() => {
    runLabSync().catch((e) => console.error("[Cron] Lab sync failed:", e.message));
  }, SYNC_INTERVAL_MS);

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
};
