import { useEffect, useRef, useState } from "react";
import { createRealtimeConnection } from "../../lib/giniflowRealtime";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "../../services/api";
import { setLiveConnected } from "./giniflowPolling";
import { createLiveConnection } from "./giniflowLiveConnection";

// One connection per screen, not one per query.
//
// The server says a signal — "a visit moved", "a lab order changed" — and this
// decides which queries that invalidates. The data itself still comes from the
// authenticated API, so the socket never becomes a second way to read patient
// records (docs/gini-flow/12-REALTIME-PLAN.md).
//
// It degrades rather than fails: while disconnected, `live` is false and the
// callers' `refetchInterval` takes back over at 15s. It never gives up — the
// reconnect policy lives in `giniflowLiveConnection.js`, which retries with
// backoff until the connection comes back. A station tablet is open all day and
// must survive a deploy without anybody reloading the page.

const INVALIDATES = {
  visit: [
    ["giniflow", "board"],
    ["giniflow", "mo"],
    ["giniflow", "vitals"],
    ["giniflow", "reception"],
    ["giniflow", "lab"],
    ["giniflow", "pharmacy"],
    // No eventTailer stream of its own: referrals write no event table, and a
    // visit moving is the only thing that changes this list from outside (19 §10).
    ["giniflow", "referrals"],
    // Triage was missing here, so the board opened the stream, rendered a "Live"
    // badge, and was never invalidated by anything it carried — including
    // `resync`, since ALL is derived from this map. A patient checking in or
    // moving does change the board: the pipeline bar and "in building" counts
    // read `current_status`.
    //
    ["giniflow", "triage"],
  ],
  // The coordinator's own writes, from giniflow_triage_events. Its own kind
  // rather than folding into `visit`, because a categorise moves nothing on the
  // floor: invalidating the board and every station for it would be five
  // pointless refetches on a screen nobody is looking at yet.
  //
  // The floor board is the exception that earns its place — its cards carry the
  // category dot, and the consultant's chip and the MO's close rule read it.
  triage: [
    ["giniflow", "triage"],
    ["giniflow", "board"],
  ],
  lab_order: [
    ["giniflow", "reception"],
    ["giniflow", "lab"],
    ["giniflow", "mo"],
    ["giniflow", "board"],
  ],
  vitals: [
    ["giniflow", "vitals"],
    ["giniflow", "mo"],
    ["giniflow", "board"],
  ],
};

const ALL = [
  ...new Set(
    Object.values(INVALIDATES)
      .flat()
      .map((k) => k.join("/")),
  ),
].map((k) => k.split("/"));

const COALESCE_MS = 250;

export function useGiniflowLive({ date, enabled = true, paused = false } = {}) {
  const queryClient = useQueryClient();
  const [live, setLiveState] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    // EventSource does not exist during the server-side render check.
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;
    if (!localStorage.getItem("gini_auth_token")) return;

    let flushTimer = null;
    const pending = new Set();

    const setLive = (value) => {
      setLiveState(value);
      // The queue hooks read this to decide whether their poll is the only
      // thing keeping the floor current, or a slow safety net behind it.
      setLiveConnected(value);
    };

    // A patient moving fires several events in a second. Invalidating on each
    // would be a burst of identical refetches, so they collapse into one.
    const flush = () => {
      flushTimer = null;
      // Never pull the queue out from under an open form — the MO's plan
      // textarea pins its patient while it is being typed into.
      if (pausedRef.current) return;
      for (const key of pending) queryClient.invalidateQueries({ queryKey: key.split("/") });
      pending.clear();
    };

    const queue = (keys) => {
      for (const key of keys) pending.add(key.join("/"));
      if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_MS);
    };

    const connection = createLiveConnection({
      // Read on every connect, so a reconnect authenticates with the token the
      // app holds now rather than the one it held when the screen opened.
      url: ({ lastEventId }) => {
        const params = new URLSearchParams({
          token: localStorage.getItem("gini_auth_token") || "",
        });
        if (date) params.set("date", date);
        if (lastEventId) params.set("lastEventId", lastEventId);
        return `${API_URL}/api/giniflow/events?${params}`;
      },
      EventSourceImpl: EventSource,
      onSignal: ({ kind }) => queue(INVALIDATES[kind] || ALL),
      // The server could not describe the gap it left, so nothing is assumed:
      // everything is refetched.
      onResync: () => queue(ALL),
      onStatus: setLive,
    });

    connection.start();

    // Supabase Realtime, alongside SSE and not instead of it
    // (21-SUPABASE-REALTIME-PLAN.md §5, Phase 1). Both feed the same `queue()`,
    // and de-duplication is free: `pending` is a Set of query keys, so the same
    // event arriving twice inside the 250 ms window adds the same string twice
    // and invalidates once.
    //
    // It does NOT drive the live badge. While both transports run, "live" has
    // to keep meaning what the queue hooks already read it for — is anything
    // telling this screen — and SSE is still the one carrying every event.
    const realtime = createRealtimeConnection({
      date,
      onSignal: ({ kind }) => queue(INVALIDATES[kind] || ALL),
      onStatus: () => {},
    });
    realtime.start();

    // A tablet waking from sleep should not sit out the rest of its backoff.
    const onVisible = () => document.visibilityState === "visible" && connection.reconnectNow();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(flushTimer);
      connection.stop();
      realtime.stop();
    };
  }, [date, enabled, queryClient]);

  return live;
}
