#!/usr/bin/env node
// Pre/post-migration check for 2026-05-01_dedup_consultations.sql.
//
// Usage:
//   DATABASE_URL=postgresql://... node server/scripts/verify_consult_dedup.mjs [patientId]
//
// Reports:
//   - total consultations vs unique (patient_id, visit_date::date, doctor_key)
//   - per-patient duplicate count
//   - if patientId given, the rows that would be collapsed
//
// Run BEFORE the migration to see the cleanup plan.
// Run AFTER the migration to confirm zero dups remain (and the unique index
// is in place).

import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL required");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

const focusPatient = process.argv[2] ? Number(process.argv[2]) : null;

const totalQ = `
  SELECT COUNT(*)::int AS total,
    COUNT(DISTINCT (
      patient_id,
      visit_date::date,
      COALESCE(
        con_doctor_id::text,
        mo_doctor_id::text,
        lower(regexp_replace(regexp_replace(coalesce(con_name, mo_name, ''), '^\\s*dr\\.?\\s*', '', 'i'), '.*\\s+', '')),
        ''
      )
    ))::int AS unique_groups
  FROM consultations
`;

const dupGroupsQ = `
  WITH g AS (
    SELECT patient_id, visit_date::date AS day,
      COALESCE(
        con_doctor_id::text,
        mo_doctor_id::text,
        lower(regexp_replace(regexp_replace(coalesce(con_name, mo_name, ''), '^\\s*dr\\.?\\s*', '', 'i'), '.*\\s+', '')),
        ''
      ) AS doc,
      COUNT(*) AS n
    FROM consultations
    GROUP BY 1, 2, 3
    HAVING COUNT(*) > 1
  )
  SELECT patient_id, COUNT(*)::int AS dup_groups, SUM(n - 1)::int AS rows_to_drop
  FROM g GROUP BY 1 ORDER BY rows_to_drop DESC LIMIT 20
`;

const focusQ = `
  SELECT id, visit_date, visit_type, status, con_name, mo_name, con_doctor_id, mo_doctor_id, created_at,
    COALESCE(length(mo_data::text), 0)
      + COALESCE(length(con_data::text), 0)
      + COALESCE(length(mo_transcript), 0)
      + COALESCE(length(con_transcript), 0) AS content_score
  FROM consultations
  WHERE patient_id = $1
  ORDER BY visit_date DESC, created_at DESC
`;

const indexQ = `
  SELECT indexname FROM pg_indexes
  WHERE tablename = 'consultations'
    AND indexname = 'uq_consultations_one_per_doctor_per_day'
`;

const t = await pool.query(totalQ);
console.log(
  `[totals] ${t.rows[0].total} rows in ${t.rows[0].unique_groups} unique (patient, date, doctor) groups → ${t.rows[0].total - t.rows[0].unique_groups} duplicate rows`,
);

const idx = await pool.query(indexQ);
console.log(idx.rows[0] ? "[index] uq_consultations_one_per_doctor_per_day PRESENT (post-migration)" : "[index] not present yet (pre-migration)");

const groups = await pool.query(dupGroupsQ);
console.log(`\n[top patients with dups] ${groups.rows.length} shown`);
for (const r of groups.rows) {
  console.log(`   patient_id=${r.patient_id}  groups=${r.dup_groups}  rows_to_drop=${r.rows_to_drop}`);
}

if (focusPatient) {
  console.log(`\n[detail] patient_id=${focusPatient}`);
  const f = await pool.query(focusQ, [focusPatient]);
  for (const r of f.rows) {
    console.log(
      `   id=${r.id}  ${String(r.visit_date).slice(0, 10)}  ${(r.visit_type || '').padEnd(12)} status=${(r.status || '').padEnd(12)} con="${r.con_name || ''}" mo="${r.mo_name || ''}" doctor_id=${r.con_doctor_id ?? r.mo_doctor_id ?? '-'} content=${r.content_score}`,
    );
  }
}

await pool.end();
