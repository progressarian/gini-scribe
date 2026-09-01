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

export function usePharmacyQueue(date) {
  return useQuery({
    queryKey: ["giniflow", "pharmacy", "queue", date || "today"],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/pharmacy/queue", { params: date ? { date } : {} }))
        .data,
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
