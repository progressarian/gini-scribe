import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "../../services/api";
import { createLiveConnection } from "./giniflowLiveConnection";

const COALESCE_MS = 250;
const DROP_GRACE_MS = 8000;

const ROW_KEYS = [
  ["ghm", "list"],
  ["ghm", "obt-assignments"],
  ["ghm", "attempt-counts"],
  ["ghm", "active-calls"],
  ["ghm", "call-attempts"],
  ["ghm", "call-sessions"],
  ["ghm", "changes"],
  ["ghm", "slot-counts"],
  ["ghm", "category-counts"],
  ["ghm", "status-changes"],
  ["ghm", "conflicts"],
  ["ghm", "availability"],
];

export function useGhmLive({ enabled = true, paused = false } = {}) {
  const queryClient = useQueryClient();
  const [live, setLiveState] = useState(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const waitingRef = useRef(false);

  useEffect(() => {
    if (!paused && waitingRef.current) {
      waitingRef.current = false;
      for (const key of ROW_KEYS) queryClient.invalidateQueries({ queryKey: key });
    }
  }, [paused, queryClient]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;
    if (!localStorage.getItem("gini_auth_token")) return;

    let flushTimer = null;
    let dropTimer = null;

    const setLive = (value) => {
      clearTimeout(dropTimer);
      dropTimer = null;
      if (value) {
        setLiveState(true);
        return;
      }
      dropTimer = setTimeout(() => {
        dropTimer = null;
        setLiveState(false);
      }, DROP_GRACE_MS);
    };

    const flush = () => {
      flushTimer = null;
      if (pausedRef.current) {
        waitingRef.current = true;
        return;
      }
      for (const key of ROW_KEYS) queryClient.invalidateQueries({ queryKey: key });
    };

    const queue = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, COALESCE_MS);
    };

    const connection = createLiveConnection({
      url: ({ lastEventId }) => {
        const params = new URLSearchParams({
          token: localStorage.getItem("gini_auth_token") || "",
        });
        if (lastEventId) params.set("lastEventId", lastEventId);
        return `${API_URL}/api/ghm-live/events?${params}`;
      },
      EventSourceImpl: EventSource,
      eventName: "ghm",
      onSignal: queue,
      onResync: queue,
      onStatus: setLive,
    });
    connection.start();

    const onVisible = () => document.visibilityState === "visible" && connection.reconnectNow();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(flushTimer);
      clearTimeout(dropTimer);
      connection.stop();
    };
  }, [enabled, queryClient]);

  return live;
}
