import "dotenv/config";
import { startCronJobs, stopCronJobs } from "./services/cron/index.js";
import { startSheetsCron, stopSheetsCron } from "./services/cron/sheetsSync.js";
import { startTodaysShowCron, stopTodaysShowCron } from "./services/cron/todaysShowSync.js";
import { startGenieSyncCron, stopGenieSyncCron } from "./services/cron/genieSync.js";
import pool from "./config/db.js";

console.log("🛠️  Gini Scribe Worker starting...");

startCronJobs();
startSheetsCron();
startTodaysShowCron();
startGenieSyncCron();

console.log("✅ Worker ready — cron jobs active (separate from API process)");

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[Worker] ${signal} received — stopping cron jobs...`);
  try {
    stopCronJobs();
    stopSheetsCron();
    stopTodaysShowCron();
    stopGenieSyncCron();
  } catch (e) {
    console.error("[Worker] error stopping cron:", e.message);
  }
  try {
    await pool.end();
  } catch (e) {
    console.error("[Worker] error closing pool:", e.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  console.error("[Worker] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[Worker] uncaughtException:", err);
});
