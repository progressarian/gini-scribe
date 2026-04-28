/**
 * Comprehensive 2-way lab sync verification for Genie ↔ scribe with the
 * "same-day same-test = update existing row" model.
 *
 * Test matrix:
 *   1. Patient logs HbA1c=A in app  → 1 Genie row, 1 scribe row, value=A
 *   2. Patient logs HbA1c=B same day → same Genie row updated to B,
 *                                     same scribe row updated to B (no new)
 *   3. Doctor edits HbA1c on scribe (PATCH) → Genie row updates, no dup
 *   4. Doctor adds HbA1c on scribe (POST) same day → same row updates,
 *                                                   Genie row updates, no dup
 *   5. Different day = new row on both sides
 *
 * Usage: node server/scripts/test-lab-sync-full.mjs
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
const {
  syncPatientLogsFromGenie,
  syncLabsToGenie,
  updateGenieLabByGenieId,
} = require("../genie-sync.cjs");

const FILE_NO = "TEST_COMPANION_USER";
const genie = createClient(
  process.env.GENIE_SUPABASE_URL,
  process.env.GENIE_SUPABASE_SERVICE_KEY,
);

let pass = 0,
  fail = 0;
function check(label, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass += 1;
  } else {
    console.log(`  ✗ ${label} ${detail}`);
    fail += 1;
  }
}

// Mirrors the new LogModal lab branch: same-day same-test patient-origin
// row gets UPDATEd; otherwise INSERT.
async function patientAppLog(geniePid, testName, value, testDate) {
  const { data: existing } = await genie
    .from("lab_results")
    .select("id")
    .eq("patient_id", geniePid)
    .eq("test_name", testName)
    .eq("test_date", testDate)
    .eq("source", "patient")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    const { error } = await genie
      .from("lab_results")
      .update({ value, unit: "%", status: "high", lab_name: "Self-logged" })
      .eq("id", existing.id);
    return { error, existed: true, id: existing.id };
  }
  const { data, error } = await genie
    .from("lab_results")
    .insert({
      patient_id: geniePid,
      test_name: testName,
      value,
      unit: "%",
      reference_range: "<5.7",
      status: "high",
      lab_name: "Self-logged",
      test_date: testDate,
      source: "patient",
    })
    .select("id")
    .single();
  return { error, existed: false, id: data?.id };
}

// Mirrors the new POST /lab handler: same-day same-canonical UPDATE if
// row exists, INSERT otherwise; for patient-origin rows update Genie via
// updateGenieLabByGenieId.
async function scribePostLab(scribePid, testName, canonical, value, testDate) {
  const existing = await pool.query(
    `SELECT id, genie_id, ref_range, flag FROM lab_results
     WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date
     ORDER BY (genie_id IS NOT NULL) DESC, created_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [scribePid, canonical, testDate],
  );
  let r;
  if (existing.rows[0]) {
    r = await pool.query(
      `UPDATE lab_results SET test_name=$1, result=$2, unit='%' WHERE id=$3 RETURNING *`,
      [testName, value, existing.rows[0].id],
    );
  } else {
    r = await pool.query(
      `INSERT INTO lab_results (patient_id, test_name, canonical_name, result, unit, test_date, source)
       VALUES ($1,$2,$3,$4,'%',$5::date,'manual') RETURNING *`,
      [scribePid, testName, canonical, value, testDate],
    );
  }
  const row = r.rows[0];
  if (row.genie_id) {
    const flag =
      row.flag === "HIGH" ? "high" : row.flag === "LOW" ? "low" : "normal";
    await updateGenieLabByGenieId(row.genie_id, {
      test_name: row.test_name,
      value: row.result,
      unit: row.unit,
      reference_range: row.ref_range,
      status: flag,
      test_date: row.test_date,
    });
  } else {
    await syncLabsToGenie(scribePid, pool);
  }
  return row;
}

async function run() {
  const p = await pool.query("SELECT id FROM patients WHERE file_no=$1", [FILE_NO]);
  if (!p.rows[0]) throw new Error("Run create-test-patient.js first");
  const SCRIBE_PID = p.rows[0].id;
  const { data: gp } = await genie
    .from("patients")
    .select("id")
    .eq("gini_patient_id", String(SCRIBE_PID))
    .single();
  const GENIE_PID = gp.id;
  const today = new Date().toISOString().split("T")[0];
  const yesterday = new Date(Date.now() - 86400_000).toISOString().split("T")[0];
  const tag = Date.now().toString().slice(-6);
  const TEST = `HbA1c_${tag}`;
  console.log(`Patient: scribe=${SCRIBE_PID} genie=${GENIE_PID} test=${TEST}\n`);

  // Pre-cleanup: in case a previous failed run left rows behind for this
  // (extremely rare, since TEST is unique per run, but defensive).
  await genie.from("lab_results").delete()
    .eq("patient_id", GENIE_PID).eq("test_name", TEST);
  await pool.query(
    `DELETE FROM lab_results WHERE patient_id=$1 AND test_name=$2`,
    [SCRIBE_PID, TEST],
  );

  // ─────────────────────────────────────────────────────────────────
  console.log("Test 1: Patient logs HbA1c=7.1 in app → 1 row created");
  // ─────────────────────────────────────────────────────────────────
  await patientAppLog(GENIE_PID, TEST, 7.1, today);
  await syncPatientLogsFromGenie(SCRIBE_PID, pool);
  let g = await genie.from("lab_results").select("id, value")
    .eq("patient_id", GENIE_PID).eq("test_name", TEST).eq("test_date", today);
  let s = await pool.query(
    `SELECT id, genie_id, result FROM lab_results
     WHERE patient_id=$1 AND test_name=$2 AND test_date=$3::date`,
    [SCRIBE_PID, TEST, today],
  );
  check("Genie has 1 row", g.data?.length === 1);
  check("Genie value = 7.1", g.data?.[0]?.value == 7.1);
  check("Scribe has 1 row", s.rows.length === 1);
  check("Scribe row has genie_id", !!s.rows[0]?.genie_id);
  check("Scribe value = 7.1", s.rows[0]?.result == 7.1);
  const firstGenieId = g.data?.[0]?.id;
  const firstScribeId = s.rows[0]?.id;

  // ─────────────────────────────────────────────────────────────────
  console.log("\nTest 2: Patient logs HbA1c=7.4 same day → SAME row updates");
  // ─────────────────────────────────────────────────────────────────
  const log2 = await patientAppLog(GENIE_PID, TEST, 7.4, today);
  check("LogModal hit existing-row branch", log2.existed === true);
  await syncPatientLogsFromGenie(SCRIBE_PID, pool);
  g = await genie.from("lab_results").select("id, value")
    .eq("patient_id", GENIE_PID).eq("test_name", TEST).eq("test_date", today);
  s = await pool.query(
    `SELECT id, genie_id, result FROM lab_results
     WHERE patient_id=$1 AND test_name=$2 AND test_date=$3::date`,
    [SCRIBE_PID, TEST, today],
  );
  check("Genie still has 1 row", g.data?.length === 1, `got ${g.data?.length}`);
  check("Genie row id unchanged", g.data?.[0]?.id === firstGenieId);
  check("Genie value = 7.4", g.data?.[0]?.value == 7.4);
  check("Scribe still has 1 row", s.rows.length === 1, `got ${s.rows.length}`);
  check("Scribe row id unchanged", s.rows[0]?.id === firstScribeId);
  check("Scribe value = 7.4", s.rows[0]?.result == 7.4);

  // ─────────────────────────────────────────────────────────────────
  console.log("\nTest 3: Doctor edits HbA1c on scribe via PATCH → Genie updates in place");
  // ─────────────────────────────────────────────────────────────────
  await pool.query(`UPDATE lab_results SET result=7.6 WHERE id=$1`, [firstScribeId]);
  await updateGenieLabByGenieId(firstGenieId, {
    test_name: TEST, value: 7.6, unit: "%", reference_range: "<5.7",
    status: "high", test_date: today,
  });
  g = await genie.from("lab_results").select("id, value")
    .eq("patient_id", GENIE_PID).eq("test_name", TEST).eq("test_date", today);
  check("Genie still 1 row after edit", g.data?.length === 1);
  check("Genie value = 7.6 after edit", g.data?.[0]?.value == 7.6);

  // ─────────────────────────────────────────────────────────────────
  console.log("\nTest 4: Doctor adds HbA1c=7.9 on scribe via POST same day → SAME row updates");
  // ─────────────────────────────────────────────────────────────────
  // Pull writes canonical_name = getCanonical(test_name) || test_name. Our
  // tagged test_name doesn't match the canonical map, so the canonical_name
  // on the pulled row equals the tagged test_name itself. Use that as the
  // POST /lab canonical so the existing-row check matches.
  await scribePostLab(SCRIBE_PID, TEST, TEST, 7.9, today);
  g = await genie.from("lab_results").select("id, value")
    .eq("patient_id", GENIE_PID).eq("test_name", TEST).eq("test_date", today);
  s = await pool.query(
    `SELECT id, result FROM lab_results
     WHERE patient_id=$1 AND test_name=$2 AND test_date=$3::date`,
    [SCRIBE_PID, TEST, today],
  );
  check("Genie still 1 row after POST", g.data?.length === 1, `got ${g.data?.length}`);
  check("Genie value = 7.9", g.data?.[0]?.value == 7.9);
  check("Scribe still 1 row after POST", s.rows.length === 1, `got ${s.rows.length}`);
  check("Scribe value = 7.9", s.rows[0]?.result == 7.9);

  // ─────────────────────────────────────────────────────────────────
  console.log("\nTest 5: Patient logs HbA1c on YESTERDAY → new row created");
  // ─────────────────────────────────────────────────────────────────
  await patientAppLog(GENIE_PID, TEST, 6.5, yesterday);
  await syncPatientLogsFromGenie(SCRIBE_PID, pool);
  g = await genie.from("lab_results").select("id, value, test_date")
    .eq("patient_id", GENIE_PID).eq("test_name", TEST);
  s = await pool.query(
    `SELECT id, result, test_date FROM lab_results
     WHERE patient_id=$1 AND test_name=$2`,
    [SCRIBE_PID, TEST],
  );
  check("Genie has 2 rows total (today + yesterday)", g.data?.length === 2,
    `got ${g.data?.length}`);
  check("Scribe has 2 rows total", s.rows.length === 2, `got ${s.rows.length}`);

  // ─────────────────────────────────────────────────────────────────
  console.log("\nCleanup");
  // ─────────────────────────────────────────────────────────────────
  await genie.from("lab_results").delete()
    .eq("patient_id", GENIE_PID).eq("test_name", TEST);
  await pool.query(
    `DELETE FROM lab_results WHERE patient_id=$1 AND test_name=$2`,
    [SCRIBE_PID, TEST],
  );
  console.log("  cleaned up test rows");

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exitCode = 1;
}

try {
  await run();
} finally {
  await pool.end();
}
