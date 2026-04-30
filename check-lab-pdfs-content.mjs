// READ-ONLY: download each lab PDF (Apr 26-30) from Supabase storage and
// classify by size + extracted text content. No mutations.
import "dotenv/config";
import pg from "pg";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing DATABASE_URL / SUPABASE_URL / SUPABASE_SERVICE_KEY");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "labpdfs-"));

const { rows } = await pool.query(
  `SELECT p.file_no, p.name, lc.case_no,
          lc.case_date::date AS case_date,
          lc.pdf_storage_path
     FROM lab_cases lc
     JOIN patients p ON p.id = lc.patient_id
    WHERE lc.case_date::date BETWEEN DATE '2026-04-26' AND DATE '2026-04-30'
    ORDER BY lc.case_date DESC, p.file_no, lc.case_no`,
);

const buckets = { HEALTHY: [], BLANK: [], CORRUPT: [], MISSING: [], DOWNLOAD_FAIL: [] };

async function downloadAndCheck(row) {
  if (!row.pdf_storage_path) {
    buckets.MISSING.push({ ...row, reason: "no pdf_storage_path" });
    return;
  }
  const local = path.join(tmp, `${row.case_no}.pdf`);
  try {
    const url = `${SUPABASE_URL}/storage/v1/object/patient-files/${row.pdf_storage_path}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!res.ok) {
      buckets.DOWNLOAD_FAIL.push({ ...row, reason: `HTTP ${res.status}` });
      return;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(local, buf);
    const head = buf.subarray(0, 5).toString("ascii");
    const tail = buf.subarray(-1024).toString("ascii");
    const okHead = head === "%PDF-";
    const okEOF = tail.includes("%%EOF");
    if (!okHead || !okEOF) {
      buckets.CORRUPT.push({ ...row, size: buf.length, head, hasEOF: okEOF });
      return;
    }
    let text = "";
    let pages = 0;
    try {
      text = execSync(`pdftotext -q -nopgbrk "${local}" -`, { timeout: 8000 }).toString();
    } catch {}
    try {
      const info = execSync(`pdfinfo "${local}"`, { timeout: 8000 }).toString();
      const m = info.match(/Pages:\s+(\d+)/);
      if (m) pages = parseInt(m[1], 10);
    } catch {}
    const trimmed = text.trim();
    const len = trimmed.length;
    // Classify: a blank/header-only PDF typically has only clinic boilerplate
    // and no test result rows. Use loose heuristics:
    //   - very short text (< 200 chars), OR
    //   - no occurrence of common lab tokens (RESULT/UNIT/REFERENCE/TEST)
    const hasLabTokens = /(\bRESULT\b|\bUNIT\b|\bREFERENCE\b|\bREF\.?\s*RANGE\b)/i.test(trimmed);
    if (len < 200 || !hasLabTokens || buf.length < 15000) {
      buckets.BLANK.push({
        ...row,
        size: buf.length,
        textLen: len,
        pages,
        hasLabTokens,
        snippet: trimmed.slice(0, 120).replace(/\s+/g, " "),
      });
    } else {
      buckets.HEALTHY.push({
        ...row,
        size: buf.length,
        textLen: len,
        pages,
      });
    }
  } catch (e) {
    buckets.DOWNLOAD_FAIL.push({ ...row, reason: e.message });
  } finally {
    try {
      fs.unlinkSync(local);
    } catch {}
  }
}

// Concurrency limited
const BATCH = 6;
for (let i = 0; i < rows.length; i += BATCH) {
  const chunk = rows.slice(i, i + BATCH);
  await Promise.all(chunk.map(downloadAndCheck));
  process.stdout.write(`\rChecked ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
}
process.stdout.write("\n\n");

function summarize(name, arr) {
  console.log(`=== ${name} (${arr.length}) ===`);
  for (const r of arr.slice(0, 200)) {
    const d = (r.case_date instanceof Date ? r.case_date.toISOString().slice(0, 10) : r.case_date);
    if (name === "HEALTHY") {
      console.log(`  ${r.file_no} ${r.case_no} ${d} size=${r.size} pages=${r.pages} txt=${r.textLen}`);
    } else if (name === "BLANK") {
      console.log(
        `  ${r.file_no} ${r.case_no} ${d} size=${r.size} pages=${r.pages} txt=${r.textLen} tokens=${r.hasLabTokens} :: ${r.snippet}`,
      );
    } else if (name === "CORRUPT") {
      console.log(`  ${r.file_no} ${r.case_no} ${d} size=${r.size} head='${r.head}' hasEOF=${r.hasEOF}`);
    } else if (name === "MISSING") {
      console.log(`  ${r.file_no} ${r.case_no} ${d} :: ${r.reason}`);
    } else {
      console.log(`  ${r.file_no} ${r.case_no} ${d} :: ${r.reason}`);
    }
  }
  console.log("");
}

console.log(`Total cases checked: ${rows.length}`);
console.log(
  `HEALTHY=${buckets.HEALTHY.length} BLANK=${buckets.BLANK.length} CORRUPT=${buckets.CORRUPT.length} MISSING=${buckets.MISSING.length} DOWNLOAD_FAIL=${buckets.DOWNLOAD_FAIL.length}\n`,
);
summarize("BLANK", buckets.BLANK);
summarize("CORRUPT", buckets.CORRUPT);
summarize("MISSING", buckets.MISSING);
summarize("DOWNLOAD_FAIL", buckets.DOWNLOAD_FAIL);
summarize("HEALTHY", buckets.HEALTHY);

await pool.end();
fs.rmSync(tmp, { recursive: true, force: true });
