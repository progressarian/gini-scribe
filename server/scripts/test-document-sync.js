/**
 * Smoke test for the Scribe -> Genie document push path.
 *
 * Steps:
 *   1. Find TEST_COMPANION_USER in scribe Postgres
 *   2. Link the patient on Genie (idempotent)
 *   3. Insert a prescription, lab_report, and imaging row in scribe `documents`
 *   4. Invoke syncDocumentsToGenie
 *   5. Read back from Genie's `patient_documents` and verify each landed
 *
 * Run:
 *   node server/scripts/test-document-sync.js
 *   node server/scripts/test-document-sync.js --file-no FOO
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
const { syncDocumentsToGenie, resolveGeniePatientId } = require("../genie-sync.cjs");

const fileNoIdx = process.argv.indexOf("--file-no");
const FILE_NO = fileNoIdx > -1 ? process.argv[fileNoIdx + 1] : "TEST_COMPANION_USER";

const GENIE_URL = process.env.GENIE_SUPABASE_URL;
const GENIE_KEY = process.env.GENIE_SUPABASE_SERVICE_KEY;

async function run() {
  if (!GENIE_URL || !GENIE_KEY) {
    console.error("GENIE_SUPABASE_URL / GENIE_SUPABASE_SERVICE_KEY not set in server/.env");
    process.exitCode = 1;
    return;
  }

  const p = await pool.query("SELECT id, name, file_no, phone FROM patients WHERE file_no = $1", [
    FILE_NO,
  ]);
  if (p.rows.length === 0) {
    console.error(`No local patient with file_no=${FILE_NO}. Run create-test-patient.js first.`);
    process.exitCode = 1;
    return;
  }
  const scribePatient = p.rows[0];
  console.log(`Scribe patient: id=${scribePatient.id} name=${scribePatient.name}`);

  const genie = createClient(GENIE_URL, GENIE_KEY);

  await genie.rpc("gini_link_patient", {
    p_gini_id: String(scribePatient.id),
    p_name: scribePatient.name,
    p_phone: scribePatient.phone,
    p_dob: null,
    p_sex: null,
    p_blood_group: null,
    p_uhid: scribePatient.file_no,
  });

  const genieId = await resolveGeniePatientId(scribePatient.id);
  if (!genieId) {
    console.error("resolveGeniePatientId returned null after linking.");
    process.exitCode = 1;
    return;
  }
  console.log(`Genie patient UUID: ${genieId}`);

  const today = new Date().toISOString().split("T")[0];

  // Seed three documents — one of each doc_type the sync covers. file_url is
  // a stand-in https URL since the sync allows file_url-only rows (no upload).
  const seedDoc = (doc_type, title) =>
    pool.query(
      `INSERT INTO documents (patient_id, doc_type, title, file_url, mime_type, doc_date, source, extracted_data)
       VALUES ($1,$2,$3,$4,$5,$6::date,'upload',$7::jsonb)
       RETURNING id, doc_type, title, file_url, doc_date`,
      [
        scribePatient.id,
        doc_type,
        title,
        `https://example.com/${doc_type}-test-${Date.now()}.pdf`,
        "application/pdf",
        today,
        JSON.stringify({ test: true, doc_type }),
      ],
    );

  const rx = (await seedDoc("prescription", "Test Prescription Sync")).rows[0];
  const lab = (await seedDoc("lab_report", "Test Lab Report Sync")).rows[0];
  const scan = (await seedDoc("imaging", "Test Scan Sync")).rows[0];
  console.log(`Seeded docs: rx=${rx.id} lab=${lab.id} scan=${scan.id}`);

  console.log("\n--- syncDocumentsToGenie ---");
  const res = await syncDocumentsToGenie(scribePatient.id, pool);
  console.log(JSON.stringify(res, null, 2));

  const expectedSids = [`gini-doc-${rx.id}`, `gini-doc-${lab.id}`, `gini-doc-${scan.id}`];

  const { data: remoteDocs, error: rdErr } = await genie
    .from("patient_documents")
    .select("source_id, doc_type, title, file_url, document_date, content_type, source")
    .eq("patient_id", genieId)
    .in("source_id", expectedSids);
  if (rdErr) {
    console.error("Supabase read patient_documents failed:", rdErr.message);
    process.exitCode = 1;
    return;
  }
  console.log(`\nSupabase patient_documents rows for our test source_ids: ${remoteDocs.length}`);
  for (const d of remoteDocs) console.log(" ", d);

  const sidSet = new Set((remoteDocs || []).map((d) => d.source_id));
  const rxHit = sidSet.has(`gini-doc-${rx.id}`);
  const labHit = sidSet.has(`gini-doc-${lab.id}`);
  const scanHit = sidSet.has(`gini-doc-${scan.id}`);

  console.log("\n=== RESULT ===");
  console.log(`Prescription (gini-doc-${rx.id}) landed on Genie: ${rxHit ? "YES" : "NO"}`);
  console.log(`Lab report   (gini-doc-${lab.id}) landed on Genie: ${labHit ? "YES" : "NO"}`);
  console.log(`Scan         (gini-doc-${scan.id}) landed on Genie: ${scanHit ? "YES" : "NO"}`);

  // Cleanup the scribe rows so reruns don't accumulate.
  await pool.query(`DELETE FROM documents WHERE id = ANY($1::int[])`, [[rx.id, lab.id, scan.id]]);
  await genie
    .from("patient_documents")
    .delete()
    .eq("patient_id", genieId)
    .in("source_id", expectedSids);

  if (!rxHit || !labHit || !scanHit) process.exitCode = 1;
}

run()
  .catch((err) => {
    console.error("Fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
