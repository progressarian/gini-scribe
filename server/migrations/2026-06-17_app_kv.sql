-- ============================================================
-- Generic key-value store for small cross-process runtime state.
-- 2026-06-17
--
-- Motivation: the HealthRay sync runs in TWO node processes (API + worker),
-- each with its own in-memory auth state. During a login failure that means
-- two independent retry loops hammering HealthRay's web login — which trips
-- its WAF into a 403 IP-block (a vicious loop: 403 -> no session -> re-login
-- -> 403). Persisting the session cookie and a shared login-cooldown here lets
-- both processes (and restarts) REUSE one session and honour ONE cooldown, so
-- login happens a handful of times a day instead of in a burst. Keeps the
-- server under HealthRay's rate threshold.
--
-- Generic on purpose (not healthray-specific) so other small runtime flags can
-- reuse it. Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS app_kv (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
