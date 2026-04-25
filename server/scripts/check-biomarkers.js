import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const { resolveGeniePatientId } = require("../genie-sync.cjs");

const PID = parseInt(process.argv[2] || "16644", 10);

const genieId = await resolveGeniePatientId(PID);
console.log(`scribe patient ${PID} ↔ Genie ${genieId}`);

console.log("\n── SCRIBE: lab_results ─────────────────");
const slabs = await pool.query(
  `SELECT id, test_name, result, unit, test_date FROM lab_results
    WHERE patient_id = $1 ORDER BY test_date DESC NULLS LAST, id DESC LIMIT 15`,
  [PID],
);
for (const r of slabs.rows)
  console.log(` ${r.id} ${r.test_date} ${r.test_name}=${r.result} ${r.unit || ""}`);
console.log(`(${slabs.rowCount} rows)`);

console.log("\n── SCRIBE: vitals (patient_vitals_log + visit-recorded) ─");
const svit = await pool
  .query(
    `SELECT * FROM patient_vitals_log WHERE patient_id = $1 ORDER BY recorded_date DESC LIMIT 10`,
    [PID],
  )
  .catch(() => ({ rows: [] }));
for (const r of svit.rows)
  console.log(
    ` ${r.recorded_date} bp=${r.bp_systolic}/${r.bp_diastolic} pulse=${r.pulse} rbs=${r.rbs}`,
  );
console.log(`(${svit.rows.length} rows)`);

const genie = createClient(process.env.GENIE_SUPABASE_URL, process.env.GENIE_SUPABASE_SERVICE_KEY);

console.log("\n── GENIE: lab_results ─────────────────");
const { data: glabs } = await genie
  .from("lab_results")
  .select("source_id, test_name, value, unit, test_date, source")
  .eq("patient_id", genieId)
  .order("test_date", { ascending: false })
  .limit(15);
for (const r of glabs || [])
  console.log(
    ` ${r.source_id || "-"} ${r.test_date} ${r.test_name}=${r.value} ${r.unit || ""} src=${r.source}`,
  );
console.log(`(${(glabs || []).length} rows)`);

console.log("\n── GENIE: vitals ─────────────────────");
const { data: gvit } = await genie
  .from("vitals")
  .select("source_id, recorded_date, bp_systolic, bp_diastolic, pulse, rbs, weight_kg, source")
  .eq("patient_id", genieId)
  .order("recorded_date", { ascending: false })
  .limit(15);
for (const r of gvit || [])
  console.log(
    ` ${r.source_id || "-"} ${r.recorded_date} bp=${r.bp_systolic}/${r.bp_diastolic} rbs=${r.rbs} src=${r.source}`,
  );
console.log(`(${(gvit || []).length} rows)`);

await pool.end();
