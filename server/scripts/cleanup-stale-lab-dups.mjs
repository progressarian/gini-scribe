/**
 * One-shot cleanup: delete Genie lab_results rows that were created as
 * duplicates by the pre-fix syncLabsToGenie path. Those rows have
 * source='scribe', source_id like 'gini-lab-<N>', AND the corresponding
 * scribe lab_results row (id=N) is itself a patient-origin row (has
 * genie_id IS NOT NULL — it was pulled from Genie in the first place,
 * never should have been pushed back).
 *
 * Safe: does a dry-run preview first; pass --apply to actually delete.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "server", ".env") });

const { default: pool } = await import("./server/config/db.js");
const require = createRequire(import.meta.url);
const { createClient } = require("@supabase/supabase-js");
const genie = createClient(
  process.env.GENIE_SUPABASE_URL,
  process.env.GENIE_SUPABASE_SERVICE_KEY,
);

const APPLY = process.argv.includes("--apply");
const PATIENT_FILTER = process.argv.includes("--patient")
  ? Number(process.argv[process.argv.indexOf("--patient") + 1])
  : null;

async function run() {
  // Find scribe lab_results rows that are patient-origin (have genie_id).
  const scribeQ = `SELECT id, patient_id, genie_id FROM lab_results
                   WHERE genie_id IS NOT NULL ${PATIENT_FILTER ? "AND patient_id = $1" : ""}`;
  const scribeParams = PATIENT_FILTER ? [PATIENT_FILTER] : [];
  const { rows: scribeRows } = await pool.query(scribeQ, scribeParams);
  console.log(`Found ${scribeRows.length} patient-origin scribe lab rows`);

  // For each, check if a stale dup exists in Genie with source='scribe'
  // and source_id='gini-lab-<scribe.id>'. If it does, that's the dup.
  const stale = [];
  for (const r of scribeRows) {
    const sid = `gini-lab-${r.id}`;
    const { data, error } = await genie
      .from("lab_results")
      .select("id, test_name, value, source, source_id, test_date, created_at")
      .eq("source", "scribe")
      .eq("source_id", sid);
    if (error) {
      console.warn(`query failed for ${sid}: ${error.message}`);
      continue;
    }
    if (data && data.length > 0) {
      for (const d of data) {
        stale.push({ scribeId: r.id, scribePid: r.patient_id, ...d });
      }
    }
  }

  console.log(`\nStale dup Genie rows: ${stale.length}`);
  stale.forEach((s) =>
    console.log(
      `  scribe.id=${s.scribePid}/${s.scribeId} → genie.id=${s.id.slice(0, 8)} test=${s.test_name} value=${s.value} source=${s.source} source_id=${s.source_id}`,
    ),
  );

  if (!APPLY) {
    console.log("\nDry-run only. Pass --apply to actually delete.");
    return;
  }
  if (stale.length === 0) {
    console.log("Nothing to delete.");
    return;
  }
  const ids = stale.map((s) => s.id);
  const { error: delErr, count } = await genie
    .from("lab_results")
    .delete({ count: "exact" })
    .in("id", ids);
  if (delErr) {
    console.error("Delete failed:", delErr.message);
    process.exitCode = 1;
    return;
  }
  console.log(`\nDeleted ${count} stale dup rows.`);
}

try {
  await run();
} finally {
  await pool.end();
}
