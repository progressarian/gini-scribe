// ── Anthropic Message Batches queue (generic infrastructure) ────────────────
//
// Optional async path for token-heavy, latency-insensitive AI calls. Instead of
// calling the Messages API inline, callers `enqueue()` a request; a cron
// (`processBatchQueue`) submits all pending requests to Anthropic's Message
// Batches API (50% cheaper) in bulk, then polls the batches and applies each
// result through a per-job-type handler.
//
// Gated behind AI_BATCH_ENABLED=true. With the flag off, `enqueue` is never
// called (callers keep their inline behavior) and the cron is not registered.
//
// This module is intentionally domain-agnostic: it knows nothing about
// medications or appointments. The cron passes in a { jobType -> handler } map.
// Handlers live with their domain logic; see services/batch/handlers.js.

import pool from "../../config/db.js";
import { createLogger } from "../logger.js";

const { log, error } = createLogger("BatchQueue");

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
// On by default. Set AI_BATCH_ENABLED=false to disable (the emergency brake):
// any value other than the exact string "false" keeps batching enabled.
export const BATCH_ENABLED = process.env.AI_BATCH_ENABLED !== "false";

// Anthropic allows up to 100k requests per batch; we cap per submit pass so a
// huge backlog is chunked across cron runs rather than built in one giant body.
const MAX_PER_SUBMIT = 1000;
// Delete completed/failed rows older than this so the table doesn't grow forever.
const RETENTION_DAYS = 7;

function anthropicHeaders() {
  return {
    "Content-Type": "application/json",
    "x-api-key": ANTHROPIC_KEY,
    "anthropic-version": "2023-06-01",
  };
}

// ── Enqueue one request ─────────────────────────────────────────────────────
// `dedupKey` (optional) prevents re-queuing the same unit of work while a prior
// item for it is still pending/submitted.
export async function enqueue({ jobType, request, context = {}, dedupKey = null }) {
  if (!BATCH_ENABLED) return;
  try {
    if (dedupKey) {
      const { rows } = await pool.query(
        `SELECT 1 FROM ai_batch_jobs
          WHERE status IN ('pending','submitted')
            AND context->>'dedup_key' = $1
          LIMIT 1`,
        [dedupKey],
      );
      if (rows[0]) return; // already in flight
    }
    const ctx = dedupKey ? { ...context, dedup_key: dedupKey } : context;
    await pool.query(
      `INSERT INTO ai_batch_jobs (job_type, request, context)
       VALUES ($1, $2::jsonb, $3::jsonb)`,
      [jobType, JSON.stringify(request), JSON.stringify(ctx)],
    );
  } catch (e) {
    error("enqueue", e?.message || e);
  }
}

// ── Submit pass: pending rows -> one Anthropic batch ────────────────────────
async function submitPending() {
  const { rows } = await pool.query(
    `SELECT id, request FROM ai_batch_jobs
      WHERE status = 'pending'
      ORDER BY id
      LIMIT $1`,
    [MAX_PER_SUBMIT],
  );
  if (!rows.length) return;

  const requests = rows.map((r) => ({ custom_id: `job_${r.id}`, params: r.request }));
  const resp = await fetch("https://api.anthropic.com/v1/messages/batches", {
    method: "POST",
    headers: anthropicHeaders(),
    body: JSON.stringify({ requests }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    error("submit", `Anthropic ${resp.status}: ${txt.slice(0, 200)}`);
    return;
  }
  const batch = await resp.json();
  const ids = rows.map((r) => r.id);
  await pool.query(
    `UPDATE ai_batch_jobs
        SET status = 'submitted', batch_id = $1, submitted_at = NOW()
      WHERE id = ANY($2::bigint[])`,
    [batch.id, ids],
  );
  log("submit", `submitted ${ids.length} requests as batch ${batch.id}`);
}

// ── Poll pass: ended batches -> apply each result ───────────────────────────
async function pollSubmitted(handlers) {
  const { rows: batches } = await pool.query(
    `SELECT DISTINCT batch_id FROM ai_batch_jobs
      WHERE status = 'submitted' AND batch_id IS NOT NULL`,
  );
  for (const { batch_id } of batches) {
    try {
      const resp = await fetch(`https://api.anthropic.com/v1/messages/batches/${batch_id}`, {
        headers: anthropicHeaders(),
      });
      if (!resp.ok) {
        error("poll", `status ${resp.status} for batch ${batch_id}`);
        continue;
      }
      const batch = await resp.json();
      if (batch.processing_status !== "ended" || !batch.results_url) continue; // still running

      const resultsResp = await fetch(batch.results_url, { headers: anthropicHeaders() });
      if (!resultsResp.ok) {
        error("poll", `results fetch ${resultsResp.status} for batch ${batch_id}`);
        continue;
      }
      const body = await resultsResp.text();
      let applied = 0;
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry;
        try {
          entry = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const jobId = Number(String(entry.custom_id || "").replace("job_", ""));
        if (!Number.isFinite(jobId) || jobId <= 0) continue;
        await applyOne(jobId, entry.result, handlers);
        applied++;
      }
      log("poll", `batch ${batch_id} ended — applied ${applied} results`);
    } catch (e) {
      error("poll", `batch ${batch_id}: ${e?.message || e}`);
    }
  }
}

async function applyOne(jobId, result, handlers) {
  const { rows } = await pool.query(
    `SELECT job_type, context, status FROM ai_batch_jobs WHERE id = $1`,
    [jobId],
  );
  const job = rows[0];
  if (!job || job.status === "completed" || job.status === "failed") return; // idempotent

  if (result?.type !== "succeeded" || !result?.message) {
    const reason = JSON.stringify(result?.error || result?.type || "unknown").slice(0, 500);
    await pool.query(
      `UPDATE ai_batch_jobs SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
      [jobId, reason],
    );
    return;
  }

  const handler = handlers[job.job_type];
  if (typeof handler !== "function") {
    await pool.query(
      `UPDATE ai_batch_jobs SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
      [jobId, `no handler for job_type ${job.job_type}`],
    );
    return;
  }

  try {
    await handler(job.context, result.message);
    await pool.query(
      `UPDATE ai_batch_jobs
          SET status = 'completed', result = $2::jsonb, completed_at = NOW()
        WHERE id = $1`,
      [jobId, JSON.stringify({ usage: result.message.usage || null })],
    );
  } catch (e) {
    await pool.query(
      `UPDATE ai_batch_jobs SET status = 'failed', error = $2, completed_at = NOW() WHERE id = $1`,
      [jobId, String(e?.message || e).slice(0, 500)],
    );
  }
}

async function cleanupOld() {
  try {
    await pool.query(
      `DELETE FROM ai_batch_jobs
        WHERE status IN ('completed','failed')
          AND completed_at < NOW() - ($1 || ' days')::interval`,
      [String(RETENTION_DAYS)],
    );
  } catch (e) {
    error("cleanup", e?.message || e);
  }
}

let inFlight = false;

// ── Cron entry point: submit pending + poll submitted ───────────────────────
export async function processBatchQueue(handlers) {
  if (!BATCH_ENABLED || !ANTHROPIC_KEY) return;
  if (inFlight) return; // never overlap runs
  inFlight = true;
  try {
    await submitPending();
    await pollSubmitted(handlers);
    await cleanupOld();
  } catch (e) {
    error("process", e?.message || e);
  } finally {
    inFlight = false;
  }
}
