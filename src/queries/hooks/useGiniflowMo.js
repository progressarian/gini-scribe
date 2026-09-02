import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

const base = "/api/giniflow/stations/mo";

export function useMoQueue(date, q) {
  const search = q?.trim() || undefined;
  return useQuery({
    queryKey: ["giniflow", "mo", "queue", date || "today", search || ""],
    queryFn: async () =>
      (
        await api.get(`${base}/queue`, {
          params: { ...(date ? { date } : {}), ...(search ? { q: search } : {}) },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useMoPatient(visitId) {
  return useQuery({
    queryKey: ["giniflow", "mo", "patient", visitId],
    queryFn: async () => (await api.get(`${base}/${visitId}`)).data,
    enabled: !!visitId,
  });
}

export function useTestPanels() {
  return useQuery({
    queryKey: ["giniflow", "mo", "test-panels"],
    queryFn: async () => (await api.get(`${base}/test-panels`)).data,
    staleTime: 10 * 60_000,
  });
}

// Every action invalidates the board too: the MO is the station that moves
// patients into and out of the queue the Flow Manager watches.
const useMoAction = (fn) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "mo"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
    },
  });
};

export const useStartWorkup = () =>
  useMoAction(async (visitId) => (await api.post(`${base}/${visitId}/start`)).data);

// Deliberately NOT a useMoAction: this writes nothing, so there is nothing to
// invalidate. It hands back a proposal the MO confirms.
export const useExtractPlan = () =>
  useMutation({
    mutationFn: async ({ visitId, plan }) =>
      (await api.post(`${base}/${visitId}/extract-plan`, { plan })).data,
  });

export const useOrderTests = () =>
  useMoAction(
    async ({ visitId, urgency, tests }) =>
      (await api.post(`${base}/${visitId}/tests`, { urgency, tests })).data,
  );

export const useTakeOver = () =>
  useMoAction(async (visitId) => (await api.post(`${base}/${visitId}/takeover`)).data);

export const useReleaseWorkup = () =>
  useMoAction(async (visitId) => (await api.post(`${base}/${visitId}/release`)).data);

export const useReadyForDoctor = () =>
  useMoAction(async (visitId) => (await api.post(`${base}/${visitId}/ready`)).data);

export const useCloseWithoutDoctor = () =>
  useMoAction(async (visitId) => (await api.post(`${base}/${visitId}/close`)).data);

export const useAddProposal = () =>
  useMoAction(
    async ({ visitId, ...proposal }) =>
      (await api.post(`${base}/${visitId}/proposals`, proposal)).data,
  );

export const useWithdrawProposal = () =>
  useMoAction(async (id) => (await api.delete(`${base}/proposals/${id}`)).data);

// The plan autosaves, so it must not invalidate the queue on every keystroke.
export function useSavePlan() {
  return useMutation({
    mutationFn: async ({ visitId, plan, source }) =>
      (await api.put(`${base}/${visitId}/plan`, { plan, source })).data,
  });
}
