// Diagnostic: dump scribe-side and Genie-side lab rows for TEST_COMPANION_USER
// to find why values visible on the scribe website aren't appearing in the app.
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

const FILE_NO = "TEST_COMPANION_USER";
const genie = createClient(
  process.env.GENIE_SUPABASE_URL,
  process.env.GENIE_SUPABASE_SERVICE_KEY,
);

const p = await pool.query("SELECT id FROM patients WHERE file_no=$1", [FILE_NO]);
const sid = p.rows[0].id;
const gid = await resolveGeniePatientId(sid);
console.log(`scribe id=${sid}  genie uuid=${gid}`);

const scribe = await pool.query(
  `SELECT test_name, canonical_name, result, unit, flag, source, test_date, genie_id
   FROM lab_results WHERE patient_id=$1 ORDER BY test_date DESC LIMIT 40`,
  [sid],
);
console.log(`\n=== SCRIBE lab_results (${scribe.rowCount} rows) ===`);
for (const r of scribe.rows) {
  console.log(
    `  ${r.test_date} | ${r.test_name} (canon=${r.canonical_name}) = ${r.result} ${r.unit || ""} flag=${r.flag || "-"} src=${r.source} genie_id=${r.genie_id || "-"}`,
  );
}

const { data: gLabs, error } = await genie
  .from("lab_results")
  .select("id, test_name, value, unit, status, source, source_id, test_date")
  .eq("patient_id", gid)
  .order("test_date", { ascending: false })
  .limit(60);
if (error) {
  console.error("genie query failed:", error.message);
  process.exit(1);
}
console.log(`\n=== GENIE lab_results (${gLabs.length} rows) ===`);
for (const r of gLabs) {
  console.log(
    `  ${r.test_date} | ${r.test_name} = ${r.value} ${r.unit || ""} status=${r.status || "-"} src=${r.source} source_id=${r.source_id || "-"} id=${r.id}`,
  );
}

// Coverage check: which canonical names are in scribe but missing from Genie?
const scribeCanons = new Set(
  scribe.rows.map((r) => (r.canonical_name || r.test_name || "").toLowerCase()),
);
const genieNames = new Set(gLabs.map((r) => (r.test_name || "").toLowerCase()));
const missing = [...scribeCanons].filter((c) => c && ![...genieNames].some((g) => g.includes(c) || c.includes(g)));
console.log(`\nScribe canonicals NOT clearly present in Genie:`, missing);

await pool.end();
