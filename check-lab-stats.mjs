// READ-ONLY: aggregate stats on lab_cases for TODAY only
import "dotenv/config";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 2 });

const today = process.argv[2] || new Date().toISOString().slice(0, 10);
console.log(`Filtering lab_cases where case_date = ${today}\n`);

const { rows: overall } = await pool.query(
  `
  SELECT
    COUNT(*)::int AS total_cases,
    COUNT(DISTINCT patient_id)::int AS patients_with_cases,
    COUNT(*) FILTER (WHERE results_synced = TRUE)::int AS cases_synced,
    COUNT(DISTINCT patient_id) FILTER (WHERE results_synced = TRUE)::int AS patients_with_synced,
    COUNT(*) FILTER (WHERE pdf_storage_path IS NOT NULL)::int AS cases_with_pdf,
    COUNT(DISTINCT patient_id) FILTER (WHERE pdf_storage_path IS NOT NULL)::int AS patients_with_pdf,
    COUNT(*) FILTER (WHERE pdf_unavailable = TRUE)::int AS cases_pdf_unavailable,
    COUNT(*) FILTER (WHERE results_synced = TRUE AND pdf_storage_path IS NULL AND COALESCE(pdf_unavailable,FALSE)=FALSE)::int AS synced_missing_pdf,
    COUNT(*) FILTER (WHERE results_synced = FALSE)::int AS cases_not_synced
  FROM lab_cases
  WHERE case_date::date = $1::date
`,
  [today],
);

console.log("=== Today's lab_cases (ginilab) stats ===");
console.table(overall[0]);

const { rows: bySource } = await pool.query(
  `
  SELECT COALESCE(case_source,'(null)') AS case_source,
         COUNT(*)::int AS cases,
         COUNT(DISTINCT patient_id)::int AS patients,
         COUNT(*) FILTER (WHERE results_synced = TRUE)::int AS synced,
         COUNT(*) FILTER (WHERE pdf_storage_path IS NOT NULL)::int AS with_pdf
    FROM lab_cases
   WHERE case_date::date = $1::date
   GROUP BY case_source
   ORDER BY cases DESC
`,
  [today],
);
console.log("\n=== By case_source (today) ===");
console.table(bySource);

await pool.end();
