import "../loadEnv.js";
import pool from "../config/db.js";
import { cleanDemoDay, demoAllowed } from "../services/giniflow/demo.js";

// Remove every demo patient and everything hanging off them.
//
//   GINIFLOW_ALLOW_DEMO=1 node scripts/clean-demo.mjs
//
// A script rather than a `node -e` one-liner because `-e` never runs
// `loadEnv.js`, so DATABASE_URL is unset and it fails with a SASL error that
// looks like a credentials problem rather than a missing env file.
//
// Scoped to the `ZZDEMO_` file-number prefix, so a real patient cannot be caught
// by it. Deletes: medicine_collections, medications, vitals, diagnoses,
// lab_results, documents, consultations, appointments, walkin_bookings,
// giniflow_visits (and everything cascading off them), then the patients.

if (!demoAllowed()) {
  console.error("Set GINIFLOW_ALLOW_DEMO=1 to run this. DATABASE_URL is production.");
  process.exit(2);
}

try {
  const before = await pool.query(
    `SELECT count(*)::int n FROM patients WHERE file_no LIKE 'ZZDEMO_%'`,
  );
  const r = await cleanDemoDay();
  console.log(
    `\n✓ removed ${r.demoPatientsRemoved} demo patients (${before.rows[0].n} before) and ${r.deleted} Gini Flow visits\n`,
  );
} catch (e) {
  console.error("Clean failed:", e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
