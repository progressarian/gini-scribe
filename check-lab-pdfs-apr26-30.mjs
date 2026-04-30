// READ-ONLY diagnostic: enumerate lab_cases with case_date in Apr 26-30, 2026
// and report patient/case/PDF status. No writes.
import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set in env");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 2 });

const { rows } = await pool.query(
  `SELECT p.file_no, p.name, lc.case_no,
          lc.case_date::date AS date,
          lc.pdf_storage_path,
          lc.results_synced,
          COALESCE(lc.retry_abandoned, false) AS retry_abandoned
     FROM lab_cases lc
     JOIN patients p ON p.id = lc.patient_id
    WHERE lc.case_date::date BETWEEN DATE '2026-04-26' AND DATE '2026-04-30'
    ORDER BY lc.case_date DESC, p.file_no, lc.case_no`,
);

const byPatient = new Map();
for (const r of rows) {
  if (!byPatient.has(r.file_no)) byPatient.set(r.file_no, { name: r.name, cases: [] });
  byPatient.get(r.file_no).cases.push({
    case_no: r.case_no,
    date: r.date,
    has_pdf: !!r.pdf_storage_path,
    pdf_path: r.pdf_storage_path,
    results_synced: r.results_synced,
    retry_abandoned: r.retry_abandoned,
  });
}

console.log(`unique patients: ${byPatient.size}`);
console.log(`total cases: ${rows.length}`);
console.log("");
for (const [fn, v] of byPatient) {
  console.log(`${fn} ${v.name}`);
  for (const c of v.cases) {
    console.log(
      `  case=${c.case_no} date=${c.date} pdf=${c.has_pdf ? "Y" : "N"} synced=${c.results_synced} abandoned=${c.retry_abandoned} path=${c.pdf_path || "(null)"}`,
    );
  }
}

await pool.end();
