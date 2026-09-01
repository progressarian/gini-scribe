import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

export function useReceptionQueue(date) {
  return useQuery({
    queryKey: ["giniflow", "reception", "queue", date || "today"],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/reception/queue", { params: date ? { date } : {} }))
        .data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useClearPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, method }) =>
      (await api.post(`/api/giniflow/stations/reception/${orderId}/clear`, { method })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
      // Clearing a payment is what makes the sample task appear for the lab.
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
    },
  });
}

// ── Arrivals ────────────────────────────────────────────────────────────────
// Search is a server round-trip, not a filter over rendered rows: the day can
// hold 100+ patients and phone matching has to normalise the number the same way
// the rest of the repo does.
export function useArrivals(date, q = "") {
  return useQuery({
    queryKey: ["giniflow", "reception", "arrivals", date || "today", q],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/reception/arrivals", {
          params: { ...(date ? { date } : {}), ...(q ? { q } : {}) },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useWalkInSearch(q) {
  return useQuery({
    queryKey: ["giniflow", "reception", "walk-in-search", q],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/reception/walk-in/search", { params: { q } })).data,
    enabled: (q || "").trim().length >= 2,
    placeholderData: (prev) => prev,
  });
}

// One hook for all four arrival actions: they differ only in the path and the
// body, and the invalidation after them is identical.
export function useArrivalAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, action, reason }) =>
      (
        await api.post(
          `/api/giniflow/stations/reception/${visitId}/${action}`,
          action === "cancel" ? { reason } : {},
        )
      ).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
      // A patient entering or leaving the floor changes every other screen.
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "stations"] });
    },
  });
}

export function useCheckInWalkIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ patientId, appointmentId }) =>
      (
        await api.post("/api/giniflow/stations/reception/walk-in", {
          patientId,
          appointmentId: appointmentId ?? null,
        })
      ).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "stations"] });
    },
  });
}
