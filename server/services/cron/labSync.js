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

const { log } = createLogger("Lab Sync");

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
    // Either we wrote rows OR all in-house tests have results (even if nothing
    // landed because of source-priority skips). Either way, terminal.
    await markLabCaseSynced(caseNo, { patientId, appointmentId, rawDetailJson: detail });
  }
  // Otherwise leave results_synced=false so the recovery loop keeps trying.

  // Step h: download lab report PDF (fire-and-forget — never blocks sync)
  if (patientId && listRow.case_attachment_file_name) {
    downloadAndStoreLabPdf(
      patientId,
      caseNo,
      caseUid,
      labCaseId,
      labUserId,
      listRow.case_attachment_file_name,
      caseDate,
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

    const batchResults = await runBatch(newCases, 5, processCase);

    let written = 0;
    let errors = 0;
    for (const r of batchResults) {
      if (r.status === "fulfilled" && r.value?.written) written += r.value.written;
      if (r.status === "rejected" || r.value?.error) errors++;
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

  log("Recovery", `${pending.length} pending cases to retry`);

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

      // Download PDF if not already stored
      if (patientId && !row.pdf_storage_path && row.pdf_file_name) {
        downloadAndStoreLabPdf(
          patientId,
          row.case_no,
          row.case_uid,
          row.lab_case_id,
          row.lab_user_id,
          row.pdf_file_name,
          caseDate,
        ).catch((e) => log("PDF", `${row.patient_case_no}: PDF failed — ${e.message}`));
      }

      log(
        "Recovery",
        `${row.patient_case_no} | src=${caseSource} | ${ready}/${expected} ready | ${written} written | retry=${bump?.retry_count}`,
      );
    } catch (e) {
      log("Recovery", `${row.patient_case_no} error: ${e.message}`);
    }
  }
}
