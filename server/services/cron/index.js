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
  runPdfRetryRecovery,
  runBlankLabPdfSweep,
  getLabSyncStatus,
  backfillLabRanges,
  backfillLabPdfs,
} from "./labSync.js";
import { runDocumentRecovery } from "./documentRecovery.js";

// ── Sync interval (every 1 minute) ─────────────────────────────────────────
const SYNC_INTERVAL_MS = 1 * 60 * 1000;
const RECOVERY_INTERVAL_MS = 15 * 60 * 1000;
const DOC_RECOVERY_INTERVAL_MS = 3 * 60 * 1000;

// HealthRay has no webhook, so we run a continuous loop: each iteration waits
// for the previous sync to finish, then sleeps a short random break (10–15s)
// before starting the next one. This gives near real-time updates without
// stacking concurrent runs.
const HEALTHRAY_LOOP_MIN_BREAK_MS = 10 * 1000;
const HEALTHRAY_LOOP_MAX_BREAK_MS = 15 * 1000;

let healthrayLoopRunning = false;
let healthrayLoopTimeoutId = null;
let labIntervalId = null;

function scheduleNextHealthraySync(delayMs) {
  if (!healthrayLoopRunning) return;
  healthrayLoopTimeoutId = setTimeout(async () => {
    healthrayLoopTimeoutId = null;
    if (!healthrayLoopRunning) return;
    const startedAt = Date.now();
    try {
      await syncTodayWalkingAppointments();
    } catch (e) {
      console.error("[Cron] Scheduled sync failed:", e.message);
    }
    const elapsed = Date.now() - startedAt;
    const breakMs =
      HEALTHRAY_LOOP_MIN_BREAK_MS +
      Math.floor(Math.random() * (HEALTHRAY_LOOP_MAX_BREAK_MS - HEALTHRAY_LOOP_MIN_BREAK_MS + 1));
    console.log(
      `[Cron] HealthRay sync finished in ${elapsed}ms; next run in ${Math.round(breakMs / 1000)}s`,
    );
    scheduleNextHealthraySync(breakMs);
  }, delayMs);
}
let recoveryIntervalId = null;
let dailyBackfillIntervalId = null;
let stuckStatusIntervalId = null;
let docRecoveryIntervalId = null;
let missingMedsIntervalId = null;
let pdfRetryIntervalId = null;
let blankSweepIntervalId = null;

export function startCronJobs() {
  if (!process.env.HEALTHRAY_MOBILE && !process.env.HEALTHRAY_SESSION) {
    console.log("[Cron] HealthRay credentials not set — walking appointment sync disabled");
  } else {
    console.log(
      "[Cron] Starting walking appointment sync (continuous loop, 10–15s break between runs)...",
    );

    healthrayLoopRunning = true;

    // Run initial full sync on startup, then enter the continuous today-sync loop
    (async () => {
      try {
        await syncWalkingAppointments();
      } catch (e) {
        console.error("[Cron] Initial sync failed:", e.message);
      }
      scheduleNextHealthraySync(0);
    })();
  }

  // ── Lab HealthRay sync (every 1 min, staggered) ───────────────────────────
  // Offset by ~30s so the lab sync and healthray sync never start at the
  // same moment — the global advisory lock would still serialize them, but
  // staggering spreads the load across the 1-min window so users see fewer
  // back-to-back latency spikes.
  const LAB_SYNC_OFFSET_MS = Math.floor(SYNC_INTERVAL_MS / 2); // 30s offset
  console.log("[Cron] Starting lab sync (every 1 min, staggered +30s)...");

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

  // ── Lab PDF retry recovery ────────────────────────────────────────────────
  // Picks up lab cases whose PDF backoff window (pdf_next_attempt_at) has
  // elapsed and re-attempts the download. Per-case backoff is 30–40 min after
  // the first failure, then every 4 h for up to 3 days. We only need to wake
  // up often enough to catch the shortest window — every 15 min is plenty.
  const PDF_RETRY_INTERVAL_MS = 15 * 60 * 1000;
  console.log("[Cron] Starting lab PDF retry recovery (every 15 min)...");
  setTimeout(
    () => {
      runPdfRetryRecovery().catch((e) => console.error("[Cron] Lab PDF retry failed:", e.message));
      pdfRetryIntervalId = setInterval(() => {
        runPdfRetryRecovery().catch((e) =>
          console.error("[Cron] Lab PDF retry failed:", e.message),
        );
      }, PDF_RETRY_INTERVAL_MS);
    },
    5 * 60 * 1000,
  ); // start 5 min after boot to let the regular sync settle

  // ── Blank-PDF safety-net sweep ───────────────────────────────────────────
  // Every 30 min, re-checks stored lab PDFs that are at least 2 hours old.
  // If a stored file is still the placeholder template, clears it so the
  // PDF-retry cron will re-download the real report. The 2-hour age is
  // enforced inside sweepBlankStoredLabPdfs, so this interval just needs to
  // be small enough to keep latency on the safety net low.
  const BLANK_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
  console.log("[Cron] Starting blank lab PDF sweep (every 30 min, 2h age threshold)...");
  setTimeout(
    () => {
      runBlankLabPdfSweep().catch((e) =>
        console.error("[Cron] Blank lab PDF sweep failed:", e.message),
      );
      blankSweepIntervalId = setInterval(() => {
        runBlankLabPdfSweep().catch((e) =>
          console.error("[Cron] Blank lab PDF sweep failed:", e.message),
        );
      }, BLANK_SWEEP_INTERVAL_MS);
    },
    7 * 60 * 1000, // start 7 min after boot, offset from PDF retry (5 min)
  );

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
  if (healthrayLoopRunning || healthrayLoopTimeoutId) {
    healthrayLoopRunning = false;
    if (healthrayLoopTimeoutId) {
      clearTimeout(healthrayLoopTimeoutId);
      healthrayLoopTimeoutId = null;
    }
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
  if (pdfRetryIntervalId) {
    clearInterval(pdfRetryIntervalId);
    pdfRetryIntervalId = null;
    console.log("[Cron] Lab PDF retry recovery stopped");
  }
  if (blankSweepIntervalId) {
    clearInterval(blankSweepIntervalId);
    blankSweepIntervalId = null;
    console.log("[Cron] Blank lab PDF sweep stopped");
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
  runPdfRetryRecovery,
  runBlankLabPdfSweep,
  runDailyOpdBackfill,
  runStuckStatusRecovery,
  runMissingMedsRecovery,
  runDocumentRecovery,
};
