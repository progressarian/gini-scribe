// ── Lab HealthRay Sync Cron ──────────────────────────────────────────────────
// Fetches new lab cases every 5 min, writes results to lab_results table.

import { fetchLabCasesForDate, fetchLabCaseDetail } from "../lab/labHealthrayApi.js";
import {
  parseLabCaseResults,
  extractTestNames,
  extractCaseDate,
  classifyCaseSource,
  countInhouseProgress,
  isLabCasePrintable,
} from "../lab/labHealthrayParser.js";
import {
  ensureLabCasesTable,
  insertLabCase,
  markLabCaseSynced,
  getPendingLabCases,
  matchLabPatient,
  ensureLabPatient,
  linkLabAppointment,
  syncLabCaseResults,
  patchLabRanges,
  setLabCaseSource,
  bumpLabCaseRetry,
  abandonLabCase,
  downloadAndStoreLabPdf,
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
  // Gate on case readiness — HealthRay's /download-report URL still resolves
  // for in-process cases but produces a structurally valid blank PDF that
  // would pass the integrity check and persist forever.
  // resultsSynced mirrors the markLabCaseSynced terminal condition above.
  if (patientId) {
    const willMarkSynced = caseSource === "outsource" || written > 0 || inhouseComplete;
    const printable = isLabCasePrintable(listRow.case_status, detail, {
      resultsSynced: willMarkSynced,
    });
    if (printable.ready) {
      downloadAndStoreLabPdf(
        patientId,
        caseNo,
        caseUid,
        labCaseId,
        labUserId,
        listRow.case_attachment_file_name,
        caseDate,
      ).catch((e) => log("PDF", `${patientCaseNo}: PDF download failed — ${e.message}`));
    } else {
      log("PDF", `${patientCaseNo}: skip PDF download (${printable.reason})`);
    }
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

        // Download PDF if not already stored — gated on case readiness.
        // row.case_status may be stale (column is written-once-at-insert),
        // so the inhouseComplete fallback inside isLabCasePrintable is the
        // robust signal here. resultsSynced mirrors the terminal condition
        // we just evaluated above (or row.results_synced if it was already
        // terminal on a prior pass).
        if (patientId && !row.pdf_storage_path) {
          const status = row.case_status || row.raw_list_json?.case_status;
          const willMarkSynced = caseSource === "outsource" || written > 0 || inhouseComplete;
          const printable = isLabCasePrintable(status, detail, {
            resultsSynced: row.results_synced || willMarkSynced,
          });
          if (printable.ready) {
            downloadAndStoreLabPdf(
              patientId,
              row.case_no,
              row.case_uid,
              row.lab_case_id,
              row.lab_user_id,
              row.pdf_file_name,
              caseDate,
            ).catch((e) => log("PDF", `${row.patient_case_no}: PDF failed — ${e.message}`));
          } else {
            log("Recovery", `${row.patient_case_no}: skip PDF (${printable.reason})`);
          }
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

  // Only attempt PDF download for cases that look printable. case_status is
  // the explicit signal; results_synced=TRUE is the inhouseComplete proxy
  // (set in markLabCaseSynced when results were written or all in-house
  // params have numeric values).
  const { rows } = await pool.query(
    `SELECT case_no, patient_case_no, case_uid, lab_case_id, lab_user_id,
            patient_id, pdf_file_name, case_date, case_status, results_synced
     FROM lab_cases
     WHERE patient_id IS NOT NULL
       AND pdf_storage_path IS NULL
       AND COALESCE(retry_abandoned, FALSE) = FALSE
       AND COALESCE(pdf_unavailable, FALSE) = FALSE
       AND (
         LOWER(REGEXP_REPLACE(COALESCE(case_status, ''), '[\\s_]', '', 'g')) = 'printable'
         OR results_synced = TRUE
       )
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

      // Belt-and-braces — the SQL filter already excludes non-printable rows,
      // but check again so any future query change cannot regress the bug.
      const printable = isLabCasePrintable(row.case_status, null, {
        resultsSynced: !!row.results_synced,
      });
      if (!printable.ready) {
        skipped++;
        log("PDF Backfill", `${row.patient_case_no} skipped (${printable.reason})`);
        return;
      }

      const path = await downloadAndStoreLabPdf(
        row.patient_id,
        row.case_no,
        row.case_uid,
        row.lab_case_id,
        row.lab_user_id,
        row.pdf_file_name,
        caseDate,
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
