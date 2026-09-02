import { createClient } from "@supabase/supabase-js";
import api from "../services/api";

// The browser half of Supabase Realtime for Gini Flow.
//
// docs/gini-flow/21-SUPABASE-REALTIME-PLAN.md §4.2, §4.3
//
// Broadcast, so nothing here reads a table: the server publishes envelopes and
// this listens. The RLS policy on `realtime.messages` decides which topics a
// token may hear (migration 2026-09-02_giniflow_realtime_rls.sql).
//
// NOT Supabase Auth. The token comes from our own API, which mints it against a
// live `auth_sessions` row and signs it with the project's JWT secret. That is
// what lets a browser talk to Realtime without this app adopting a second auth
// system — and why the token is short and has no refresh: the client comes back
// to the API, where a revoked login is noticed.
//
// UNCONFIGURED IS SILENT. Phase 1 runs both transports and SSE carries every
// event, so a server with no keys set answers `{ enabled: false }` and this
// returns a no-op. A screen must not break because the newer path is off.

// Re-ask before the hour is up. Ten minutes of slack covers a laptop that slept
// through the boundary and woke with a token about to die.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export function createRealtimeConnection({ date, station, onSignal, onNotice, onStatus }) {
  let client = null;
  let channels = [];
  let refreshTimer = null;
  let stopped = false;

  const teardown = () => {
    clearTimeout(refreshTimer);
    refreshTimer = null;
    for (const ch of channels) {
      try {
        client?.removeChannel(ch);
      } catch {
        /* a channel already gone is not a problem worth reporting */
      }
    }
    channels = [];
  };

  const start = async () => {
    if (stopped) return;
    let cfg;
    try {
      cfg = (await api.get("/api/giniflow/realtime-token")).data;
    } catch {
      // The API is unreachable or the capability was withdrawn. SSE and the
      // poll are still there; say nothing and stay off.
      onStatus?.(false);
      return;
    }
    if (stopped || !cfg?.enabled || !cfg.token || !cfg.url || !cfg.anonKey) {
      onStatus?.(false);
      return;
    }

    if (!client) {
      client = createClient(cfg.url, cfg.anonKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
    // The token is what the RLS policy reads. Set before subscribing, and again
    // on every refresh, or the socket keeps authenticating as the old one.
    await client.realtime.setAuth(cfg.token);

    const topics = [
      date && `giniflow:day:${date}`,
      station && `giniflow:station:${station}`,
    ].filter(Boolean);

    channels = topics.map((topic) => {
      const ch = client.channel(topic, { config: { private: true } });
      ch.on("broadcast", { event: "giniflow" }, ({ payload }) => {
        if (!payload) return;
        if (payload.kind === "notice") onNotice?.(payload);
        else onSignal?.(payload);
      }).subscribe((status) => {
        // Only the day topic decides the badge. A station topic is a bonus
        // channel; its state should not make the screen claim to be offline.
        if (topic.startsWith("giniflow:day:")) onStatus?.(status === "SUBSCRIBED");
      });
      return ch;
    });

    const ttlMs = (cfg.expiresIn || 3600) * 1000;
    refreshTimer = setTimeout(
      () => {
        teardown();
        start();
      },
      Math.max(60_000, ttlMs - REFRESH_MARGIN_MS),
    );
  };

  return {
    start,
    stop: () => {
      stopped = true;
      teardown();
      try {
        client?.removeAllChannels();
      } catch {
        /* nothing to clean up */
      }
      client = null;
    },
  };
}
