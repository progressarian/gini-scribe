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

const DOC_ID = 30802;

const r = await pool.query(
  `SELECT id, patient_id, doc_type, title, file_name, file_url, storage_path,
          mime_type, doc_date, source, created_at,
          length(extracted_text) AS extracted_len
     FROM documents WHERE id = $1`,
  [DOC_ID],
);
console.log("scribe documents row:", r.rows[0]);

if (!r.rows[0]) { await pool.end(); process.exit(1); }
const patientId = r.rows[0].patient_id;

const genieId = await resolveGeniePatientId(patientId);
console.log("genieId:", genieId);

const genie = createClient(process.env.GENIE_SUPABASE_URL, process.env.GENIE_SUPABASE_SERVICE_KEY);
const { data: existing, error: ee } = await genie
  .from("patient_documents")
  .select("source_id, doc_type, title, file_url, source, created_at")
  .eq("patient_id", genieId)
  .eq("source_id", `gini-doc-${DOC_ID}`);
console.log("existing patient_documents row(s):", existing, ee?.message);

console.log("\n--- syncDocumentsToGenie (running) ---");
const res = await syncDocumentsToGenie(patientId, pool);
console.log(JSON.stringify(res, null, 2));

const { data: after } = await genie
  .from("patient_documents")
  .select("source_id, doc_type, title, file_url, source")
  .eq("patient_id", genieId)
  .order("created_at", { ascending: false })
  .limit(10);
console.log("\npatient_documents (latest 10) for this patient:");
for (const d of after || []) console.log(" ", d);

await pool.end();
