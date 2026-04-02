// ── Google Sheets Cron — reads LIVE View of Today's patients twice daily ────

import { readTodaysPatients } from "../sheets/reader.js";
import { createLogger } from "../logger.js";
import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const { log, error } = createLogger("Sheets Sync");
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "..", "data", "sheets");

let intervalId = null;

async function syncFromSheet() {
  const startTime = Date.now();
  log("Sync", "Reading LIVE View of Today's patients...");

  try {
    const { date, waitTimeThresholds, statusNotes, patients } = await readTodaysPatients();

    if (!patients.length) {
      log("Sync", "No patient data found");
      return { date, count: 0 };
    }

    log("Sync", `Date: ${date} — ${patients.length} patients`);

    // Save to JSON
    const fileName = `patients_${new Date().toISOString().split("T")[0]}.json`;
    const filePath = join(DATA_DIR, fileName);
    writeFileSync(
      filePath,
      JSON.stringify(
        { date, waitTimeThresholds, statusNotes, syncedAt: new Date().toISOString(), patients },
        null,
        2,
      ),
    );
    log("Sync", `Saved to ${fileName}`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log("Sync", `Done in ${elapsed}s — ${patients.length} patients logged`);

    return { date, count: patients.length };
  } catch (e) {
    error("Sync", `Failed: ${e.message}`);
    return { count: 0 };
  }
}

// Run twice daily: 8:30 AM IST and 1:30 PM IST
const SCHEDULE_HOURS_IST = [8.5, 13.5];
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min
let lastRunDate = {};

function shouldRun() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000); // IST
  const hourDecimal = now.getUTCHours() + now.getUTCMinutes() / 60;
  const todayKey = now.toISOString().split("T")[0];

  for (const scheduleHour of SCHEDULE_HOURS_IST) {
    const runKey = `${todayKey}_${scheduleHour}`;
    // Run if within 5 min window of scheduled time and not already run
    if (Math.abs(hourDecimal - scheduleHour) < 0.1 && !lastRunDate[runKey]) {
      lastRunDate[runKey] = true;
      return true;
    }
  }
  return false;
}

export function startSheetsCron() {
  log("Cron", "Starting (runs at 8:30 AM & 1:30 PM IST)");

  // Run once on startup
  syncFromSheet().catch((e) => error("Cron", `Initial run failed: ${e.message}`));

  // Check every 5 min if it's time to run
  intervalId = setInterval(() => {
    if (shouldRun()) {
      syncFromSheet().catch((e) => error("Cron", `Scheduled run failed: ${e.message}`));
    }
  }, CHECK_INTERVAL_MS);
}

export function stopSheetsCron() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log("Cron", "Stopped");
  }
}

// Manual trigger
export { syncFromSheet };
