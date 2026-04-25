/**
 * One-time backfill: push every scribe document to Genie's patient_documents.
 * Safe to re-run — gini_sync_document upserts by (patient_id, source_id).
 *
 * Run:
 *   node server/scripts/backfill-doc-sync.js
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { createRequire } from "module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const require = createRequire(import.meta.url);
const { syncDocumentsToGenie } = require("../genie-sync.cjs");

const { rows } = await pool.query(
  `SELECT DISTINCT patient_id
     FROM documents
    WHERE doc_type IN ('prescription','lab_report','imaging','discharge')
    ORDER BY patient_id`,
);
console.log(`Patients with documents: ${rows.length}`);

let totalPushed = 0;
let totalErrors = 0;
for (const r of rows) {
  const res = await syncDocumentsToGenie(r.patient_id, pool);
  totalPushed += res.pushed || 0;
  totalErrors += (res.errors || []).length;
  console.log(
    `  patient ${r.patient_id}: synced=${res.synced} pushed=${res.pushed}/${res.total} errors=${(res.errors || []).length}`,
  );
}

console.log(`\nDone. pushed=${totalPushed} errors=${totalErrors}`);
await pool.end();
