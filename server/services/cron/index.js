import { syncTodayWalkingAppointments, syncWalkingAppointments } from "./healthraySync.js";

// ── Sync interval (every 5 minutes) ────────────────────────────────────────
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let intervalId = null;

export function startCronJobs() {
  if (!process.env.HEALTHRAY_MOBILE && !process.env.HEALTHRAY_SESSION) {
    console.log("[Cron] HealthRay credentials not set — walking appointment sync disabled");
    return;
  }

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

export function stopCronJobs() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log("[Cron] Walking appointment sync stopped");
  }
}

// Manual trigger exports
export { syncWalkingAppointments, syncTodayWalkingAppointments };
