import pg from "pg";

const dbUrl =
  "postgresql://postgres.vuukipgdegewpwucdgxa:!Jiyo100saal@aws-1-ap-south-1.pooler.supabase.com:6543/postgres";
const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

const FILE_NO = "P_175721";
const TARGET_DATE = "2026-05-21";

async function listTables() {
  const res = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema='public'
    ORDER BY table_name
  `);
  return res.rows.map((r) => r.table_name);
}

async function colsOf(table) {
  const res = await pool.query(
    `SELECT column_name, data_type
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return res.rows;
}

async function main() {
  const patRes = await pool.query(
    `SELECT * FROM patients WHERE file_no=$1`,
    [FILE_NO],
  );
  if (!patRes.rows[0]) {
    console.log(`❌ Patient ${FILE_NO} not found`);
    await pool.end();
    return;
  }
  const patient = patRes.rows[0];
  console.log("✅ Patient:", patient.name, "| id:", patient.id, "| phone:", patient.phone);
  console.log();

  const tables = await listTables();
  const candidates = [];
  for (const t of tables) {
    const cols = await colsOf(t);
    const colNames = cols.map((c) => c.column_name);
    const hasPatient = colNames.includes("patient_id");
    const dateCols = cols.filter(
      (c) =>
        ["date", "timestamp", "timestamp with time zone", "timestamp without time zone"].includes(
          c.data_type,
        ) ||
        /(_at|_date|_on|date)$/i.test(c.column_name),
    );
    if (hasPatient && dateCols.length) {
      candidates.push({ table: t, dateCols: dateCols.map((c) => c.column_name) });
    }
  }

  for (const { table, dateCols } of candidates) {
    for (const dc of dateCols) {
      try {
        const q = `SELECT * FROM "${table}" WHERE patient_id=$1 AND "${dc}"::date = $2::date`;
        const r = await pool.query(q, [patient.id, TARGET_DATE]);
        if (r.rows.length > 0) {
          console.log(`\n=== ${table} (by ${dc}) — ${r.rows.length} row(s) ===`);
          r.rows.forEach((row, i) => {
            console.log(`\n[${i + 1}]`, JSON.stringify(row, null, 2));
          });
        }
      } catch (e) {
        // skip columns that can't cast
      }
    }
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
