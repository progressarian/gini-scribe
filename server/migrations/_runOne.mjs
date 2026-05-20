// One-shot migration runner. Uses the project's own pool (config/db.js)
// so it inherits the retry-on-transient-error wrapper — important for the
// Supabase pooler which occasionally drops connections mid-handshake.
//
// Usage (from the gini-scribe/server folder):
//   node migrations/_runOne.mjs <relative-path-to-sql-file>
//
// Example:
//   node migrations/_runOne.mjs migrations/2026-05-20_lab_test_requests.sql

import "../loadEnv.js";
import fs from "fs";
import path from "path";
import pool from "../config/db.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node migrations/_runOne.mjs <file.sql>");
  process.exit(1);
}

const absPath = path.resolve(file);
if (!fs.existsSync(absPath)) {
  console.error(`File not found: ${absPath}`);
  process.exit(1);
}

const sql = fs.readFileSync(absPath, "utf-8");

try {
  await pool.query(sql);
  console.log(`OK: applied ${file}`);

  // Targeted verification for the lab_test_requests migration. Harmless for
  // any other migration — to_regclass returns null when the table doesn't
  // exist so the log line just shows nulls.
  const verify = await pool.query(
    `SELECT to_regclass('public.lab_test_requests')::text AS table_present,
            (SELECT COUNT(*)::int FROM pg_constraint
              WHERE conname = 'lab_request_home_needs_address') AS check_present`,
  );
  console.log("Verify:", verify.rows[0]);
} catch (e) {
  console.error("FAIL:", e.message || e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
