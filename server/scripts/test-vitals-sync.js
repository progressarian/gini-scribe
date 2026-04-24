/**
 * Verifies 2-way scribe ↔ Genie sync for BP, weight, and RBS (blood sugar)
 * vitals for TEST_COMPANION_USER.
 *
 * Seeds a scribe vitals row with bp_sys/bp_dia, weight, rbs + meal_type,
 * invokes syncVitalsRowToGenie, then reads back Genie vitals and verifies
 * all three values landed under source_id='gini-vitals-<scribeVitalsId>'.
 *
 * Prerequisites (apply ONCE before this test will pass):
 *   psql $DATABASE_URL -f server/migrations/2026-04-24_vitals_rbs.sql
 *   Run myhealthgenie/supabase/migrations/2026-04-24_gini_sync_vitals_rbs.sql
 *   in the Supabase SQL editor for the Genie project.
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
const { syncVitalsRowToGenie, resolveGeniePatientId } = require("../genie-sync.cjs");

const FILE_NO = "TEST_COMPANION_USER";
const genie = createClient(process.env.GENIE_SUPABASE_URL, process.env.GENIE_SUPABASE_SERVICE_KEY);

async function run() {
  const p = await pool.query("SELECT id FROM patients WHERE file_no = $1", [FILE_NO]);
  const pid = p.rows[0].id;
  const genieId = await resolveGeniePatientId(pid);
  console.log(`Patient: scribe=${pid} genie=${genieId}`);

  // Seed one vitals row covering BP, weight, RBS + meal_type
  const seeded = await pool.query(
    `INSERT INTO vitals (patient_id, recorded_at, bp_sys, bp_dia, pulse, spo2, weight, height, rbs, meal_type)
     VALUES ($1, NOW(), $2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, recorded_at, bp_sys, bp_dia, pulse, spo2, weight, height, rbs, meal_type`,
    [pid, 132, 84, 76, 98, 72.5, 170, 145, "post_meal"],
  );
  const row = seeded.rows[0];
  console.log(
    `Seeded scribe vitals id=${row.id} bp=${row.bp_sys}/${row.bp_dia} weight=${row.weight} rbs=${row.rbs} meal=${row.meal_type}`,
  );

  // Push to Genie
  const pushRes = await syncVitalsRowToGenie(pid, row);
  console.log("Push result:", pushRes);

  // Read back from Genie vitals
  const sid = `gini-vitals-${row.id}`;
  const { data, error } = await genie
    .from("vitals")
    .select("source_id, bp_systolic, bp_diastolic, weight_kg, rbs, meal_type, source")
    .eq("patient_id", genieId)
    .eq("source_id", sid)
    .maybeSingle();
  if (error) {
    console.error("Genie read failed:", error.message);
    process.exitCode = 1;
    return;
  }
  console.log("Genie row:", data);

  const bpOk = data && Number(data.bp_systolic) === 132 && Number(data.bp_diastolic) === 84;
  const wOk = data && Number(data.weight_kg) === 72.5;
  const rbsOk = data && Number(data.rbs) === 145;
  const mealOk = data && data.meal_type === "post_meal";

  console.log("\n=== RESULT ===");
  console.log(`BP        landed: ${bpOk ? "YES" : "NO"}`);
  console.log(`Weight    landed: ${wOk ? "YES" : "NO"}`);
  console.log(`RBS       landed: ${rbsOk ? "YES" : "NO"}`);
  console.log(`Meal type landed: ${mealOk ? "YES" : "NO"}`);

  if (!bpOk || !wOk || !rbsOk || !mealOk) process.exitCode = 1;
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
