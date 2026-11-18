import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { API_URL } from "../../services/api";
import { createLiveConnection } from "./giniflowLiveConnection";
import { billKeys } from "./usePharmacyBills";
import { creditKeys } from "./usePharmacyCredit";

const COALESCE_MS = 200;

export function usePharmacyLive({ billId = null, enabled = true } = {}) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(null);
  const billRef = useRef(billId);
  billRef.current = billId;

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;
    if (!localStorage.getItem("gini_auth_token")) return;

    let timer = null;
    const bills = new Set();
    let everything = false;

    const flush = () => {
      timer = null;
      const watched = billRef.current ? String(billRef.current) : null;
      if (watched && (everything || bills.has(watched))) {
        queryClient.invalidateQueries({ queryKey: billKeys.one(watched) });
      }
      queryClient.invalidateQueries({ queryKey: creditKeys.all });
      queryClient.invalidateQueries({ queryKey: [...billKeys.all, "list"] });
      bills.clear();
      everything = false;
    };

    const queue = (signal) => {
      if (signal?.billId) bills.add(String(signal.billId));
      else everything = true;
      if (!timer) timer = setTimeout(flush, COALESCE_MS);
    };

    const connection = createLiveConnection({
      url: ({ lastEventId }) => {
        const params = new URLSearchParams({
          token: localStorage.getItem("gini_auth_token") || "",
        });
        if (lastEventId) params.set("lastEventId", lastEventId);
        return `${API_URL}/api/pharmacy/live/events?${params}`;
      },
      EventSourceImpl: EventSource,
      eventName: "pharmacy",
      onSignal: queue,
      onResync: () => queue(null),
      onStatus: setLive,
    });
    connection.start();

    const onVisible = () => document.visibilityState === "visible" && connection.reconnectNow();
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(timer);
      connection.stop();
    };
  }, [enabled, queryClient]);

  return live;
}
