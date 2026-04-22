/**
 * Backfill extractions for all documents stuck at
 *   extracted_data->>'extraction_status' = 'pending'
 *
 * Two cases:
 *   - Orphan (no storage_path and no file_url): file upload never finished,
 *     so extraction is impossible. DELETE the row (and any orphan
 *     lab_results / medications scoped to it — those should be empty).
 *   - Has file: call runServerExtraction, which runs Claude with 3 retries
 *     and a 180s timeout, then writes either the extracted_data payload
 *     (via the same cascade PATCH /:id uses) or extraction_status = failed
 *     with an error_message.
 *
 * Usage:
 *   node server/scripts/backfill-pending-extractions.js          # dry-run
 *   node server/scripts/backfill-pending-extractions.js --apply  # execute
 *   node server/scripts/backfill-pending-extractions.js --apply --limit=50
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const dotenv = await import("dotenv");
dotenv.config({ path: join(__dirname, "..", ".env") });

const { default: pool } = await import("../config/db.js");
const { runServerExtraction } = await import("../routes/documents.js");

const args = process.argv.slice(2);
const DRY = !args.includes("--apply");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 0;
const BATCH_DELAY_MS = 1000; // polite spacing between Claude calls

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const limitClause = LIMIT ? `LIMIT ${LIMIT}` : "";
  const { rows } = await pool.query(
    `SELECT id, patient_id, doc_type, title, file_name, storage_path, file_url, created_at
       FROM documents
      WHERE extracted_data->>'extraction_status' = 'pending'
      ORDER BY created_at ASC
      ${limitClause}`,
  );

  const orphans = rows.filter((r) => !r.storage_path && !r.file_url);
  const withFile = rows.filter((r) => r.storage_path || r.file_url);

  console.log(`\nFound ${rows.length} pending docs:`);
  console.log(`  orphans (no file attached → delete): ${orphans.length}`);
  console.log(`  has file (re-run extraction):        ${withFile.length}\n`);

  if (DRY) {
    for (const r of orphans.slice(0, 20)) {
      console.log(
        `  [orphan]  doc=${r.id} patient=${r.patient_id} type=${r.doc_type} title=${JSON.stringify(r.title || "")} created=${r.created_at.toISOString()}`,
      );
    }
    if (orphans.length > 20) console.log(`  ...and ${orphans.length - 20} more orphans`);
    for (const r of withFile.slice(0, 20)) {
      console.log(
        `  [extract] doc=${r.id} patient=${r.patient_id} type=${r.doc_type} title=${JSON.stringify(r.title || "")} created=${r.created_at.toISOString()}`,
      );
    }
    if (withFile.length > 20) console.log(`  ...and ${withFile.length - 20} more with files`);
    console.log("\nDRY RUN — no changes made. Add --apply to execute.");
    return;
  }

  let deleted = 0;
  for (const r of orphans) {
    try {
      await pool.query(`DELETE FROM lab_results WHERE document_id = $1`, [r.id]);
      await pool.query(`DELETE FROM medications WHERE document_id = $1`, [r.id]);
      await pool.query(`DELETE FROM documents WHERE id = $1`, [r.id]);
      deleted += 1;
      console.log(`  [deleted] doc=${r.id} patient=${r.patient_id} (${r.doc_type})`);
    } catch (e) {
      console.error(`  [delete-err] doc=${r.id}: ${e.message}`);
    }
  }

  let extracted = 0;
  let failed = 0;
  for (let i = 0; i < withFile.length; i++) {
    const r = withFile[i];
    const pfx = `  [${i + 1}/${withFile.length}]`;
    console.log(`${pfx} extracting doc=${r.id} patient=${r.patient_id} type=${r.doc_type}...`);
    try {
      const result = await runServerExtraction(r.id, { skipIfNotPending: false });
      if (result?.success) {
        extracted += 1;
        console.log(`${pfx} → ok (${result.attempts || 1} attempt(s))`);
      } else {
        failed += 1;
        console.log(`${pfx} → fail: ${result?.error_message || "unknown"}`);
      }
    } catch (e) {
      failed += 1;
      console.error(`${pfx} → crash: ${e.message}`);
    }
    if (i < withFile.length - 1) await sleep(BATCH_DELAY_MS);
  }

  console.log(
    `\nSummary: deleted=${deleted}  extracted=${extracted}  failed=${failed}  total=${rows.length}`,
  );
}

try {
  await run();
} catch (e) {
  console.error("\nFatal:", e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
