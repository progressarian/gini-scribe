// One-shot: run the new catch-up sync for TEST_COMPANION_USER and report
// before/after row counts on the scribe side. Exits non-zero on hard failure.
//
// Usage:
//   node server/scripts/run-genie-sync-test-companion.mjs
//   node server/scripts/run-genie-sync-test-companion.mjs --file-no FOO
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { syncPatientLogsFromGenie, resolveGeniePatientId } = require("../genie-sync.cjs");

const fileNoIdx = process.argv.indexOf("--file-no");
const FILE_NO = fileNoIdx > -1 ? process.argv[fileNoIdx + 1] : "TEST_COMPANION_USER";

async function counts(patientId) {
  const q = (sql) => pool.query(sql, [patientId]).then((r) => Number(r.rows[0]?.c || 0));
  const [vitals, labs] = await Promise.all([
    q("SELECT COUNT(*)::int AS c FROM patient_vitals_log WHERE patient_id=$1"),
    q("SELECT COUNT(*)::int AS c FROM lab_results WHERE patient_id=$1 AND source='patient_app'"),
  ]);
  return { vitals, labs };
}

async function main() {
  const p = await pool.query(
    "SELECT id, name, file_no FROM patients WHERE file_no=$1",
    [FILE_NO],
  );
  if (p.rows.length === 0) {
    console.error(`No scribe patient with file_no=${FILE_NO}`);
    process.exit(1);
  }
  const sp = p.rows[0];
  console.log(`Scribe patient id=${sp.id} name=${sp.name} file_no=${sp.file_no}`);

  const genieId = await resolveGeniePatientId(sp.id);
  console.log(`Genie UUID: ${genieId || "(none)"}`);

  const before = await counts(sp.id);
  console.log("BEFORE:", before);

  const t0 = Date.now();
  const res = await syncPatientLogsFromGenie(sp.id, pool);
  const ms = Date.now() - t0;
  console.log(`Sync result (${ms}ms):`, JSON.stringify(res, null, 2));

  const after = await counts(sp.id);
  console.log("AFTER:", after);
  console.log("DELTA:", {
    vitals: after.vitals - before.vitals,
    labs: after.labs - before.labs,
  });

  await pool.end();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
