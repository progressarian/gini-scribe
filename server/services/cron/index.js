import {
  syncTodayWalkingAppointments,
  syncWalkingAppointments,
  syncWalkingAppointmentsByDate,
  syncDateRange,
  getRangeSyncStatus,
} from "./healthraySync.js";
import { runLabSync, retryPendingLabCases, getLabSyncStatus } from "./labSync.js";

// ── Sync interval (every 5 minutes) ────────────────────────────────────────
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 15 * 60 * 1000;

let intervalId = null;
let labIntervalId = null;
let recoveryIntervalId = null;

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
};
