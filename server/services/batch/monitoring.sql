-- ── AI batch queue monitoring ───────────────────────────────────────────────
-- Ad-hoc queries for inspecting the ai_batch_jobs table (see
-- migrations/2026-06-08_ai_batch_jobs.sql). Run any block in the Supabase SQL
-- editor. None of these mutate data except the clearly-labelled requeue helper
-- at the bottom.
--
-- Lifecycle reminder: pending -> submitted -> (completed | failed)

-- 1) Health snapshot: counts by status + job type, with queue age.
--    Watch `pending` (waiting for next submit pass) and `submitted` (in flight
--    at Anthropic, applies within ~1h).
SELECT
  job_type,
  status,
  COUNT(*)                                              AS n,
  MIN(created_at)                                       AS oldest_created,
  ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/60) AS oldest_age_min
FROM ai_batch_jobs
GROUP BY job_type, status
ORDER BY job_type, status;

-- 2) Queue lag: oldest pending item per job type. If this climbs past ~5–10 min
--    the submit pass (every 5 min) may be failing — check worker logs.
SELECT
  job_type,
  COUNT(*)                                              AS pending,
  MIN(created_at)                                       AS oldest_pending,
  ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))/60) AS lag_min
FROM ai_batch_jobs
WHERE status = 'pending'
GROUP BY job_type
ORDER BY lag_min DESC;

-- 3) In-flight batches: one row per submitted Anthropic batch, with age.
--    A batch normally ends within ~1h. Anything much older than that is stuck —
--    confirm the poll pass is running and the batch_id still exists at Anthropic.
SELECT
  batch_id,
  COUNT(*)                                                AS items,
  MIN(submitted_at)                                       AS submitted_at,
  ROUND(EXTRACT(EPOCH FROM (NOW() - MIN(submitted_at)))/60) AS age_min
FROM ai_batch_jobs
WHERE status = 'submitted'
GROUP BY batch_id
ORDER BY submitted_at;

-- 4) Recent failures: most recent errored items + their reason.
SELECT id, job_type, error, submitted_at, completed_at
FROM ai_batch_jobs
WHERE status = 'failed'
ORDER BY completed_at DESC NULLS LAST
LIMIT 50;

-- 5) Throughput + token usage over the last 24h (completed only).
--    `result` stores { usage: {...} } captured at apply time.
SELECT
  job_type,
  COUNT(*)                                                       AS completed,
  SUM((result->'usage'->>'input_tokens')::bigint)               AS input_tokens,
  SUM((result->'usage'->>'output_tokens')::bigint)              AS output_tokens,
  SUM((result->'usage'->>'cache_read_input_tokens')::bigint)    AS cache_read_tokens
FROM ai_batch_jobs
WHERE status = 'completed'
  AND completed_at > NOW() - INTERVAL '24 hours'
GROUP BY job_type
ORDER BY job_type;

-- 6) End-to-end latency of completed items (enqueue -> applied), last 24h.
--    Sanity-check the "~1h" expectation; p50/p95 in minutes.
SELECT
  job_type,
  COUNT(*)                                                                    AS n,
  ROUND(PERCENTILE_CONT(0.5)  WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at))/60)) AS p50_min,
  ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at))/60)) AS p95_min
FROM ai_batch_jobs
WHERE status = 'completed'
  AND completed_at > NOW() - INTERVAL '24 hours'
GROUP BY job_type;

-- 7) Stuck detector: submitted items older than 2h (batches should end <1h).
SELECT id, job_type, batch_id, submitted_at,
       ROUND(EXTRACT(EPOCH FROM (NOW() - submitted_at))/60) AS age_min
FROM ai_batch_jobs
WHERE status = 'submitted'
  AND submitted_at < NOW() - INTERVAL '2 hours'
ORDER BY submitted_at;

-- 8) healthray_parse breakdown by origin — how many parses came from the
--    day-before (source='sheets' imports, origin='day_before') path vs the
--    once-a-day catch-up (origin='daily_backfill'). Only these two callers opt
--    into batching; same-day walk-in / GHM inserts parse inline and never appear
--    here. (Rows enqueued before the origin tag was added show as 'unknown'.)
SELECT
  COALESCE(context->>'origin', 'unknown') AS origin,
  status,
  COUNT(*)                                AS n
FROM ai_batch_jobs
WHERE job_type = 'healthray_parse'
GROUP BY origin, status
ORDER BY origin, status;

-- ── Manual recovery (MUTATES — use deliberately) ────────────────────────────
-- Requeue a stuck batch: flip its items back to 'pending' so the next submit
-- pass resends them as a fresh batch. Safe because apply is idempotent and the
-- originating job (side-effects dedup / opd_backfilled_at) guards double-writes.
-- Replace the batch_id first.
--
-- UPDATE ai_batch_jobs
--    SET status = 'pending', batch_id = NULL, submitted_at = NULL
--  WHERE status = 'submitted' AND batch_id = '<batch_id>';
