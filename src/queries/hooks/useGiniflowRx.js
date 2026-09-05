import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";
import { pollInterval } from "./giniflowPolling";

const invalidate = (queryClient) => {
  queryClient.invalidateQueries({ queryKey: ["giniflow", "rx"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "pharmacy"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "stations", "summary"] });
};

export function useRxQueue(date, q = "") {
  const search = q.trim().length >= 2 ? q.trim() : "";
  return useQuery({
    queryKey: ["giniflow", "rx", "queue", date || "today", search],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/rx/queue", {
          params: { ...(date ? { date } : {}), ...(search ? { q: search } : {}) },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useRxPatient(visitId) {
  return useQuery({
    queryKey: ["giniflow", "rx", "patient", visitId],
    queryFn: async () => (await api.get(`/api/giniflow/stations/rx/${visitId}`)).data,
    enabled: !!visitId,
  });
}

export function useStartRxExplain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/start`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useMarkRxExplained() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/explained`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useReissueRx() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/reissue`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export const printRxHref = (visitId) =>
  `${API_URL}/api/giniflow/stations/rx/${visitId}/print?token=${encodeURIComponent(
    localStorage.getItem("gini_auth_token") || "",
  )}`;
