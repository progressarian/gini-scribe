// Document classification sweeper.
//
// HealthRay hands us a lot of reports under record_type "Other" with an
// auto-generated filename ("other_<doctor>_<timestamp>_<rand>.pdf"), so
// mapRecordType() has nothing to go on and files them as doc_type='other'.
// Real ABI Doppler and VPT/biothesiometry studies end up invisible in the
// Labs tab's ABI/VPT buckets as a result.
//
// This sweep reads the actual file and re-types those rows. It covers both
// cases with one mechanism:
//   • new syncs — a freshly-inserted 'other' doc gets picked up on the next run
//   • the backfill — server/scripts/backfill-doc-classification.js just calls
//     this in a loop until the queue drains
//
// ── Why there is no cron advisory lock here ──────────────────────────────
// The other cron families gate on session-scoped pg_try_advisory_lock, which
// strands under our transaction-mode Supavisor pooler (the "still holds its
// lock" spam) — and the single-transaction alternative (withCronXactLock)
// is a bad fit for a sweep that spends minutes on network I/O. Instead, work
// is claimed atomically per row with FOR UPDATE SKIP LOCKED: concurrent
// runners take disjoint sets and no cross-run lock is needed.
//
// Row state lives in the `notes` column as an `autoclass:` marker:
//   autoclass:claimed:<iso>       — in progress; reclaimable after STALE_CLAIM
//   autoclass:<doc_type>:<conf>   — done; never looked at again
// That marker is also the not-yet-processed filter, which makes the sweep
// idempotent and stops it re-billing the same document forever — including
// documents the classifier itself judged 'other'.

import pool from "../../config/db.js";
import { classifyDocumentFile } from "../documentClassifier.js";
import { detectMediaType } from "../extraction.js";

const DEFAULT_BATCH = Number(process.env.DOC_CLASSIFY_BATCH || 40);
const CONCURRENCY = Number(process.env.DOC_CLASSIFY_CONCURRENCY || 4);

// A claim older than this is assumed to belong to a crashed run and is
// retaken. Comfortably above the worst-case per-doc time (HealthRay download
// + 3 classifier attempts at a 60s timeout).
const STALE_CLAIM = "30 minutes";

// Some HealthRay documents simply cannot be fetched: they carry neither a
// `healthray_mrid` nor an appointment whose records list still contains them,
// so every download path in resolveDocumentUrl dead-ends. Retrying those on
// the normal cadence would hammer HealthRay forever for files that will never
// arrive — the exact request volume its WAF 403-blocks us for. So an
// unavailable doc is parked with an `autoclass:unavail:<iso>` marker and only
// reconsidered after this window, in case the file is backfilled later.
const UNAVAIL_RETRY = "7 days";

// Shared by the claim query and the pending count so the two can never drift.
const ELIGIBLE_SQL = `
  source = 'healthray'
  AND doc_type = 'other'
  AND (COALESCE(storage_path, '') <> '' OR COALESCE(file_url, '') <> '')
  AND (
    COALESCE(notes, '') NOT LIKE '%autoclass:%'
    OR (
      -- Only a *claim* is reclaimable. A final autoclass:<type>:<conf> marker
      -- means this document is done and must never be picked up (or re-billed)
      -- again — including one the classifier itself judged 'other'.
      notes LIKE '%autoclass:claimed:%'
      AND COALESCE(
            substring(notes from 'autoclass:claimed:([0-9T:.+-]+Z)')::timestamptz,
            'epoch'::timestamptz
          ) < NOW() - INTERVAL '${STALE_CLAIM}'
    )
    OR (
      -- Parked as unfetchable; reconsider only after the backoff window.
      notes LIKE '%autoclass:unavail:%'
      AND COALESCE(
            substring(notes from 'autoclass:unavail:([0-9T:.+-]+Z)')::timestamptz,
            'epoch'::timestamptz
          ) < NOW() - INTERVAL '${UNAVAIL_RETRY}'
    )
  )`;

// Where the file has to come from. Documents already cached in Supabase are
// free to fetch; the rest need a HealthRay download, and HealthRay's WAF
// treats bulk download volume from our IP as scraping and 403-blocks it
// (which also takes out the live OPD sync). Splitting on this lets the
// backfill clear the safe pile first and pace the rest.
const SOURCE_FILTERS = {
  all: "",
  supabase: "AND COALESCE(storage_path, '') <> ''",
  healthray: "AND COALESCE(storage_path, '') = ''",
};

let inFlight = false;

function log(msg) {
  console.log(`[DocClassify] ${msg}`);
}

function sourceFilter(source) {
  const f = SOURCE_FILTERS[source || "all"];
  if (f === undefined) throw new Error(`Unknown source filter "${source}"`);
  return f;
}

/**
 * Atomically claim up to `limit` eligible rows and stamp them in-progress.
 * SKIP LOCKED means two concurrent runners never hand the same document to
 * the classifier (and never double-bill it).
 */
async function claimCandidates({ limit, patientId, source }) {
  const params = [limit];
  let patientFilter = "";
  if (patientId) {
    params.push(patientId);
    patientFilter = `AND patient_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `WITH picked AS (
       SELECT id
         FROM documents
        WHERE ${ELIGIBLE_SQL}
          ${patientFilter}
          ${sourceFilter(source)}
        ORDER BY created_at DESC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE documents d
        SET notes = CONCAT_WS('|',
              NULLIF(regexp_replace(COALESCE(d.notes, ''), '\\|?autoclass:[^|]*', '', 'g'), ''),
              'autoclass:claimed:' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
       FROM picked
      WHERE d.id = picked.id
      RETURNING d.id, d.notes, d.file_name`,
    params,
  );
  return rows;
}

/** Count how much work is left — used by the backfill script for progress. */
export async function countPendingClassification(patientId = null, source = "all") {
  const params = [];
  let patientFilter = "";
  if (patientId) {
    params.push(patientId);
    patientFilter = `AND patient_id = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM documents
      WHERE ${ELIGIBLE_SQL} ${patientFilter} ${sourceFilter(source)}`,
    params,
  );
  return rows[0]?.n || 0;
}

/**
 * Clear the final marker from rows the classifier settled as 'other', making
 * them eligible again. Only needed when the taxonomy gains a category that
 * would have caught them — e.g. adding the "eye" type, which reclaims the
 * fundus / diabetic-retinopathy reports previously binned as 'other'.
 * Returns the number of rows reopened. Costs one classifier call per row on
 * the next sweep, so call it deliberately, not on a schedule.
 */
export async function resetOtherMarkers(patientId = null, source = "all") {
  const params = [];
  let patientFilter = "";
  if (patientId) {
    params.push(patientId);
    patientFilter = `AND patient_id = $${params.length}`;
  }
  const { rowCount } = await pool.query(
    `UPDATE documents
        SET notes = NULLIF(regexp_replace(COALESCE(notes, ''), '\\|?autoclass:other:[^|]*', '', 'g'), '')
      WHERE source = 'healthray'
        AND doc_type = 'other'
        AND notes LIKE '%autoclass:other:%'
        ${patientFilter} ${sourceFilter(source)}`,
    params,
  );
  return rowCount;
}

/** Replace whatever autoclass marker a row carries with `marker` (or none). */
function markedNotes(existing, marker) {
  const base = (existing || "").replace(/\|?autoclass:[^|]*/g, "");
  return [base, marker].filter(Boolean).join("|") || null;
}

async function setNotes(docId, notes, docType) {
  if (docType) {
    await pool.query(`UPDATE documents SET doc_type = $1, notes = $2 WHERE id = $3`, [
      docType,
      notes,
      docId,
    ]);
  } else {
    await pool.query(`UPDATE documents SET notes = $1 WHERE id = $2`, [notes, docId]);
  }
}

/**
 * Drop the claim so a failed doc is retried on the next sweep. Strips only
 * the `claimed:` marker — a final marker written by a concurrent path must
 * survive, or the document becomes eligible again and gets re-billed.
 */
async function releaseClaim(doc) {
  const notes = (doc.notes || "").replace(/\|?autoclass:claimed:[^|]*/g, "") || null;
  await pool
    .query(`UPDATE documents SET notes = $1 WHERE id = $2`, [notes, doc.id])
    .catch(() => {});
}

/**
 * Park a document whose file could not be fetched. Unlike releaseClaim this
 * leaves a dated marker, so the doc drops out of the queue for UNAVAIL_RETRY
 * instead of coming back on the very next sweep. Without it, the ~4.4k
 * HealthRay docs that have no resolvable download path (no `healthray_mrid`
 * and no appointment whose record list still holds them) would be re-requested
 * every 10 minutes forever — pointless load, and exactly the request volume
 * that gets our IP WAF-blocked.
 */
async function parkUnavailable(doc) {
  const marker = `autoclass:unavail:${new Date().toISOString()}`;
  await pool
    .query(`UPDATE documents SET notes = $1 WHERE id = $2`, [
      markedNotes(doc.notes, marker),
      doc.id,
    ])
    .catch(() => {});
}

async function classifyOne(doc, { dryRun }) {
  // Imported lazily: documents.js pulls in a large dependency graph (HealthRay
  // client, storage config, med normalisation) and importing it at module load
  // would drag all of that into the cron boot path.
  const { resolveDocumentUrl } = await import("../../routes/documents.js");

  const resolved = await resolveDocumentUrl(doc.id).catch((e) => ({ error: e.message }));
  if (!resolved || resolved.error) {
    return { id: doc.id, status: "unavailable", detail: resolved?.error || "resolve failed" };
  }

  let buffer;
  if (resolved.buffer) {
    buffer = resolved.buffer;
  } else if (resolved.url) {
    const r = await fetch(resolved.url).catch(() => null);
    if (!r || !r.ok) {
      return {
        id: doc.id,
        status: "unavailable",
        detail: `download failed (${r?.status || "no response"})`,
      };
    }
    buffer = Buffer.from(await r.arrayBuffer());
  } else {
    return { id: doc.id, status: "unavailable", detail: "no file attached" };
  }

  const mediaType = detectMediaType(buffer) || resolved.mimeType || "application/pdf";
  const base64 = Buffer.from(buffer).toString("base64");

  const { data, error } = await classifyDocumentFile({ base64, mediaType });
  if (error || !data) return { id: doc.id, status: "error", detail: error };

  if (dryRun) {
    return { id: doc.id, status: "dry-run", type: data.doc_type, detail: data.rationale };
  }

  const marker = `autoclass:${data.doc_type}:${data.confidence.toFixed(2)}`;

  // Low-confidence calls stay in 'other' but are still marked, so we don't pay
  // to re-ask a question the model already couldn't answer.
  if (data.doc_type !== "other" && data.confidence >= 0.6) {
    await setNotes(doc.id, markedNotes(doc.notes, marker), data.doc_type);
    return { id: doc.id, status: "retyped", type: data.doc_type, detail: data.rationale };
  }

  await setNotes(doc.id, markedNotes(doc.notes, marker), null);
  return { id: doc.id, status: "kept-other", type: "other", detail: data.rationale };
}

/**
 * One sweep. Returns a summary; never throws.
 *
 * @param {object}  opts
 * @param {number}  opts.limit      max docs this run (default DOC_CLASSIFY_BATCH)
 * @param {number}  opts.patientId  restrict to one patient (for targeted fixes)
 * @param {boolean} opts.dryRun     classify + report, write no doc_type change
 * @param {string}  opts.source     'all' | 'supabase' | 'healthray' — restrict
 *                                  by where the file has to be fetched from
 */
export async function runDocumentClassification(opts = {}) {
  const { limit = DEFAULT_BATCH, patientId = null, dryRun = false, source = "all" } = opts;

  if (inFlight) return { skippedRun: true, reason: "already running in this process" };
  inFlight = true;

  const summary = { total: 0, retyped: 0, keptOther: 0, unavailable: 0, errors: 0, byType: {} };

  try {
    const docs = await claimCandidates({ limit, patientId, source });
    summary.total = docs.length;
    if (docs.length === 0) return summary;

    log(`Classifying ${docs.length} HealthRay 'other' document(s)...`);

    const queue = [...docs];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const doc = queue.shift();
        try {
          const r = await classifyOne(doc, { dryRun });
          if (r.status === "retyped" || r.status === "dry-run") {
            if (r.status === "retyped") summary.retyped += 1;
            summary.byType[r.type] = (summary.byType[r.type] || 0) + 1;
            log(`doc ${r.id} → ${r.type} — ${r.detail}`);
            // A dry run must not keep the claim, or the row looks in-progress
            // for STALE_CLAIM and a real run would skip it.
            if (r.status === "dry-run") await releaseClaim(doc);
          } else if (r.status === "kept-other") {
            summary.keptOther += 1;
          } else {
            if (r.status === "unavailable") {
              // No download path resolved. Park it with a backoff rather than
              // releasing it, or we re-request an un-fetchable file forever.
              await parkUnavailable(doc);
              summary.unavailable += 1;
              log(`doc ${r.id} parked (unfetchable) — ${r.detail}`);
            } else {
              // A transient classifier/API failure: release so the next sweep
              // retries promptly rather than freezing the row as 'other'.
              await releaseClaim(doc);
              summary.errors += 1;
              log(`doc ${r.id} failed — ${r.detail}`);
            }
          }
        } catch (e) {
          summary.errors += 1;
          await releaseClaim(doc);
          log(`doc ${doc.id} threw — ${e.message}`);
        }
      }
    });
    await Promise.all(workers);

    log(
      `Done: ${summary.retyped} retyped, ${summary.keptOther} kept as other, ` +
        `${summary.unavailable} unavailable, ${summary.errors} errors`,
    );
    return summary;
  } catch (e) {
    console.error(`[DocClassify] Sweep failed: ${e.message}`);
    summary.errors += 1;
    return summary;
  } finally {
    inFlight = false;
  }
}
