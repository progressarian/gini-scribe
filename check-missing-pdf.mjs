import "dotenv/config";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const today = process.argv[2] || new Date().toISOString().slice(0, 10);
const { rows } = await pool.query(
  `
  SELECT p.id AS patient_id, p.file_no, p.name,
         lc.case_no, lc.case_status, lc.pdf_file_name,
         lc.results_synced, lc.pdf_unavailable, lc.retry_abandoned,
         lc.pdf_attempt_count,
         lc.pdf_first_attempt_at, lc.pdf_last_attempt_at, lc.pdf_next_attempt_at,
         lc.synced_at
    FROM lab_cases lc
    JOIN patients p ON p.id = lc.patient_id
   WHERE lc.case_date::date = $1::date
     AND lc.results_synced = TRUE
     AND lc.pdf_storage_path IS NULL
   ORDER BY p.id, lc.case_no
`,
  [today],
);
console.log(`Cases synced today but missing PDF: ${rows.length}\n`);
const now = new Date();
for (const r of rows) {
  const next = r.pdf_next_attempt_at ? new Date(r.pdf_next_attempt_at) : null;
  const inMin = next ? Math.round((next - now) / 60000) : null;
  console.log(
    [
      `pt=${r.patient_id} ${r.file_no} ${r.name}`,
      `case=${r.case_no}`,
      `status=${r.case_status || "-"}`,
      `pdf_name=${r.pdf_file_name || "(none)"}`,
      `attempts=${r.pdf_attempt_count ?? 0}`,
      `first=${r.pdf_first_attempt_at ? new Date(r.pdf_first_attempt_at).toISOString() : "-"}`,
      `last=${r.pdf_last_attempt_at ? new Date(r.pdf_last_attempt_at).toISOString() : "-"}`,
      `next=${next ? next.toISOString() : "-"}${inMin !== null ? ` (${inMin >= 0 ? "in " : ""}${inMin}m)` : ""}`,
      `unavailable=${r.pdf_unavailable}`,
      `abandoned=${r.retry_abandoned}`,
    ].join(" | "),
  );
}

console.log("\n=== Summary of reasons ===");
const noFileName = rows.filter((r) => !r.pdf_file_name).length;
const noAttemptYet = rows.filter((r) => !r.pdf_first_attempt_at).length;
const scheduledFuture = rows.filter(
  (r) => r.pdf_next_attempt_at && new Date(r.pdf_next_attempt_at) > now,
).length;
const overdue = rows.filter(
  (r) => r.pdf_next_attempt_at && new Date(r.pdf_next_attempt_at) <= now,
).length;
console.log(`  no pdf_file_name on case      : ${noFileName}`);
console.log(`  never attempted               : ${noAttemptYet}`);
console.log(`  retry scheduled in the future : ${scheduledFuture}`);
console.log(`  retry overdue (should run)    : ${overdue}`);

await pool.end();
