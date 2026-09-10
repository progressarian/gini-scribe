import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

// The pharmacy station's five calls — docs/gini-flow/16-PHARMACY-STATION-PLAN.md §9.
//
// Every write invalidates the board as well as the queue: this station is the
// only one that ENDS a visit, so a dispense moves a card out of "At pharmacy"
// and into "Done today" on every screen the floor is watching.

const invalidate = (queryClient) => {
  queryClient.invalidateQueries({ queryKey: ["giniflow", "pharmacy"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "stations", "summary"] });
};

export function usePharmacyQueue(date, group = "all") {
  return useQuery({
    queryKey: ["giniflow", "pharmacy", "queue", date || "today", group],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/pharmacy/queue", {
          params: { ...(date ? { date } : {}), ...(group && group !== "all" ? { group } : {}) },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function usePharmacyPatient(visitId) {
  return useQuery({
    queryKey: ["giniflow", "pharmacy", "patient", visitId],
    queryFn: async () => (await api.get(`/api/giniflow/stations/pharmacy/${visitId}`)).data,
    enabled: !!visitId,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
  });
}

export function useDispenseItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, medicationId, status, reason, qtyNote }) =>
      (
        await api.post(`/api/giniflow/stations/pharmacy/${visitId}/dispense/${medicationId}`, {
          status,
          reason,
          qtyNote,
        })
      ).data,
    onSuccess: (_data, { visitId }) => {
      invalidate(queryClient);
      queryClient.invalidateQueries({ queryKey: ["giniflow", "pharmacy", "patient", visitId] });
    },
  });
}

// The exit. `confirm` is required by the API too — ending a visit is
// irreversible under append-only rules, so it is never a bare POST.
export function useDispenseAll() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (
        await api.post(`/api/giniflow/stations/pharmacy/${visitId}/dispense-all`, {
          confirm: true,
        })
      ).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useSendCard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/pharmacy/${visitId}/send-card`)).data,
    onSuccess: (_data, { visitId }) => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "pharmacy", "patient", visitId] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "pharmacy", "queue"] });
    },
  });
}

// Ending a visit that never reaches a dispense — about nine in ten do not. The
// counter is where the visit actually ends, so the two people standing at it can
// say so (38-MANUAL-FLOOR-PLAN.md).
export function useEndVisit(station) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/${station}/${visitId}/end-visit`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow"] });
    },
  });
}
