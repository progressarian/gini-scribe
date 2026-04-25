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

const PATIENT_ID = 16644;

const r = await pool.query(
  `SELECT id, doc_type, title, file_name,
          (storage_path IS NOT NULL) AS has_storage,
          (file_url IS NOT NULL) AS has_url,
          mime_type, doc_date, source, created_at
     FROM documents
    WHERE patient_id = $1
    ORDER BY id DESC
    LIMIT 20`,
  [PATIENT_ID],
);
console.log(`scribe documents for patient ${PATIENT_ID}:`);
for (const d of r.rows) {
  console.log(
    `  id=${d.id} type=${d.doc_type} storage=${d.has_storage} url=${d.has_url} src=${d.source} title=${(d.title || "").slice(0, 40)}`,
  );
}

const genieId = await resolveGeniePatientId(PATIENT_ID);
console.log(`\ngenieId: ${genieId}`);

const genie = createClient(process.env.GENIE_SUPABASE_URL, process.env.GENIE_SUPABASE_SERVICE_KEY);

// Run sync and report
console.log("\n--- syncDocumentsToGenie ---");
const res = await syncDocumentsToGenie(PATIENT_ID, pool);
console.log(JSON.stringify(res, null, 2));

const { data: docs } = await genie
  .from("patient_documents")
  .select("source_id, doc_type, title, file_url, source, document_date")
  .eq("patient_id", genieId)
  .order("created_at", { ascending: false });
console.log(`\nGenie patient_documents rows: ${docs?.length || 0}`);
for (const d of docs || [])
  console.log(
    `  sid=${d.source_id} type=${d.doc_type} url=${d.file_url ? d.file_url.slice(0, 60) + "..." : "NULL"} title=${(d.title || "").slice(0, 40)}`,
  );

await pool.end();
