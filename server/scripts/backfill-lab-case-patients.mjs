import "../loadEnv.js";
import pool from "../config/db.js";

const dates = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const apply = process.argv.includes("--apply");

if (!dates.length) {
  console.error(
    "usage: node scripts/backfill-lab-case-patients.mjs <YYYY-MM-DD> [more dates] [--apply]",
  );
  process.exit(1);
}

const SELECT_MATCHES = `
  SELECT lc.case_no,
         lc.raw_list_json->'patient'->>'healthray_uid' AS uid,
         p.id   AS patient_id,
         p.name AS patient_name
    FROM lab_cases lc
    JOIN patients p ON p.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
   WHERE lc.case_date = $1::date
     AND lc.patient_id IS NULL
   ORDER BY lc.case_no`;

const run = async () => {
  for (const date of dates) {
    const total = await pool.query(
      "SELECT count(*)::int AS n FROM lab_cases WHERE case_date = $1::date AND patient_id IS NULL",
      [date],
    );
    const { rows } = await pool.query(SELECT_MATCHES, [date]);

    const byUid = new Map();
    for (const r of rows) byUid.set(r.case_no, (byUid.get(r.case_no) || 0) + 1);
    const ambiguous = rows.filter((r) => byUid.get(r.case_no) > 1);
    const clean = rows.filter((r) => byUid.get(r.case_no) === 1);

    console.log(
      `\n${date}: ${total.rows[0].n} unlinked case(s) — ${clean.length} match one patient, ` +
        `${ambiguous.length} ambiguous, ${total.rows[0].n - rows.length} no match`,
    );
    for (const r of clean.slice(0, 5)) {
      console.log(`  ${r.case_no} → ${r.uid} ${r.patient_name} (#${r.patient_id})`);
    }
    if (clean.length > 5) console.log(`  … ${clean.length - 5} more`);
    for (const r of ambiguous) {
      console.log(`  SKIP ${r.case_no} → ${r.uid} matches ${byUid.get(r.case_no)} patients`);
    }

    if (!apply) continue;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let n = 0;
      for (const r of clean) {
        const res = await client.query(
          "UPDATE lab_cases SET patient_id = $2 WHERE case_no = $1 AND patient_id IS NULL",
          [r.case_no, r.patient_id],
        );
        n += res.rowCount;
      }
      await client.query("COMMIT");
      console.log(`  applied: ${n} row(s) linked`);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`  FAILED, rolled back: ${e.message}`);
    } finally {
      client.release();
    }
  }
  await pool.end();
};

run();
