// ── Lab HealthRay Sync Cron ──────────────────────────────────────────────────
// Fetches new lab cases every 5 min, writes results to lab_results table.

import { fetchLabCasesForDate, fetchLabCaseDetail } from "../lab/labHealthrayApi.js";
import {
  parseLabCaseResults,
  extractTestNames,
  extractCaseDate,
} from "../lab/labHealthrayParser.js";
import {
  ensureLabCasesTable,
  insertLabCase,
  markLabCaseSynced,
  getPendingLabCases,
  matchLabPatient,
  linkLabAppointment,
  syncLabCaseResults,
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

  // Step b: match patient
  const patientId = await matchLabPatient(patient.healthray_uid);

  // Step c: fetch case detail
  let detail;
  try {
    detail = await fetchLabCaseDetail(caseUid, labCaseId, labUserId);
  } catch (e) {
    log("Error", `case ${patientCaseNo}: detail fetch failed — ${e.message}`);
    return { error: e.message, caseNo };
    // row stays results_synced=false → recovery will retry
  }

  // Step d: parse results
  const results = parseLabCaseResults(detail);

  // Step e: link appointment
  const appointmentId = await linkLabAppointment(detail.healthray_order_id);

  // Step f: write to lab_results
  const written = await syncLabCaseResults(patientId, appointmentId, caseDate, results);

  // Step g: mark synced
  await markLabCaseSynced(caseNo, { patientId, appointmentId, rawDetailJson: detail });

  log(
    "Sync",
    `${patientCaseNo} | patient=${patient.healthray_uid || "unknown"} | ${results.length} params | ${written} written`,
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

// ── Recovery job: retry cases stuck with results_synced=false ───────────────
export async function retryPendingLabCases() {
  const pending = await getPendingLabCases();
  if (!pending.length) return;

  log("Recovery", `${pending.length} pending cases to retry`);

  for (const row of pending) {
    try {
      const patientId = row.patient_id;
      const caseDate = row.case_date ? row.case_date.toISOString().slice(0, 10) : null;

      let detail;
      try {
        detail = await fetchLabCaseDetail(row.case_uid, row.lab_case_id, row.lab_user_id);
      } catch (e) {
        log("Recovery", `${row.patient_case_no}: still failing — ${e.message}`);
        continue;
      }

      const results = parseLabCaseResults(detail);
      const appointmentId =
        row.appointment_id || (await linkLabAppointment(detail.healthray_order_id));
      const written = await syncLabCaseResults(patientId, appointmentId, caseDate, results);
      await markLabCaseSynced(row.case_no, { patientId, appointmentId, rawDetailJson: detail });

      log("Recovery", `${row.patient_case_no} recovered | ${written} results written`);
    } catch (e) {
      log("Recovery", `${row.patient_case_no} error: ${e.message}`);
    }
  }
}
