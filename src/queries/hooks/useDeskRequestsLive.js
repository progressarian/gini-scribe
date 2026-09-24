import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createRealtimeConnection } from "../../lib/giniflowRealtime";
import { billingKeys } from "./useBillingMaster";

export default function useDeskRequestsLive() {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!localStorage.getItem("gini_auth_token")) return undefined;
    const connection = createRealtimeConnection({
      station: "billing-requests",
      onSignal: ({ kind }) => {
        if (kind !== "billing_request") return;
        queryClient.invalidateQueries({ queryKey: billingKeys.requests() });
      },
      onStatus: () => {},
    });
    connection.start();
    return () => connection.stop();
  }, [queryClient]);
}
