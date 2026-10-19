import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BILLING_REQUESTS_STATION, createRealtimeConnection } from "../../lib/giniflowRealtime";
import { BILLING_REQUEST_KEYS } from "./useGiniflowLive";

export default function useDeskRequestsLive(enabled = true) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;
    if (!localStorage.getItem("gini_auth_token")) return undefined;
    const connection = createRealtimeConnection({
      station: BILLING_REQUESTS_STATION,
      onSignal: ({ kind }) => {
        if (kind !== "billing_request") return;
        for (const queryKey of BILLING_REQUEST_KEYS) queryClient.invalidateQueries({ queryKey });
      },
      onStatus: () => {},
    });
    connection.start();
    return () => connection.stop();
  }, [enabled, queryClient]);
}
