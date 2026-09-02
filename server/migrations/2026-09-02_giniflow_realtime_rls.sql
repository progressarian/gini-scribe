-- ============================================================
-- Gini Flow live updates over Supabase Realtime — the read policy.
-- 2026-09-02
--
-- docs/gini-flow/21-SUPABASE-REALTIME-PLAN.md §4.2, §4.3
--
-- WHAT THIS IS. Realtime Broadcast authorises per TOPIC through RLS on
-- `realtime.messages`. That table is not a patient table — it holds the
-- envelopes the server publishes, and Gini Flow's envelopes carry no patient
-- data by design (§4.2), so this policy's blast radius is "who may learn that
-- something changed on a given day", not "who may read a chart".
--
-- WHY NOT Postgres Changes. That route would need RLS on giniflow_visits and
-- the event tables so a browser could read those rows directly — RLS over live
-- patient data, which 00-OVERVIEW.md §2.2 refused, and it would start shipping
-- clinical values to the browser that the current envelope withholds. Broadcast
-- keeps the server as the only author.
--
-- SAFETY. `realtime.messages` already has RLS enabled with ZERO policies, so it
-- denies everything today. A policy can only widen that, and this one widens it
-- to exactly two topic shapes for tokens this server minted. Nothing is
-- revoked, no existing behaviour changes.
--
-- WRITE IS NEVER GRANTED to the browser. Every message is published by the API
-- with the service key, which is what keeps "the server can say something" from
-- becoming "anyone can say anything".
--
--   node migrations/_runOne.mjs migrations/2026-09-02_giniflow_realtime_rls.sql
-- ============================================================

DROP POLICY IF EXISTS giniflow_broadcast_read ON realtime.messages;

CREATE POLICY giniflow_broadcast_read ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    extension = 'broadcast'
    AND (
      -- A day topic. The token names the days its holder may listen to, so a
      -- screen showing 2 Sep cannot listen to 3 Sep — which is also the
      -- filtering the SSE endpoint does today with its `date` query param.
      (
        realtime.topic() LIKE 'giniflow:day:%'
        AND COALESCE(auth.jwt() -> 'giniflow_days', '[]'::jsonb)
              ? split_part(realtime.topic(), ':', 3)
      )
      -- A station topic. Any Gini Flow token may listen: a notice is addressed
      -- to a desk rather than to a patient, and carries no clinical content.
      -- `giniflow_rt` marks a token this server minted for Realtime and nothing
      -- else, so an unrelated Supabase token cannot subscribe.
      OR (
        realtime.topic() LIKE 'giniflow:station:%'
        AND COALESCE(auth.jwt() ->> 'giniflow_rt', '') = 'v1'
      )
    )
  );

COMMENT ON POLICY giniflow_broadcast_read ON realtime.messages IS
  'Gini Flow: read broadcasts on giniflow:day:<date> (token must name the day) and giniflow:station:<key>. Server-authored envelopes only; no patient data. See docs/gini-flow/21-SUPABASE-REALTIME-PLAN.md.';
