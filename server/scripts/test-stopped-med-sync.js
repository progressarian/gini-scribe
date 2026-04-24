/**
 * Verifies that stopped medications on scribe propagate to Genie as
 * is_active=false (so the patient app's "Previous medicines" / stopped
 * section mirrors the /visit page).
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const { syncMedicationsToGenie, resolveGeniePatientId } = require("../genie-sync.cjs");

const FILE_NO = "TEST_COMPANION_USER";
const genie = createClient(process.env.GENIE_SUPABASE_URL, process.env.GENIE_SUPABASE_SERVICE_KEY);

async function run() {
  const p = await pool.query("SELECT id FROM patients WHERE file_no = $1", [FILE_NO]);
  const pid = p.rows[0].id;
  const genieId = await resolveGeniePatientId(pid);
  console.log(`Patient: scribe=${pid} genie=${genieId}`);

  const medName = "StoppedMedTest";
  // Make sure a fresh active row exists
  await pool.query(`DELETE FROM medications WHERE patient_id = $1 AND UPPER(name) = UPPER($2)`, [
    pid,
    medName,
  ]);
  const seeded = await pool.query(
    `INSERT INTO medications (patient_id, name, dose, frequency, timing, route, is_active, started_date, source)
     VALUES ($1,$2,'250mg','OD','Morning','Oral',true,CURRENT_DATE,'visit') RETURNING id`,
    [pid, medName],
  );
  const medId = seeded.rows[0].id;
  console.log(`Seeded active med id=${medId}`);

  // Push active
  await syncMedicationsToGenie(pid, pool);

  // Now stop it
  await pool.query(
    `UPDATE medications SET is_active=false, stopped_date=CURRENT_DATE, stop_reason='test sync' WHERE id=$1`,
    [medId],
  );
  console.log(`Stopped med id=${medId}`);

  // Re-push
  const res = await syncMedicationsToGenie(pid, pool);
  console.log(`Re-push: pushed=${res.pushed} errors=${res.errors.length}`);

  // Read back from Genie
  const sid = `gini-med-${medId}`;
  const { data } = await genie
    .from("medications")
    .select("source_id, name, is_active, source")
    .eq("patient_id", genieId)
    .eq("source_id", sid)
    .maybeSingle();
  console.log("Genie row:", data);

  console.log("\n=== RESULT ===");
  if (data && data.is_active === false) {
    console.log("PASS: stopped med propagated with is_active=false");
  } else {
    console.log("FAIL: Genie row missing or still active");
    process.exitCode = 1;
  }
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
