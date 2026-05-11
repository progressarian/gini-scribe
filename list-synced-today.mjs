import "dotenv/config";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const today = process.argv[2] || new Date().toISOString().slice(0, 10);
const { rows } = await pool.query(
  `
  SELECT p.id AS patient_id, p.file_no, p.name,
         COUNT(*)::int AS cases,
         COUNT(*) FILTER (WHERE lc.results_synced = TRUE)::int AS synced,
         COUNT(*) FILTER (WHERE lc.pdf_storage_path IS NOT NULL)::int AS with_pdf
    FROM lab_cases lc
    JOIN patients p ON p.id = lc.patient_id
   WHERE lc.case_date::date = $1::date
     AND lc.results_synced = TRUE
   GROUP BY p.id, p.file_no, p.name
   ORDER BY p.id
`,
  [today],
);
const withPdf = rows.filter((r) => r.with_pdf > 0);
const withoutPdf = rows.filter((r) => r.with_pdf === 0);

console.log(`Synced patients on ${today}: ${rows.length}`);
console.log(`  with PDF    : ${withPdf.length}`);
console.log(`  without PDF : ${withoutPdf.length}`);

console.log("\n=== Patients WITH lab PDF ===");
for (const r of withPdf)
  console.log(`[PDF]  ${r.patient_id}\t${r.file_no}\t${r.name}\t(pdf ${r.with_pdf}/${r.cases})`);

console.log("\n=== Patients WITHOUT lab PDF (synced but PDF missing) ===");
for (const r of withoutPdf)
  console.log(`[NONE] ${r.patient_id}\t${r.file_no}\t${r.name}\t(0/${r.cases})`);

await pool.end();
