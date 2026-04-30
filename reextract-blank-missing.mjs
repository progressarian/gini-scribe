// Re-extract lab PDFs for cases (Apr 26-30) that are currently BLANK or MISSING.
// Strategy:
//   1) For each BLANK case (already classified), NULL its pdf_storage_path
//      and delete its documents row — per-case granular, leaves other cases alone.
//   2) Group remaining (now-null) cases by patient, call existing
//      POST /api/sync/lab/import-pdf?file_no=<file_no>. The endpoint iterates
//      every lab_case for the patient with pdf_storage_path IS NULL and runs
//      it through fetchLabReportPdf (now using the size-stabilization wait).
//   3) Print per-patient results.
//
// READ + targeted UPDATE/DELETE only on cases we explicitly identified as bad.
import "dotenv/config";
import pg from "pg";
import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const { DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("missing envs");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "labpdfs-"));

// ── Step 1: re-classify current state to find BLANK + MISSING case_nos ───
const { rows: cases } = await pool.query(
  `SELECT p.file_no, p.id AS pid, p.name, lc.case_no, lc.pdf_storage_path
     FROM lab_cases lc
     JOIN patients p ON p.id = lc.patient_id
    WHERE lc.case_date::date BETWEEN DATE '2026-04-26' AND DATE '2026-04-30'
    ORDER BY p.file_no, lc.case_no`,
);

const blankCases = []; // need to wipe + re-fetch
const missingCases = []; // pdf_storage_path already null — just need re-fetch

async function isBlank(storagePath) {
  if (!storagePath) return false;
  try {
    const url = `${SUPABASE_URL}/storage/v1/object/patient-files/${storagePath}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length >= 15000 && buf.length < 200000) {
      // size in skeleton range — verify content emptiness
      const local = path.join(tmp, "test.pdf");
      fs.writeFileSync(local, buf);
      let text = "";
      try {
        text = execSync(`pdftotext -q -nopgbrk "${local}" -`, { timeout: 8000 }).toString();
      } catch {}
      fs.unlinkSync(local);
      const trimmed = text.trim();
      const hasLabTokens = /(\bRESULT\b|\bUNIT\b|\bREFERENCE\b|\bREF\.?\s*RANGE\b)/i.test(trimmed);
      if (trimmed.length < 200 || !hasLabTokens) return true;
    } else if (buf.length < 15000) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const BATCH = 8;
for (let i = 0; i < cases.length; i += BATCH) {
  const chunk = cases.slice(i, i + BATCH);
  await Promise.all(
    chunk.map(async (c) => {
      if (!c.pdf_storage_path) {
        missingCases.push(c);
      } else if (await isBlank(c.pdf_storage_path)) {
        blankCases.push(c);
      }
    }),
  );
  process.stdout.write(`\rclassify ${Math.min(i + BATCH, cases.length)}/${cases.length}`);
}
process.stdout.write("\n");
console.log(`BLANK=${blankCases.length}  MISSING=${missingCases.length}`);

// ── Step 2: NULL out blank cases (per-case, scoped to our identified set) ──
for (const c of blankCases) {
  await pool.query(`UPDATE lab_cases SET pdf_storage_path = NULL WHERE case_no = $1`, [c.case_no]);
  await pool.query(
    `DELETE FROM documents WHERE patient_id = $1 AND doc_type='lab_report' AND notes = $2`,
    [c.pid, `lab_case:${c.case_no}`],
  );
}
console.log(`cleared ${blankCases.length} blank PDF references`);

// ── Step 3: import-pdf per unique patient ───────────────────────────────
const fileNos = [...new Set([...blankCases, ...missingCases].map((c) => c.file_no))];
console.log(`re-importing for ${fileNos.length} patients...\n`);

const results = [];
for (let i = 0; i < fileNos.length; i++) {
  const fn = fileNos[i];
  process.stdout.write(`[${i + 1}/${fileNos.length}] ${fn} ... `);
  try {
    const r = await fetch(
      `http://localhost:3001/api/sync/lab/import-pdf?file_no=${encodeURIComponent(fn)}`,
      { method: "POST", signal: AbortSignal.timeout(900000) },
    );
    const j = await r.json().catch(() => ({}));
    const cs = j.cases || [];
    const dl = cs.filter((x) => x.status === "downloaded").length;
    const sk = cs.filter((x) => x.status === "skipped").length;
    const er = cs.filter((x) => x.status === "error").length;
    console.log(`downloaded=${dl} skipped=${sk} errors=${er}`);
    results.push({ fn, dl, sk, er, cs });
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    results.push({ fn, error: e.message });
  }
}

console.log("\n=== per-patient summary ===");
let totalDl = 0, totalSk = 0, totalEr = 0;
for (const r of results) {
  if (r.error) console.log(`  ${r.fn}  ERROR  ${r.error}`);
  else {
    totalDl += r.dl;
    totalSk += r.sk;
    totalEr += r.er;
    console.log(`  ${r.fn}  dl=${r.dl} sk=${r.sk} er=${r.er}`);
  }
}
console.log(`\nTOTAL  downloaded=${totalDl}  skipped=${totalSk}  errors=${totalEr}`);

await pool.end();
fs.rmSync(tmp, { recursive: true, force: true });
