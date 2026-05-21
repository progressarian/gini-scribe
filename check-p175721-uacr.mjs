import pg from "pg";

const dbUrl =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

const PATIENT_ID = 3442;

async function main() {
  // 1) All UACR-related lab_results rows
  const labs = await pool.query(
    `SELECT *
     FROM lab_results
     WHERE patient_id = $1
       AND (canonical_name ILIKE '%UACR%'
            OR test_name ILIKE '%uacr%'
            OR test_name ILIKE '%albumin%creatinine%'
            OR test_name ILIKE '%urine%albumin%')
     ORDER BY test_date DESC NULLS LAST`,
    [PATIENT_ID],
  );

  console.log(`\n=== lab_results UACR rows for patient ${PATIENT_ID}: ${labs.rows.length} ===\n`);
  for (const r of labs.rows) {
    console.log(JSON.stringify(r, null, 2));
    console.log("---");
  }

  // 2) Look up the source document/report (if present)
  const docIds = [...new Set(labs.rows.map((r) => r.document_id).filter(Boolean))];
  const reportIds = [...new Set(labs.rows.map((r) => r.report_id).filter(Boolean))];

  // Print column names for reference
  if (labs.rows[0]) {
    console.log("lab_results columns:", Object.keys(labs.rows[0]).join(", "));
  }

  if (docIds.length) {
    const docs = await pool.query(
      `SELECT id, patient_id, file_name, doc_type, source, notes, created_at, uploaded_at
       FROM documents WHERE id = ANY($1::int[])`,
      [docIds],
    );
    console.log(`\n=== source documents (${docs.rows.length}) ===`);
    docs.rows.forEach((d) => console.log(JSON.stringify(d, null, 2)));
  }

  if (reportIds.length) {
    // Try a 'lab_reports' or 'reports' table — attempt both
    for (const table of ["lab_reports", "reports"]) {
      try {
        const rep = await pool.query(
          `SELECT * FROM "${table}" WHERE id = ANY($1::int[])`,
          [reportIds],
        );
        console.log(`\n=== ${table} (${rep.rows.length}) ===`);
        rep.rows.forEach((r) => console.log(JSON.stringify(r, null, 2)));
      } catch (e) {
        // table may not exist
      }
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
