-- 2026-05-14 — Dr. Gini AI agent conversation threads
--
-- One row per ongoing Genie chat thread. The patient app only sends the
-- latest user message + a conversation_id; the server hydrates the thread,
-- runs the tools loop, and persists the updated thread back.
--
-- Rolling-checkpoint design: messages older than the live window get
-- compressed into `checkpoint_summary` (LLM-written, refreshed lazily) so
-- per-turn token cost stays bounded as the chat grows.
--
-- Storage: scribe Postgres (Supabase project vuukipgdegewpwucdgxa).
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS agent_conversations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id          INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,

  -- Live tail of the conversation in Anthropic Messages API shape:
  -- [{role:'user'|'assistant', content: string | block[]}, ...]
  -- Only messages that haven't been folded into `checkpoint_summary` live here.
  messages            JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Rolling summary of everything that was rotated out of `messages`.
  -- Sent to the model as a system-prefix on each turn so it still has
  -- earlier context (preferences, things the patient told us about, prior
  -- decisions) without paying for the full history.
  checkpoint_summary  TEXT,
  -- How many *original* user+assistant turns the current summary covers.
  -- Lets us decide when to refresh the summary again.
  summary_covers_n    INTEGER NOT NULL DEFAULT 0,

  total_turns         INTEGER NOT NULL DEFAULT 0,
  last_message_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_patient
  ON agent_conversations (patient_id, last_message_at DESC);

-- Auto-bump updated_at on UPDATE. Mirrors the existing
-- trg_consultations_updated pattern (see schema.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_agent_conversations_updated'
  ) THEN
    CREATE TRIGGER trg_agent_conversations_updated
      BEFORE UPDATE ON agent_conversations
      FOR EACH ROW EXECUTE FUNCTION update_timestamp();
  END IF;
END$$;
