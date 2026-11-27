import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BILLING_REQUESTS_STATION, createRealtimeConnection } from "../../lib/giniflowRealtime";
import { BILLING_REQUEST_KEYS } from "./useGiniflowLive";
import { REPORT_RELEASE_KEY } from "./useReportReleases";
import { REPORT_RELEASE_KIND } from "../../../shared/reportRelease.js";

const LIVE_KEYS = [...BILLING_REQUEST_KEYS, REPORT_RELEASE_KEY];
const LIVE_KINDS = ["billing_request", REPORT_RELEASE_KIND];

export default function useDeskRequestsLive(enabled = true) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;
    if (!localStorage.getItem("gini_auth_token")) return undefined;
    const connection = createRealtimeConnection({
      station: BILLING_REQUESTS_STATION,
      onSignal: ({ kind }) => {
        if (!LIVE_KINDS.includes(kind)) return;
        for (const queryKey of LIVE_KEYS) queryClient.invalidateQueries({ queryKey });
      },
      onStatus: () => {},
    });
    connection.start();
    return () => connection.stop();
  }, [enabled, queryClient]);
}
