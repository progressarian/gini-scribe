import "../loadEnv.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../config/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "migrations", "2026-08-19_ghm_search_indexes.sql");

const statements = fs
  .readFileSync(file, "utf-8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

for (const sql of statements) {
  const label = sql.replace(/\s+/g, " ").slice(0, 72);
  const t0 = process.hrtime.bigint();
  try {
    await pool.query(sql);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`OK   (${ms.toFixed(0)}ms)  ${label}`);
  } catch (e) {
    console.error(`FAIL           ${label}\n     ${e.message}`);
    process.exitCode = 1;
  }
}

const r = await pool.query(
  `SELECT indexname FROM pg_indexes
    WHERE tablename = 'appointments'
      AND indexname IN ('idx_appt_preferred_date','idx_appt_patient_name_trgm',
                        'idx_appt_file_no_trgm','idx_appt_phone_trgm')
    ORDER BY indexname`,
);
console.log(
  "\npresent:",
  r.rows.map((x) => x.indexname),
);

await pool.end();
