import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

// Prescription, tests, medicine card and Finalize.
// docs/gini-flow/14-CONSULTANT-PRESCRIPTION-PLAN.md §9.

// The MO edits the same draft through its own gate (addendum v1.1 §3): a row
// written there is a proposal because of the route it came through, not because
// of a flag the browser set. The hooks take the station so one component can
// serve both screens.
export const visitWriteKey = (visitId) => ["giniflow", "visit-write", visitId];

const base = (visitId, station = "doctor") => `/api/giniflow/stations/${station}/${visitId}`;

export function usePrescription(visitId, station = "doctor") {
  return useQuery({
    // One cache entry per visit whichever station read it — the draft is the
    // same row set, and two keys would let the MO and the doctor hold different
    // pictures of it.
    queryKey: ["giniflow", "doctor", "rx", visitId],
    queryFn: async () => (await api.get(`${base(visitId, station)}/prescription`)).data,
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
    // Shared with the care plan so the consult rail can say when this visit's
    // draft was last written to, whichever section wrote it.
    mutationKey: visitWriteKey(visitId),
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "rx", visitId] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "card", visitId] });
      queryClient.invalidateQueries({
        queryKey: ["giniflow", "doctor", "finalize-preview", visitId],
      });
      // Any edit to the list can create an interaction or clear one, so a stale
      // check is a wrong check.
      queryClient.invalidateQueries({
        queryKey: ["giniflow", "doctor", "interactions", visitId],
      });
    },
  });
};

export const useSeedDraft = (visitId) =>
  useDraftMutation(
    visitId,
    async () => (await api.post(`${base(visitId)}/prescription/seed`)).data,
  );

export const useAddItem = (visitId, station = "doctor") =>
  useDraftMutation(
    visitId,
    async (item) => (await api.post(`${base(visitId, station)}/prescription/items`, item)).data,
  );

export const useUpdateItem = (visitId) =>
  useDraftMutation(
    visitId,
    async ({ itemId, ...patch }) =>
      (await api.patch(`/api/giniflow/stations/doctor/prescription/items/${itemId}`, patch)).data,
  );

// Approve or Reject a proposed row. Adjust is not here: editing the row through
// `useUpdateItem` IS the adjust decision (addendum v1.1 §3).
// The 30-second visit. Invalidates the same keys a normal finalize does — it is
// a finalize, with three steps taken for the doctor.
export const useFastFinalize = (visitId) =>
  useDraftMutation(visitId, async () => (await api.post(`${base(visitId)}/fast-finalize`)).data);

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

// The interaction check over the combined list (§5.2). Its own query, not part
// of the draft: the draft is refetched on every medicine search keystroke.
export function useInteractions(visitId, station = "doctor") {
  return useQuery({
    queryKey: ["giniflow", "doctor", "interactions", visitId],
    queryFn: async () => (await api.get(`${base(visitId, station)}/interactions`)).data,
    enabled: !!visitId,
  });
}

// Prescribing a severe interaction deliberately. The consultant only — an MO
// assembling the list can fix it, but cannot sign off on it.
export const useAckInteraction = (visitId) =>
  useDraftMutation(
    visitId,
    async ({ ruleKey, reason }) =>
      (await api.post(`${base(visitId)}/interactions/ack`, { ruleKey, reason })).data,
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
