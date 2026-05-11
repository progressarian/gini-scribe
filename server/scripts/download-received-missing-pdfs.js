/**
 * Download lab PDFs for cases whose status surfaces as "Gini Lab Received"
 * (results_synced = TRUE) but where pdf_storage_path is NULL — i.e. the
 * report parsed cleanly but the PDF never landed in storage, so the lab
 * section in the UI shows no downloadable file.
 *
 * Examples of how cases end up in this state:
 *   - PDF download attempts hit a transient failure and the case is now
 *     parked behind pdf_next_attempt_at (still backing off).
 *   - Case was marked pdf_unavailable=TRUE by the old gate (before the
 *     countAllInhouseResults fix) — HealthRay actually has the PDF now.
 *   - Patient happens to be P_76420 / G15169 / G15086 etc.
 *
 * Usage:
 *   # Dry run
 *   node server/scripts/download-received-missing-pdfs.js
 *
 *   # Apply: clears pdf_unavailable + pdf_next_attempt_at, then downloads
 *   node server/scripts/download-received-missing-pdfs.js --apply
 *
 *   # Single patient (file_no)
 *   node server/scripts/download-received-missing-pdfs.js --apply --file-no=P_76420
 *
 *   # Single case
 *   node server/scripts/download-received-missing-pdfs.js --apply --case-no=15169
 *
 *   # Concurrency for the cheap detail-fetch loop (PDF render is throttled
 *   # separately by LAB_PUPPETEER_CONCURRENCY)
 *   node server/scripts/download-received-missing-pdfs.js --apply --concurrency=8
 */

import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { downloadAndStoreLabPdf, ensureLabCasesTable } = await import("../services/lab/db.js");
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = await import("../config/storage.js");

await ensureLabCasesTable();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const fileNoArg = args.find((a) => a.startsWith("--file-no="))?.split("=")[1] || null;
const caseNoArg = args.find((a) => a.startsWith("--case-no="))?.split("=")[1] || null;
const concurrency =
  parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1], 10) || 6;

console.log(
  `Download received-but-missing lab PDFs — apply=${apply}, file_no=${fileNoArg || "all"}, case_no=${caseNoArg || "all"}, concurrency=${concurrency}`,
);

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY — cannot proceed");
  process.exit(1);
}

const params = [];
let where =
  "lc.patient_id IS NOT NULL AND lc.results_synced = TRUE AND lc.pdf_storage_path IS NULL " +
  "AND COALESCE(lc.retry_abandoned, FALSE) = FALSE";

if (fileNoArg) {
  params.push(fileNoArg);
  where += ` AND lc.patient_id = (SELECT id FROM patients WHERE file_no = $${params.length})`;
}
if (caseNoArg) {
  params.push(caseNoArg);
  where += ` AND lc.case_no = $${params.length}`;
}

const { rows: cases } = await pool.query(
  `SELECT lc.case_no, lc.patient_case_no, lc.patient_id, lc.case_uid, lc.lab_case_id,
          lc.lab_user_id, lc.pdf_file_name, lc.case_date, lc.case_status,
          lc.pdf_unavailable, lc.pdf_next_attempt_at, lc.pdf_attempt_count,
          p.file_no
     FROM lab_cases lc
     JOIN patients p ON p.id = lc.patient_id
    WHERE ${where}
    ORDER BY lc.case_date DESC`,
  params,
);

console.log(`Found ${cases.length} candidate cases (status=received, no PDF stored)`);
if (cases.length === 0) {
  await pool.end();
  process.exit(0);
}

const stats = {
  scanned: 0,
  clearedUnavailable: 0,
  clearedRetryDelay: 0,
  downloaded: 0,
  markedUnavailable: 0,
  downloadFailed: 0,
  errors: 0,
};

async function unblockCase(row) {
  // Clear flags that would short-circuit downloadAndStoreLabPdf:
  //   pdf_unavailable=TRUE (set by old gate / "No Report Found")
  //   pdf_next_attempt_at in the future (backoff window not elapsed yet)
  // We deliberately do NOT zero pdf_attempt_count — keep history.
  const updates = [];
  if (row.pdf_unavailable) {
    updates.push("pdf_unavailable = FALSE");
    stats.clearedUnavailable++;
  }
  if (row.pdf_next_attempt_at && new Date(row.pdf_next_attempt_at) > new Date()) {
    updates.push("pdf_next_attempt_at = NULL");
    stats.clearedRetryDelay++;
  }
  if (updates.length === 0) return;
  await pool.query(`UPDATE lab_cases SET ${updates.join(", ")} WHERE case_no = $1`, [row.case_no]);
}

function caseDateStr(row) {
  return row.case_date
    ? typeof row.case_date === "string"
      ? row.case_date.slice(0, 10)
      : row.case_date.toISOString().slice(0, 10)
    : null;
}

async function processOne(row) {
  stats.scanned++;
  const tag = `${row.file_no}/${row.patient_case_no || row.case_no}`;

  if (!apply) {
    const reasons = [];
    if (row.pdf_unavailable) reasons.push("pdf_unavailable=TRUE");
    if (row.pdf_next_attempt_at && new Date(row.pdf_next_attempt_at) > new Date())
      reasons.push(`backoff until ${row.pdf_next_attempt_at}`);
    console.log(
      `  ${tag}: would download${reasons.length ? ` (clear: ${reasons.join(", ")})` : ""}`,
    );
    return;
  }

  try {
    await unblockCase(row);
  } catch (e) {
    stats.errors++;
    console.log(`  ${tag}: unblock-failed (${e.message})`);
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
      null, // let downloadAndStoreLabPdf fetch live detail (gates correctly)
    );
    if (path) {
      stats.downloaded++;
      console.log(`  ${tag}: downloaded → ${path}`);
      return;
    }
    const { rows: cur } = await pool.query(
      `SELECT pdf_unavailable, pdf_next_attempt_at FROM lab_cases WHERE case_no = $1`,
      [row.case_no],
    );
    if (cur[0]?.pdf_unavailable) {
      stats.markedUnavailable++;
      console.log(`  ${tag}: HealthRay confirms no report — marked unavailable`);
    } else {
      stats.downloadFailed++;
      const next = cur[0]?.pdf_next_attempt_at ? ` (next retry ${cur[0].pdf_next_attempt_at})` : "";
      console.log(`  ${tag}: download failed — transient${next}`);
    }
  } catch (e) {
    stats.downloadFailed++;
    console.log(`  ${tag}: download-error (${e.message})`);
  }
}

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
console.log(`Cleared unavailable:${stats.clearedUnavailable}`);
console.log(`Cleared backoff:    ${stats.clearedRetryDelay}`);
console.log(`Downloaded:         ${stats.downloaded}${apply ? "" : " (would)"}`);
console.log(`Re-marked unavail.: ${stats.markedUnavailable}   (HealthRay confirmed: no report)`);
console.log(`Transient failures: ${stats.downloadFailed}   (will be retried by cron)`);
console.log(`Errors:             ${stats.errors}`);

await pool.end();
process.exit(0);
