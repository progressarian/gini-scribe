/**
 * Resync blank lab PDFs from lab.healthray.com.
 *
 * Conservatively detects blank PDFs (a PDF stored when the report was still
 * "In Process" — structurally valid but content-empty) and re-downloads when
 * the case is now Printable.
 *
 * Deletion is ONLY done when ALL of the following are true:
 *   - pdf_storage_path is set (we have something stored)
 *   - lab_cases.results_synced is FALSE (our DB has no parsed results yet)
 *   - lab_cases.case_status was originally "In Process"
 *   - the FRESH case detail also says the case is not yet ready
 *
 * That guards against deleting real PDFs for cases like P_147070/G14060 where
 * the report has results in our DB but case_status was never "Printable".
 *
 * Usage:
 *   # Dry run (default) — shows what would happen
 *   node server/scripts/resync-blank-lab-pdfs.js
 *
 *   # Apply changes
 *   node server/scripts/resync-blank-lab-pdfs.js --apply
 *
 *   # Single patient
 *   node server/scripts/resync-blank-lab-pdfs.js --apply --file-no=P_179795
 *
 *   # Adjust concurrency (default 10)
 *   node server/scripts/resync-blank-lab-pdfs.js --apply --concurrency=20
 *
 *   # ALSO download for cases that have NO stored PDF — recovery path after
 *   # the over-deletion incident on 2026-05-01. This is the mode you want
 *   # to re-import all the cleared PDFs.
 *   node server/scripts/resync-blank-lab-pdfs.js --apply --missing
 *
 *   # Skip the puppeteer-heavy download phase (only triage + delete blanks).
 *   node server/scripts/resync-blank-lab-pdfs.js --apply --no-download
 *
 *   # Disable deletion entirely — only download missing/printable cases.
 *   node server/scripts/resync-blank-lab-pdfs.js --apply --no-delete --missing
 *
 * Environment overrides:
 *   LAB_PUPPETEER_CONCURRENCY=N  Cap concurrent PDF renders. Default 1
 *                                (HealthRay's PDF backend serialises). Set to
 *                                2 for steady-state cron once recovery done.
 *
 * Notes:
 *   - Cases marked pdf_unavailable=TRUE (HealthRay: "No Report Found") are
 *     skipped automatically. Use `POST /api/sync/lab/import-pdf?file_no=...
 *     &force=1` if you suspect HealthRay later generated a PDF and want to
 *     retry those cases manually.
 *   - The outer --concurrency controls case_detail fetches (cheap, fast).
 *     Puppeteer downloads are throttled separately by the env var above.
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { fetchLabCaseDetail } = await import("../services/lab/labHealthrayApi.js");
const { isLabCasePrintable, normalizeCaseStatus } =
  await import("../services/lab/labHealthrayParser.js");
const { downloadAndStoreLabPdf, ensureLabCasesTable } = await import("../services/lab/db.js");
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } = await import("../config/storage.js");

// Apply any pending ALTER TABLEs (e.g. pdf_unavailable). Normally this runs
// when the cron service boots; the script bypasses that, so call it here.
await ensureLabCasesTable();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const includeMissing = args.includes("--missing");
const noDownload = args.includes("--no-download");
const noDelete = args.includes("--no-delete");
const fileNoArg = args.find((a) => a.startsWith("--file-no="))?.split("=")[1] || null;
const concurrency =
  parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1], 10) || 10;

console.log(
  `Resync lab PDFs — apply=${apply}, file_no=${fileNoArg || "all"}, concurrency=${concurrency}, missing=${includeMissing}, no-download=${noDownload}, no-delete=${noDelete}`,
);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY — cannot proceed");
  process.exit(1);
}

// ── Build SELECT ────────────────────────────────────────────────────────────
const params = [];
// Skip cases where HealthRay has already told us no PDF exists. The
// /api/sync/lab/import-pdf?force=1 route is the manual escape hatch for
// retrying those.
let where =
  "patient_id IS NOT NULL AND COALESCE(retry_abandoned, FALSE) = FALSE AND COALESCE(pdf_unavailable, FALSE) = FALSE";

if (fileNoArg) {
  params.push(fileNoArg);
  where += ` AND patient_id = (SELECT id FROM patients WHERE file_no = $${params.length})`;
}

// Candidate sets:
//   default:  stored PDFs that look suspect (results_synced=FALSE OR original
//             status was non-printable). Conservative — won't include PDFs
//             that were already verified by sync.
//   --missing: ALSO include cases with no PDF (recovery path).
if (includeMissing) {
  where += ` AND (
    pdf_storage_path IS NULL
    OR (pdf_storage_path IS NOT NULL AND
        (results_synced = FALSE
         OR LOWER(REGEXP_REPLACE(COALESCE(case_status, ''), '[\\s_]', '', 'g')) <> 'printable'))
  )`;
} else {
  where += ` AND pdf_storage_path IS NOT NULL
    AND (
      results_synced = FALSE
      OR LOWER(REGEXP_REPLACE(COALESCE(case_status, ''), '[\\s_]', '', 'g')) <> 'printable'
    )`;
}

const { rows: cases } = await pool.query(
  `SELECT case_no, patient_case_no, patient_id, case_uid, lab_case_id, lab_user_id,
          pdf_file_name, case_date, pdf_storage_path, case_status, results_synced
   FROM lab_cases
   WHERE ${where}
   ORDER BY case_date DESC`,
  params,
);

console.log(`Found ${cases.length} candidate cases`);
if (cases.length === 0) {
  await pool.end();
  process.exit(0);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const stats = {
  scanned: 0,
  detailFailed: 0,
  stillInProcess: 0,
  alreadyOk: 0,
  protectedRealPdf: 0,
  deletedBlank: 0,
  downloaded: 0,
  markedUnavailable: 0, // HealthRay returned "No Report Found"
  downloadFailed: 0, // transient — nav timeout, render stuck, etc.
  errors: 0,
};

async function deleteSupabaseFile(storagePath) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  }).catch(() => null);
  return res?.ok ?? false;
}

async function clearStoredPdf(row) {
  if (row.pdf_storage_path) {
    await deleteSupabaseFile(row.pdf_storage_path);
  }
  await pool.query(
    `DELETE FROM documents
       WHERE patient_id = $1 AND source = 'lab_healthray' AND notes = $2`,
    [row.patient_id, `lab_case:${row.case_no}`],
  );
  await pool.query(`UPDATE lab_cases SET pdf_storage_path = NULL WHERE case_no = $1`, [
    row.case_no,
  ]);
}

async function setCaseStatus(caseNo, newStatus) {
  if (!newStatus) return;
  await pool.query(
    `UPDATE lab_cases SET case_status = $2
       WHERE case_no = $1 AND case_status IS DISTINCT FROM $2`,
    [caseNo, newStatus],
  );
}

function caseDateStr(row) {
  return row.case_date
    ? typeof row.case_date === "string"
      ? row.case_date.slice(0, 10)
      : row.case_date.toISOString().slice(0, 10)
    : null;
}

// ── Per-case processor ──────────────────────────────────────────────────────
async function processOne(row) {
  stats.scanned++;
  const tag = row.patient_case_no || row.case_no;

  let detail = null;
  try {
    detail = await fetchLabCaseDetail(row.case_uid, row.lab_case_id, row.lab_user_id);
  } catch (e) {
    stats.detailFailed++;
    console.log(`  ${tag}: detail-fetch-failed (${e.message})`);
    // Don't continue — without detail we cannot make a confident decision
    return;
  }

  // Strongest available signal: live status + detail + our own results_synced.
  const liveStatus = detail.case_status || row.case_status;
  const printable = isLabCasePrintable(liveStatus, detail, {
    resultsSynced: !!row.results_synced,
  });

  // Persist the freshest status so the gate inside downloadAndStoreLabPdf
  // sees reality. If we determined the case is ready via inhouseComplete or
  // results-synced but case_status is null/empty, write "Printable" so the
  // gate (which only sees stored case_status, not detail) lets us through.
  let statusToWrite = liveStatus;
  if (
    printable.ready &&
    (printable.reason === "inhouse-complete" || printable.reason === "results-synced") &&
    normalizeCaseStatus(statusToWrite) !== "printable"
  ) {
    statusToWrite = "Printable";
  }
  if (apply && statusToWrite && statusToWrite !== row.case_status) {
    await setCaseStatus(row.case_no, statusToWrite);
  }

  // ── Decision branches ────────────────────────────────────────────────────
  if (!printable.ready) {
    stats.stillInProcess++;

    // Conservative deletion: only delete a stored PDF if we are CONFIDENT
    // it is blank. The rule: pdf_storage_path set AND results_synced=FALSE
    // AND original case_status was "In Process" AND live status also not
    // ready. Anything else, leave the PDF alone — over-deletion is worse
    // than missing a cleanup, because re-downloading is unreliable.
    const wasInProcess = normalizeCaseStatus(row.case_status) === "inprocess";
    const safeToDelete = row.pdf_storage_path && !row.results_synced && wasInProcess && !noDelete;

    if (safeToDelete) {
      if (apply) {
        try {
          await clearStoredPdf(row);
          stats.deletedBlank++;
          console.log(`  ${tag}: deleted blank PDF (${printable.reason})`);
        } catch (e) {
          stats.errors++;
          console.log(`  ${tag}: clear-failed (${e.message})`);
        }
      } else {
        stats.deletedBlank++;
        console.log(`  ${tag}: would delete blank PDF (${printable.reason})`);
      }
    } else if (row.pdf_storage_path) {
      stats.protectedRealPdf++;
      console.log(
        `  ${tag}: keep stored PDF (results_synced=${row.results_synced}, status=${row.case_status})`,
      );
    } else {
      console.log(`  ${tag}: skip (${printable.reason})`);
    }
    return;
  }

  // Case is ready. If we already have a PDF, leave it alone. Otherwise download.
  if (row.pdf_storage_path) {
    stats.alreadyOk++;
    return;
  }

  if (noDownload) {
    console.log(`  ${tag}: would download (skipped — --no-download)`);
    return;
  }

  if (!apply) {
    stats.downloaded++;
    console.log(`  ${tag}: would download (${printable.reason})`);
    return;
  }

  try {
    const path = await downloadAndStoreLabPdf(
      row.patient_id,
      row.case_no,
      row.case_uid,
      row.lab_case_id,
      row.lab_user_id,
      row.pdf_file_name,
      caseDateStr(row),
    );
    if (path) {
      stats.downloaded++;
      console.log(`  ${tag}: downloaded → ${path}`);
    } else {
      // Distinguish "marked unavailable" (No Report Found) from transient
      // failures (nav timeout, render stuck) — they have very different
      // operational meanings.
      const { rows: cur } = await pool.query(
        `SELECT pdf_unavailable FROM lab_cases WHERE case_no = $1`,
        [row.case_no],
      );
      if (cur[0]?.pdf_unavailable) {
        stats.markedUnavailable++;
        console.log(`  ${tag}: marked unavailable (no report on HealthRay)`);
      } else {
        stats.downloadFailed++;
        console.log(`  ${tag}: download failed (transient — nav timeout or render stuck)`);
      }
    }
  } catch (e) {
    stats.downloadFailed++;
    console.log(`  ${tag}: download-error (${e.message})`);
  }
}

// ── Promise-pool concurrency: N workers pull from a shared queue ────────────
async function runPool(items, n, fn) {
  const queue = items.slice();
  const workers = Array(Math.min(n, queue.length))
    .fill(0)
    .map(async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await fn(item);
        } catch (e) {
          stats.errors++;
          console.log(`  unhandled: ${e.message}`);
        }
      }
    });
  await Promise.all(workers);
}

const start = Date.now();
await runPool(cases, concurrency, processOne);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);

console.log("\n=== Done ===");
console.log(`Apply:              ${apply}`);
console.log(`Elapsed:            ${elapsed}s`);
console.log(`Scanned:            ${stats.scanned}`);
console.log(`Detail-fetch fail:  ${stats.detailFailed}`);
console.log(`Still in process:   ${stats.stillInProcess}`);
console.log(`Already OK (kept):  ${stats.alreadyOk}`);
console.log(`Protected real PDF: ${stats.protectedRealPdf}`);
console.log(`Blank deleted:      ${stats.deletedBlank}${apply ? "" : " (would)"}`);
console.log(`Downloaded:         ${stats.downloaded}${apply ? "" : " (would)"}`);
console.log(
  `Marked unavailable: ${stats.markedUnavailable}   (HealthRay: "No Report Found" — won't be retried)`,
);
console.log(
  `Transient failures: ${stats.downloadFailed}   (nav timeout / render stuck — re-run later may succeed)`,
);
console.log(`Errors:             ${stats.errors}`);

await pool.end();
process.exit(0);
