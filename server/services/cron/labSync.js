// ── Lab HealthRay Sync Cron ──────────────────────────────────────────────────
// Fetches new lab cases every 5 min, writes results to lab_results table.

import { fetchLabCasesForDate, fetchLabCaseDetail } from "../lab/labHealthrayApi.js";
import {
  parseLabCaseResults,
  extractTestNames,
  extractCaseDate,
  classifyCaseSource,
  countInhouseProgress,
} from "../lab/labHealthrayParser.js";
import {
  ensureLabCasesTable,
  insertLabCase,
  markLabCaseSynced,
  getPendingLabCases,
  getPdfPendingCases,
  matchLabPatient,
  ensureLabPatient,
  linkLabAppointment,
  syncLabCaseResults,
  patchLabRanges,
  setLabCaseSource,
  bumpLabCaseRetry,
  abandonLabCase,
  downloadAndStoreLabPdf,
  sweepBlankStoredLabPdfs,
} from "../lab/db.js";
import { createLogger } from "../logger.js";
import { tryAcquireCronLock, yieldToApp, CRON_LOCK_KEYS } from "./lowPriority.js";

const { log } = createLogger("Lab Sync");

// Pause between items so the Node event loop can service user HTTP requests
// before the next sync item grabs CPU/DB again.
const YIELD_BETWEEN_ITEMS_MS = 300;

// ── Status tracking ──────────────────────────────────────────────────────────
const status = {
  lastRun: null,
  lastResult: null,
  isRunning: false,
};

export function getLabSyncStatus() {
  return { ...status };
}

// ── Process a single case (list row) ────────────────────────────────────────
async function processCase(listRow) {
  const caseNo = listRow.case_no;
  const patientCaseNo = listRow.patient_case_no;
  const caseUid = listRow.case_uid;
  const labCaseId = listRow.id;
  const labUserId = listRow.user_id;
  const caseDate = extractCaseDate(listRow);
  const testNames = extractTestNames(listRow);
  const patient = listRow.patient || {};

  // Step a: insert anchor row — if already exists (ON CONFLICT), returns null → skip
  const rowId = await insertLabCase({
    caseNo,
    patientCaseNo,
    caseUid,
    labCaseId,
    labUserId,
    labBranchId: listRow.lab_branch_id,
    testNames,
    caseDate,
    caseStatus: listRow.case_status,
    pdfFileName: listRow.case_attachment_file_name || null,
    rawListJson: listRow,
  });

  if (rowId === null) return { skipped: true }; // already processed

  // Classify outsource vs in-house from the list row (saves an API call when
  // the case is fully outsourced — we still record the case but skip retries).
  const sourceFromList = classifyCaseSource(listRow);
  await setLabCaseSource(caseNo, sourceFromList);

  // Step b: match patient — universal P_ ID first; auto-create stub if missing
  let patientId = await matchLabPatient(patient.healthray_uid, patientCaseNo, patient);
  if (!patientId) {
    patientId = await ensureLabPatient(patient);
  }

  // Step c: fetch case detail
  let detail;
  try {
    detail = await fetchLabCaseDetail(caseUid, labCaseId, labUserId);
  } catch (e) {
    log("Error", `case ${patientCaseNo}: detail fetch failed — ${e.message}`);
    return { error: e.message, caseNo };
    // row stays results_synced=false → recovery will retry
  }

  // Refine source classification using the richer detail payload
  const detailSource = classifyCaseSource(detail);
  const caseSource = detailSource === "unknown" ? sourceFromList : detailSource;
  if (caseSource && caseSource !== sourceFromList) {
    await setLabCaseSource(caseNo, caseSource);
  }

  // Step d: parse results
  const results = parseLabCaseResults(detail);

  // Step e: link appointment
  const appointmentId = await linkLabAppointment(detail.healthray_order_id);

  // Step f: write to lab_results (no-op when no patient — kept for symmetry)
  const written = await syncLabCaseResults(patientId, appointmentId, caseDate, results);

  // Step g: decide whether the case is terminal
  const { expected, ready } = countInhouseProgress(detail);
  const inhouseComplete = expected > 0 && ready >= expected;

  if (caseSource === "outsource") {
    // Nothing more will arrive on this API channel for an outsource-only case.
    await markLabCaseSynced(caseNo, { patientId, appointmentId, rawDetailJson: detail });
    await abandonLabCase(caseNo, "outsource-only");
  } else if (patientId && (written > 0 || inhouseComplete)) {
    // Terminal only when we have *writable* results: either rows were written,
    // or every in-house parameter has a numeric value (so a higher-priority
    // source pre-empted our writes). Both legs depend on countInhouseProgress
    // counting numeric-only — do not loosen it to accept text-only results,
    // or empty cases will be marked synced and render blank in the UI.
    await markLabCaseSynced(caseNo, { patientId, appointmentId, rawDetailJson: detail });
  }
  // Otherwise leave results_synced=false so the recovery loop keeps trying.

  // Step h: download lab report PDF (fire-and-forget — never blocks sync).
  // Printability is enforced inside downloadAndStoreLabPdf via
  // isLabCasePrintable(case_status, detail). When the case is still
  // "In Process" the downloader skips the puppeteer fetch and schedules a
  // retry, so we never capture and persist Healthray's blank placeholder PDF.
  // A content-emptiness post-gate (looksLikeBlankLabPdf) acts as a safety net
  // for cases where status appears printable but the rendered PDF still has
  // no test data.
  if (patientId) {
    downloadAndStoreLabPdf(
      patientId,
      caseNo,
      caseUid,
      labCaseId,
      labUserId,
      listRow.case_attachment_file_name,
      caseDate,
      detail,
    ).catch((e) => log("PDF", `${patientCaseNo}: PDF download failed — ${e.message}`));
  }

  log(
    "Sync",
    `${patientCaseNo} | patient=${patient.healthray_uid || "unknown"} | src=${caseSource} | ${ready}/${expected} ready | ${written} written`,
  );

  return { caseNo, patientId, appointmentId, total: results.length, written };
}

// ── Run batch with concurrency limit ────────────────────────────────────────
async function runBatch(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = await Promise.allSettled(items.slice(i, i + concurrency).map(fn));
    results.push(...batch);
  }
  return results;
}

// Get today's date in IST as YYYY-MM-DD
function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ── Main sync run ────────────────────────────────────────────────────────────
export async function runLabSync(dateStr) {
  if (status.isRunning) {
    log("Skip", "Already running");
    return;
  }

  // Global cron advisory lock — ensures only one cron job (lab / healthray /
  // backfill / recovery) touches the DB at a time. If another job is holding
  // the lock, we skip this tick and let the next 5-min run pick up the work.
  const releaseLock = await tryAcquireCronLock("Lab Sync", CRON_LOCK_KEYS.LAB_SYNC);
  if (!releaseLock) return;

  status.isRunning = true;
  status.lastRun = new Date().toISOString();
  const date = dateStr || todayIST();

  try {
    await ensureLabCasesTable();

    const allCases = await fetchLabCasesForDate(date);

    // Skip cancelled — dedup handled inside processCase via ON CONFLICT
    const newCases = allCases.filter((c) => c.case_status !== "Cancelled");

    log("Fetch", `${date} | ${allCases.length} cases from API | ${newCases.length} to process`);

    if (newCases.length === 0) {
      status.lastResult = { date, cases: 0, written: 0 };
      return status.lastResult;
    }

    // Process sequentially, yielding to the event loop between cases so user
    // requests stay responsive while the background sync drains.
    let written = 0;
    let errors = 0;
    for (const c of newCases) {
      try {
        const r = await processCase(c);
        if (r?.written) written += r.written;
        if (r?.error) errors++;
      } catch (e) {
        errors++;
        log("Case", `error: ${e.message}`);
      }
      await yieldToApp(YIELD_BETWEEN_ITEMS_MS);
    }

    status.lastResult = { date, cases: newCases.length, written, errors };
    log(
      "Done",
      `${date} | ${newCases.length} cases | ${written} results written | ${errors} errors`,
    );
    return status.lastResult;
  } catch (e) {
    log("Error", e.message);
    status.lastResult = { error: e.message };
    throw e;
  } finally {
    status.isRunning = false;
    await releaseLock();
  }
}

// ── Backfill ref_range + flag for existing lab_healthray rows ────────────────
// Re-fetches case detail from API, re-parses ref ranges, and UPDATEs existing rows.
// No rows are deleted or inserted — only ref_range/flag are patched in.
export async function backfillLabRanges(dateStr) {
  const pool = (await import("../../config/db.js")).default;

  // If no date given, backfill ALL synced cases missing ref_range data
  let query, params;
  if (dateStr) {
    query = `SELECT case_uid, lab_case_id, lab_user_id, patient_id, case_date, patient_case_no, case_no
             FROM lab_cases
             WHERE case_date::date = $1::date AND results_synced = TRUE AND patient_id IS NOT NULL`;
    params = [dateStr];
  } else {
    // All synced cases that don't have investigation_summary yet
    query = `SELECT case_uid, lab_case_id, lab_user_id, patient_id, case_date, patient_case_no, case_no
             FROM lab_cases
             WHERE results_synced = TRUE AND patient_id IS NOT NULL
               AND investigation_summary IS NULL
             ORDER BY case_date DESC`;
    params = [];
  }

  const date = dateStr || "all";
  const { rows } = await pool.query(query, params);

  log("Backfill", `${date} | ${rows.length} cases to patch`);

  let totalUpdated = 0;
  for (const row of rows) {
    try {
      const detail = await fetchLabCaseDetail(row.case_uid, row.lab_case_id, row.lab_user_id);
      const results = parseLabCaseResults(detail);
      const { extractInvestigationSummary } = await import("../lab/labHealthrayParser.js");
      const summary = extractInvestigationSummary(detail);
      const caseDate =
        typeof row.case_date === "string"
          ? row.case_date.slice(0, 10)
          : row.case_date.toISOString().slice(0, 10);
      const updated = await patchLabRanges(row.patient_id, caseDate, results);

      // Also store investigation_summary
      await pool.query(
        `UPDATE lab_cases SET investigation_summary = $1::jsonb WHERE case_no = $2`,
        [JSON.stringify(summary), row.case_no],
      );

      totalUpdated += updated;
      log("Backfill", `${row.patient_case_no} | ${updated} rows patched`);
    } catch (e) {
      log("Backfill", `${row.patient_case_no} error: ${e.message}`);
    }
  }

  return { date, cases: rows.length, updated: totalUpdated };
}

// ── Recovery job: retry cases stuck with results_synced=false ───────────────
export async function retryPendingLabCases() {
  const pending = await getPendingLabCases();
  if (!pending.length) return;

  // Respect the global cron lock so recovery never runs alongside the main sync.
  const releaseLock = await tryAcquireCronLock("Lab Recovery", CRON_LOCK_KEYS.LAB_RECOVERY);
  if (!releaseLock) return;

  log("Recovery", `${pending.length} pending cases to retry`);

  try {
    for (const row of pending) {
      try {
        const caseDate = row.case_date
          ? typeof row.case_date === "string"
            ? row.case_date.slice(0, 10)
            : row.case_date.toISOString().slice(0, 10)
          : null;

        // Bump retry counter first; if the cap is hit the row will be marked
        // abandoned and skipped on subsequent ticks.
        const bump = await bumpLabCaseRetry(row.case_no);
        if (bump?.retry_abandoned) {
          log("Recovery", `${row.patient_case_no}: retry cap reached, abandoning`);
          continue;
        }

        // Re-attempt patient match — covers orphan rows from before file_no
        // matching was prioritised (and rows where the OPD sync hadn't yet
        // created the patient on the first pass).
        let patientId = row.patient_id;
        const patientObj = row.raw_list_json?.patient || null;
        if (!patientId && patientObj) {
          patientId =
            (await matchLabPatient(patientObj.healthray_uid, row.patient_case_no, patientObj)) ||
            (await ensureLabPatient(patientObj));
        }

        let detail;
        try {
          detail = await fetchLabCaseDetail(row.case_uid, row.lab_case_id, row.lab_user_id);
        } catch (e) {
          log("Recovery", `${row.patient_case_no}: still failing — ${e.message}`);
          continue;
        }

        // Recompute source from richer detail payload
        const detailSource = classifyCaseSource(detail);
        const caseSource = detailSource === "unknown" ? row.case_source || "unknown" : detailSource;
        if (caseSource && caseSource !== row.case_source) {
          await setLabCaseSource(row.case_no, caseSource);
        }

        const results = parseLabCaseResults(detail);
        const appointmentId =
          row.appointment_id || (await linkLabAppointment(detail.healthray_order_id));
        const written = await syncLabCaseResults(patientId, appointmentId, caseDate, results);

        const { expected, ready } = countInhouseProgress(detail);
        const inhouseComplete = expected > 0 && ready >= expected;

        if (caseSource === "outsource") {
          await markLabCaseSynced(row.case_no, { patientId, appointmentId, rawDetailJson: detail });
          await abandonLabCase(row.case_no, "outsource-only");
        } else if (patientId && (written > 0 || inhouseComplete)) {
          await markLabCaseSynced(row.case_no, { patientId, appointmentId, rawDetailJson: detail });
        }

        // Download PDF if not already stored. The downloader handles its own
        // backoff (30–40 min, then 4 h for up to 3 days) and distinguishes
        // a transient failure from a definitive "No Report Found".
        if (patientId && !row.pdf_storage_path) {
          downloadAndStoreLabPdf(
            patientId,
            row.case_no,
            row.case_uid,
            row.lab_case_id,
            row.lab_user_id,
            row.pdf_file_name,
            caseDate,
            detail,
          ).catch((e) => log("PDF", `${row.patient_case_no}: PDF failed — ${e.message}`));
        }

        log(
          "Recovery",
          `${row.patient_case_no} | src=${caseSource} | ${ready}/${expected} ready | ${written} written | retry=${bump?.retry_count}`,
        );
      } catch (e) {
        log("Recovery", `${row.patient_case_no} error: ${e.message}`);
      }
      await yieldToApp(YIELD_BETWEEN_ITEMS_MS);
    }
  } finally {
    await releaseLock();
  }
}

// ── Backfill PDFs for synced cases that are missing them ────────────────────
export async function backfillLabPdfs({ concurrency = 2 } = {}) {
  const pool = (await import("../../config/db.js")).default;

  // Pull every case that's missing a PDF. The per-row live-detail check
  // inside isLabCasePrintable is now the source of truth for readiness, so
  // we no longer pre-filter on stale case_status / results_synced (those
  // miss cases that became printable after the row was first inserted).
  const { rows } = await pool.query(
    `SELECT case_no, patient_case_no, case_uid, lab_case_id, lab_user_id,
            patient_id, pdf_file_name, case_date, case_status, results_synced
     FROM lab_cases
     WHERE patient_id IS NOT NULL
       AND pdf_storage_path IS NULL
       AND COALESCE(retry_abandoned, FALSE) = FALSE
       AND COALESCE(pdf_unavailable, FALSE) = FALSE
       AND LOWER(REGEXP_REPLACE(COALESCE(case_status, ''), '[\\s_]', '', 'g')) <> 'cancelled'
     ORDER BY case_date DESC`,
  );

  log("PDF Backfill", `${rows.length} cases missing PDFs`);

  if (rows.length === 0) return { total: 0, downloaded: 0, skipped: 0, errors: 0 };

  let downloaded = 0,
    skipped = 0,
    errors = 0;

  await runBatch(rows, concurrency, async (row) => {
    try {
      const caseDate = row.case_date
        ? typeof row.case_date === "string"
          ? row.case_date.slice(0, 10)
          : row.case_date.toISOString().slice(0, 10)
        : null;

      // Re-fetch the case detail so we can verify EVERY in-house test now has
      // a result before attempting the PDF. Stored case_status is written
      // once at insert and goes stale; results_synced flips to TRUE on the
      // first numeric write, so neither stored signal is reliable on its own.
      let detail = null;
      try {
        detail = await fetchLabCaseDetail(row.case_uid, row.lab_case_id, row.lab_user_id);
      } catch (e) {
        log("PDF Backfill", `${row.patient_case_no}: detail fetch failed — ${e.message}`);
        errors++;
        return;
      }

      // No printable pre-gate — let downloadAndStoreLabPdf differentiate
      // "No Report Found" (definitive) from a transient failure (retry via
      // its own backoff schedule). The old gate was rejecting partial-results
      // cases that Healthray actually serves a PDF for.

      const path = await downloadAndStoreLabPdf(
        row.patient_id,
        row.case_no,
        row.case_uid,
        row.lab_case_id,
        row.lab_user_id,
        row.pdf_file_name,
        caseDate,
        detail,
      );

      if (path) {
        downloaded++;
        log("PDF Backfill", `${row.patient_case_no} -> ${path}`);
      } else {
        skipped++;
      }
    } catch (e) {
      errors++;
      log("PDF Backfill", `${row.patient_case_no} error: ${e.message}`);
    }
  });

  log("PDF Backfill", `Done — ${downloaded} downloaded, ${skipped} skipped, ${errors} errors`);
  return { total: rows.length, downloaded, skipped, errors };
}

// ── Scheduled PDF retry recovery ────────────────────────────────────────────
// Picks up cases whose backoff window (pdf_next_attempt_at) has elapsed and
// retries the PDF download. The downloader itself handles attempt counting,
// next-window scheduling, and the 3-day budget abandonment — so this loop
// just iterates due rows and lets downloadAndStoreLabPdf do the work.
// ── Blank-PDF safety-net sweep ──────────────────────────────────────────────
// Re-validates each stored lab PDF after it's been at rest for 2 hours. If
// the file is still the "In Process" placeholder, it's cleared so the
// existing PDF-retry cron will fetch the real report. Backs up the in-flight
// gates (isLabCasePrintable + looksLikeBlankLabPdf) for any edge case where a
// blank PDF still slips through.
export async function runBlankLabPdfSweep({ limit = 50 } = {}) {
  const releaseLock = await tryAcquireCronLock("Lab Blank Sweep", CRON_LOCK_KEYS.LAB_SYNC);
  if (!releaseLock) return { scanned: 0, blanks: 0, verified: 0, errors: 0 };
  try {
    const result = await sweepBlankStoredLabPdfs({ limit });
    return result;
  } finally {
    await releaseLock();
  }
}

export async function runPdfRetryRecovery({ concurrency = 1 } = {}) {
  const releaseLock = await tryAcquireCronLock("Lab PDF Retry", CRON_LOCK_KEYS.LAB_SYNC);
  if (!releaseLock) return { total: 0, downloaded: 0, skipped: 0, errors: 0 };
  try {
    await ensureLabCasesTable();
    const rows = await getPdfPendingCases({ limit: 30 });
    if (!rows.length) {
      log("PDF Retry", "no cases due for retry");
      return { total: 0, downloaded: 0, skipped: 0, errors: 0 };
    }
    log("PDF Retry", `${rows.length} cases due for retry`);

    let downloaded = 0,
      skipped = 0,
      errors = 0;

    await runBatch(rows, concurrency, async (row) => {
      try {
        const caseDate = row.case_date
          ? typeof row.case_date === "string"
            ? row.case_date.slice(0, 10)
            : row.case_date.toISOString().slice(0, 10)
          : null;
        const path = await downloadAndStoreLabPdf(
          row.patient_id,
          row.case_no,
          row.case_uid,
          row.lab_case_id,
          row.lab_user_id,
          row.pdf_file_name,
          caseDate,
          null, // let the downloader fetch fresh detail
        );
        if (path) {
          downloaded++;
          log("PDF Retry", `${row.patient_case_no} -> ${path}`);
        } else {
          skipped++;
        }
      } catch (e) {
        errors++;
        log("PDF Retry", `${row.patient_case_no} error: ${e.message}`);
      }
      await yieldToApp(YIELD_BETWEEN_ITEMS_MS);
    });

    log("PDF Retry", `Done — ${downloaded} downloaded, ${skipped} skipped, ${errors} errors`);
    return { total: rows.length, downloaded, skipped, errors };
  } finally {
    await releaseLock();
  }
}
