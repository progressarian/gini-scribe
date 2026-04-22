// Reaper for document upload/extraction edge cases.
//
// Two failure modes show up as stuck rows in the documents table:
//
//   (a) "Orphan" — the patients/:id/documents POST succeeded (row created
//       with extraction_status: "pending") but /upload-file never finished
//       because the user refreshed mid-upload. The row has no storage_path
//       and no file_url, so retry would fail and the UI would show a
//       permanent ghost "Extracting…" pill. We delete these.
//
//   (b) "Pending-with-file" — the file uploaded cleanly but extraction
//       never got triggered (server restarted mid-upload-file, or the
//       background runServerExtraction promise was dropped). We re-kick
//       extraction via the same runServerExtraction helper /retry-extract
//       uses. The helper's skipIfNotPending check keeps us safe even if
//       another run already started.
//
// Runs every 3 minutes. Grace window is 3 min for orphans and 2 min for
// stuck-with-file so in-flight uploads/extractions aren't disturbed.

import pool from "../../config/db.js";
import { runServerExtraction } from "../../routes/documents.js";

const ORPHAN_GRACE_MIN = 3;
const STUCK_GRACE_MIN = 2;

export async function runDocumentRecovery() {
  let orphansDeleted = 0;
  let stuckKickedOff = 0;

  try {
    // (a) Delete orphan pending docs with no file attached, older than the
    // grace window. "has no file" = no storage_path AND no file_url. We
    // also drop any lab_results/medications tied to them (document_id FK)
    // though those should be empty since extraction never ran.
    const { rows: orphans } = await pool.query(
      `SELECT id FROM documents
       WHERE extracted_data->>'extraction_status' = 'pending'
         AND COALESCE(storage_path, '') = ''
         AND COALESCE(file_url, '') = ''
         AND created_at < NOW() - INTERVAL '${ORPHAN_GRACE_MIN} minutes'`,
    );
    for (const { id } of orphans) {
      try {
        await pool.query(`DELETE FROM lab_results WHERE document_id = $1`, [id]);
        await pool.query(`DELETE FROM medications WHERE document_id = $1`, [id]);
        await pool.query(`DELETE FROM documents WHERE id = $1`, [id]);
        orphansDeleted += 1;
      } catch (e) {
        console.error(`[DocRecovery] Failed to delete orphan doc ${id}:`, e.message);
      }
    }

    // (b) Re-kick extraction for docs stuck on pending that DO have a file.
    // Almost always a dropped fire-and-forget promise from /upload-file.
    const { rows: stuck } = await pool.query(
      `SELECT id FROM documents
       WHERE extracted_data->>'extraction_status' = 'pending'
         AND (COALESCE(storage_path, '') <> '' OR COALESCE(file_url, '') <> '')
         AND created_at < NOW() - INTERVAL '${STUCK_GRACE_MIN} minutes'
       LIMIT 20`,
    );
    for (const { id } of stuck) {
      try {
        // skipIfNotPending=false: by the time cron picks them up, the
        // pending-ness is established. If client finishes between read
        // and extraction start, runServerExtraction's own inner re-check
        // still dedups before writing.
        const result = await runServerExtraction(id, { skipIfNotPending: true });
        if (result?.skipped) continue;
        stuckKickedOff += 1;
      } catch (e) {
        console.error(`[DocRecovery] Failed to kick extraction for doc ${id}:`, e.message);
      }
    }

    if (orphansDeleted || stuckKickedOff) {
      console.log(`[DocRecovery] orphans=${orphansDeleted} stuck-kicked=${stuckKickedOff}`);
    }
  } catch (e) {
    console.error("[DocRecovery] Run failed:", e.message);
  }

  return { orphansDeleted, stuckKickedOff };
}
