// Import-only phase. The wipe step (NULL pdf_storage_path for blank cases)
// is assumed already done. Re-runs `/api/sync/lab/import-pdf?file_no=…`
// per patient sequentially with timeouts and small pauses to keep the
// Puppeteer instance from being overwhelmed.
import "dotenv/config";
import pg from "pg";

const { DATABASE_URL } = process.env;
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

const { rows } = await pool.query(
  `SELECT DISTINCT p.file_no
     FROM lab_cases lc
     JOIN patients p ON p.id = lc.patient_id
    WHERE lc.case_date::date BETWEEN DATE '2026-04-26' AND DATE '2026-04-30'
      AND lc.pdf_storage_path IS NULL
    ORDER BY p.file_no`,
);

const fileNos = rows.map((r) => r.file_no);
console.log(`patients pending re-import: ${fileNos.length}\n`);

let totalDl = 0,
  totalSk = 0,
  totalEr = 0,
  patientErr = 0;

for (let i = 0; i < fileNos.length; i++) {
  const fn = fileNos[i];
  process.stdout.write(`[${i + 1}/${fileNos.length}] ${fn} ... `);
  try {
    const r = await fetch(
      `http://localhost:3001/api/sync/lab/import-pdf?file_no=${encodeURIComponent(fn)}`,
      { method: "POST", signal: AbortSignal.timeout(300000) }, // 5 min/patient
    );
    if (!r.ok) {
      console.log(`HTTP ${r.status}`);
      patientErr++;
    } else {
      const j = await r.json().catch(() => ({}));
      const cs = j.cases || [];
      const dl = cs.filter((x) => x.status === "downloaded").length;
      const sk = cs.filter((x) => x.status === "skipped").length;
      const er = cs.filter((x) => x.status === "error").length;
      totalDl += dl;
      totalSk += sk;
      totalEr += er;
      console.log(`dl=${dl} sk=${sk} er=${er}`);
    }
  } catch (e) {
    console.log(`FAIL ${e.name}: ${e.message}`);
    patientErr++;
  }
  // brief pause to give Puppeteer's singleton browser a moment
  await new Promise((r) => setTimeout(r, 500));
}

console.log(
  `\nTOTAL  downloaded=${totalDl}  skipped=${totalSk}  per-case-errors=${totalEr}  patient-failures=${patientErr}`,
);

await pool.end();
