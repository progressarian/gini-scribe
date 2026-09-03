import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

// Prescription, tests, medicine card and Finalize.
// docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md §9.

const base = (visitId) => `/api/giniflow/stations/doctor/${visitId}`;

export function usePrescription(visitId) {
  return useQuery({
    queryKey: ["giniflow", "doctor", "rx", visitId],
    queryFn: async () => (await api.get(`${base(visitId)}/prescription`)).data,
    enabled: !!visitId,
  });
}

export function useMedicineCard(visitId) {
  return useQuery({
    queryKey: ["giniflow", "doctor", "card", visitId],
    queryFn: async () => (await api.get(`${base(visitId)}/medicine-card`)).data,
    enabled: !!visitId,
  });
}

export function useTestPanels() {
  return useQuery({
    queryKey: ["giniflow", "doctor", "test-panels"],
    queryFn: async () => (await api.get("/api/giniflow/stations/doctor/test-panels")).data,
    staleTime: 10 * 60_000,
  });
}

export function useMedicineSearch(query) {
  const q = (query || "").trim();
  return useQuery({
    queryKey: ["giniflow", "doctor", "med-search", q],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/doctor/medicines", { params: { q } })).data,
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
}

// `known: false` means the inventory has never heard of this medicine. The
// screen must say that, rather than showing an empty list that reads as "no
// alternatives exist".
export function useAlternatives(name) {
  return useQuery({
    queryKey: ["giniflow", "doctor", "alternatives", name],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/doctor/medicines/alternatives", {
          params: { name },
        })
      ).data,
    enabled: !!name,
  });
}

export function useFinalizePreview(visitId, enabled) {
  return useQuery({
    queryKey: ["giniflow", "doctor", "finalize-preview", visitId],
    queryFn: async () => (await api.get(`${base(visitId)}/finalize`)).data,
    enabled: !!visitId && !!enabled,
  });
}

// Every draft write refreshes the draft and the card — the card is a view over
// the same medicines, so the two must never be able to disagree on screen.
const useDraftMutation = (visitId, fn) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "rx", visitId] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "card", visitId] });
      queryClient.invalidateQueries({
        queryKey: ["giniflow", "doctor", "finalize-preview", visitId],
      });
    },
  });
};

export const useSeedDraft = (visitId) =>
  useDraftMutation(
    visitId,
    async () => (await api.post(`${base(visitId)}/prescription/seed`)).data,
  );

export const useAddItem = (visitId) =>
  useDraftMutation(
    visitId,
    async (item) => (await api.post(`${base(visitId)}/prescription/items`, item)).data,
  );

export const useUpdateItem = (visitId) =>
  useDraftMutation(
    visitId,
    async ({ itemId, ...patch }) =>
      (await api.patch(`/api/giniflow/stations/doctor/prescription/items/${itemId}`, patch)).data,
  );

// Approve or Reject a proposed row. Adjust is not here: editing the row through
// `useUpdateItem` IS the adjust decision (addendum v1.1 §3).
export const useDecideItem = (visitId) =>
  useDraftMutation(
    visitId,
    async ({ itemId, status, note }) =>
      (
        await api.post(`/api/giniflow/stations/doctor/prescription/items/${itemId}/decide`, {
          status,
          note,
        })
      ).data,
  );

export const useRemoveItem = (visitId) =>
  useDraftMutation(
    visitId,
    async (itemId) =>
      (await api.delete(`/api/giniflow/stations/doctor/prescription/items/${itemId}`)).data,
  );

export const usePauseItem = (visitId) =>
  useDraftMutation(
    visitId,
    async ({ itemId, weeks }) =>
      (
        await api.post(`/api/giniflow/stations/doctor/prescription/items/${itemId}/pause`, {
          weeks,
        })
      ).data,
  );

export const useStopItem = (visitId) =>
  useDraftMutation(
    visitId,
    async ({ itemId, reason }) =>
      (
        await api.post(`/api/giniflow/stations/doctor/prescription/items/${itemId}/stop`, {
          reason,
        })
      ).data,
  );

export const useAddExternal = (visitId) =>
  useDraftMutation(visitId, async (med) => (await api.post(`${base(visitId)}/external`, med)).data);

export function useOrderTests(visitId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (order) => (await api.post(`${base(visitId)}/tests`, order)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "consult", visitId] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
    },
  });
}

// Finalize moves the patient to the pharmacy and writes the prescription into
// the chart, so it invalidates everything that could still be showing the draft.
export function useFinalize(visitId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post(`${base(visitId)}/finalize`, { confirm: true })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
    },
  });
}
