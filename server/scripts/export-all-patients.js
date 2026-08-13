// Read-only export: EVERY patient in the DB, all-time, no date filter.
// Writes a CSV with demographic details + lifetime activity aggregates.
//
// Usage:
//   node server/scripts/export-all-patients.js [outfile.csv]
// Default outfile: exports/all-patients-<YYYY-MM-DD>.csv
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { mkdirSync, createWriteStream } from "fs";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", "..", ".env") });

const { default: pool } = await import("../config/db.js");

const COLUMNS = [
  "patient_id",
  "name",
  "file_no",
  "health_id",
  "abha_id",
  "phone",
  "email",
  "sex",
  "age",
  "dob",
  "blood_group",
  "address",
  "emergency_contact",
  "emergency_phone",
  "total_visits",
  "first_visit",
  "last_visit",
  "total_lab_results",
  "first_lab_date",
  "last_lab_date",
  "total_documents",
  "active_medications",
  "diagnoses",
  "created_at",
  "updated_at",
];

// All-time: no WHERE clause on any date anywhere. Aggregates are computed in
// per-table subqueries (not joins) so a patient with many labs is still one row.
const SQL = `
  SELECT
    p.id                AS patient_id,
    p.name,
    p.file_no,
    p.health_id,
    p.abha_id,
    p.phone,
    p.email,
    p.sex,
    p.age,
    p.dob,
    p.blood_group,
    p.address,
    p.emergency_contact,
    p.emergency_phone,
    COALESCE(c.n, 0)    AS total_visits,
    c.first_visit,
    c.last_visit,
    COALESCE(l.n, 0)    AS total_lab_results,
    l.first_lab_date,
    l.last_lab_date,
    COALESCE(d.n, 0)    AS total_documents,
    COALESCE(m.n, 0)    AS active_medications,
    dx.list             AS diagnoses,
    p.created_at,
    p.updated_at
  FROM patients p
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int n, MIN(visit_date) first_visit, MAX(visit_date) last_visit
      FROM consultations WHERE patient_id = p.id
  ) c ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int n, MIN(test_date) first_lab_date, MAX(test_date) last_lab_date
      FROM lab_results WHERE patient_id = p.id
  ) l ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int n FROM documents WHERE patient_id = p.id
  ) d ON TRUE
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int n FROM medications
     WHERE patient_id = p.id AND is_active = TRUE AND stopped_date IS NULL
  ) m ON TRUE
  LEFT JOIN LATERAL (
    SELECT string_agg(DISTINCT label, '; ') AS list
      FROM diagnoses WHERE patient_id = p.id
  ) dx ON TRUE
  ORDER BY p.id
`;

function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function run() {
  const outArg = process.argv[2];
  const outPath = outArg
    ? resolve(process.cwd(), outArg)
    : join(
        __dirname,
        "..",
        "..",
        "exports",
        `all-patients-${new Date().toISOString().slice(0, 10)}.csv`,
      );
  mkdirSync(dirname(outPath), { recursive: true });

  const out = createWriteStream(outPath, { encoding: "utf8" });
  out.write("﻿"); // BOM so Excel reads UTF-8 names correctly
  out.write(COLUMNS.join(",") + "\n");

  const { rows } = await pool.query(SQL);
  for (const r of rows) out.write(COLUMNS.map((c) => csvCell(r[c])).join(",") + "\n");
  await new Promise((res, rej) => out.end(res).on("error", rej));

  const withVisits = rows.filter((r) => r.total_visits > 0).length;
  console.log(`\nWrote ${rows.length} patients (all-time, no date filter)`);
  console.log(`  file                    : ${outPath}`);
  console.log(`  with >=1 consultation   : ${withVisits}`);
  console.log(`  with 0 consultations    : ${rows.length - withVisits}`);
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
