/**
 * Clear stored "In Process" placeholder lab PDFs so the existing PDF-retry
 * cron (runPdfRetryRecovery in services/cron/labSync.js) re-downloads the
 * real reports.
 *
 * Detection: bytes < 61_000 AND total Tj/TJ ops < 60 after stream inflate.
 * Same gate as `looksLikeBlankLabPdf` in services/lab/db.js so behaviour
 * matches the new auto-sync rejection.
 *
 * For each detected blank:
 *   1. DELETE the object from Supabase Storage
 *   2. DELETE the documents row (source='lab_healthray', notes='lab_case:<n>')
 *   3. UPDATE lab_cases: clear pdf_storage_path + retry counters so the
 *      next PDF-retry tick attempts the case immediately
 *
 * Usage:
 *   # Dry run (default) — shows what would be cleared
 *   node server/scripts/clear-blank-lab-pdfs.js
 *
 *   # Apply
 *   node server/scripts/clear-blank-lab-pdfs.js --apply
 *
 *   # Limit to a specific date or recent N days
 *   node server/scripts/clear-blank-lab-pdfs.js --date=2026-05-07 --apply
 *   node server/scripts/clear-blank-lab-pdfs.js --days=2 --apply
 *
 *   # Single patient
 *   node server/scripts/clear-blank-lab-pdfs.js --file-no=P_176276 --apply
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { inflateSync } from "zlib";
const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } = await import("../config/storage.js");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const arg = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const DATE = arg("date") || null;
const DAYS = parseInt(arg("days") || "0", 10);
const FILE_NO = arg("file-no") || null;

let where = "lc.pdf_storage_path IS NOT NULL";
const params = [];
if (FILE_NO) {
  params.push(FILE_NO);
  where += ` AND p.file_no = $${params.length}`;
} else if (DATE) {
  params.push(DATE);
  where += ` AND lc.case_date::date = $${params.length}::date`;
} else if (DAYS > 0) {
  params.push(DAYS - 1);
  where += ` AND lc.case_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date - ($${params.length} || ' days')::interval`;
}

console.log(
  `clear-blank-lab-pdfs: apply=${apply}, file_no=${FILE_NO || "-"}, date=${DATE || "-"}, days=${DAYS || "all"}`,
);

const { rows } = await pool.query(
  `SELECT lc.case_no, lc.case_date, lc.pdf_storage_path, p.file_no, lc.patient_id
     FROM lab_cases lc LEFT JOIN patients p ON p.id = lc.patient_id
    WHERE ${where}
    ORDER BY lc.case_date DESC, lc.case_no`,
  params,
);
console.log(`scanning ${rows.length} stored lab PDFs\n`);

function looksLikeBlankLabPdf(buffer) {
  if (buffer.length >= 61_000) return false;
  const ascii = buffer.toString("latin1");
  let cursor = 0,
    totalTj = 0;
  while (true) {
    const sStart = ascii.indexOf("stream\n", cursor);
    if (sStart < 0) break;
    const dataStart = sStart + "stream\n".length;
    const sEnd = ascii.indexOf("\nendstream", dataStart);
    if (sEnd < 0) break;
    let decoded = buffer.subarray(dataStart, sEnd);
    try {
      decoded = inflateSync(decoded);
    } catch {}
    const text = decoded.toString("latin1");
    totalTj += (text.match(/\bTj\b/g) || []).length + (text.match(/\bTJ\b/g) || []).length;
    if (totalTj >= 60) return false;
    cursor = sEnd;
  }
  return totalTj < 60;
}

async function fetchBytes(path) {
  const sign = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn: 60 }),
  });
  if (!sign.ok) return null;
  const sj = await sign.json();
  const url = (sj.signedURL || sj.signedUrl).startsWith("http")
    ? sj.signedURL || sj.signedUrl
    : `${SUPABASE_URL}/storage/v1${sj.signedURL || sj.signedUrl}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
}

async function deleteObject(path) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  return r.ok;
}

const blanks = [];
for (const r of rows) {
  const buf = await fetchBytes(r.pdf_storage_path);
  if (!buf) {
    console.log(`  [skip ] ${r.file_no || "?"} case=${r.case_no} — fetch failed`);
    continue;
  }
  if (!looksLikeBlankLabPdf(buf)) continue;
  blanks.push(r);
  console.log(
    `  [BLANK] ${r.file_no || "?"} case=${r.case_no} ${r.case_date?.toISOString?.().slice(0, 10) || r.case_date} bytes=${buf.length}`,
  );
}

console.log(`\n${blanks.length} blanks detected (of ${rows.length} scanned)`);

if (!apply) {
  console.log("dry-run — pass --apply to clear");
  await pool.end();
  process.exit(0);
}

let cleared = 0,
  errors = 0;
for (const r of blanks) {
  try {
    await deleteObject(r.pdf_storage_path);
    await pool.query(
      `DELETE FROM documents WHERE patient_id = $1 AND source = 'lab_healthray' AND notes = $2`,
      [r.patient_id, `lab_case:${r.case_no}`],
    );
    await pool.query(
      `UPDATE lab_cases
          SET pdf_storage_path     = NULL,
              pdf_unavailable      = FALSE,
              pdf_attempt_count    = 0,
              pdf_first_attempt_at = NULL,
              pdf_last_attempt_at  = NULL,
              pdf_next_attempt_at  = NULL
        WHERE case_no = $1`,
      [r.case_no],
    );
    cleared++;
    console.log(`  cleared case=${r.case_no} (${r.file_no})`);
  } catch (e) {
    errors++;
    console.log(`  error case=${r.case_no}: ${e.message}`);
  }
}

console.log(`\ncleared=${cleared} errors=${errors}`);
console.log(`Next PDF-retry cron tick will attempt to download the real reports.`);
await pool.end();
