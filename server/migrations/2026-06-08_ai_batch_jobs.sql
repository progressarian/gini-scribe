-- Async AI Batch API queue.
--
-- Backs the optional Anthropic Message Batches path (50% cheaper than real-time,
-- asynchronous — results land within ~1h). One row per model request. A single
-- cron (processBatchQueue) submits 'pending' rows in bulk, then polls the
-- submitted batches and applies each result via a per-job-type handler.
--
-- This is gated behind the AI_BATCH_ENABLED=true env flag. With the flag off,
-- nothing writes to this table and the app behaves exactly as before.
--
-- Apply via the Supabase SQL editor (this project has no direct DDL access).
--
-- job_type:
--   'med_side_effects' -> writes medications.common_side_effects
--   'healthray_parse'  -> daily OPD backfill: writes appointments JSONB + normalizes
--
-- Lifecycle: pending -> submitted -> (completed | failed)

CREATE TABLE IF NOT EXISTS ai_batch_jobs (
  id            BIGSERIAL PRIMARY KEY,
  job_type      TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  batch_id      TEXT,                                  -- Anthropic batch id (set on submit)
  request       JSONB NOT NULL,                        -- Messages API params for this item
  context       JSONB NOT NULL DEFAULT '{}'::jsonb,    -- keys needed to apply the result
  result        JSONB,                                 -- usage / metadata once completed
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  submitted_at  TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

-- Fast lookups for the submit pass (pending) and poll pass (submitted).
CREATE INDEX IF NOT EXISTS ai_batch_jobs_status_type_idx
  ON ai_batch_jobs (status, job_type);

CREATE INDEX IF NOT EXISTS ai_batch_jobs_batch_id_idx
  ON ai_batch_jobs (batch_id) WHERE batch_id IS NOT NULL;

-- Dedup support: enqueue checks context->>'dedup_key' for an in-flight item.
CREATE INDEX IF NOT EXISTS ai_batch_jobs_dedup_idx
  ON ai_batch_jobs ((context->>'dedup_key'))
  WHERE status IN ('pending', 'submitted');
