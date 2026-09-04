import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { visitWriteKey } from "./useGiniflowPrescription";

// The consultant's station. Same polling contract as every other Gini Flow
// screen — 15s, client-side ticking between polls — so that when
// docs/gini-flow/12-REALTIME-PLAN.md replaces the transport, this switches over
// with the rest rather than needing its own unpicking. Never hand-roll an
// interval in the page.
export function useDoctorQueue({ date, scope = "mine", q = "" } = {}) {
  return useQuery({
    queryKey: ["giniflow", "doctor", "queue", date || "today", scope, q],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/doctor/queue", {
          params: { ...(date ? { date } : {}), scope, ...(q ? { q } : {}) },
        })
      ).data,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useConsult(visitId) {
  return useQuery({
    queryKey: ["giniflow", "doctor", "consult", visitId],
    queryFn: async () => (await api.get(`/api/giniflow/stations/doctor/${visitId}`)).data,
    enabled: !!visitId,
  });
}

export function useTrend(visitId, marker) {
  return useQuery({
    queryKey: ["giniflow", "doctor", "trend", visitId, marker],
    queryFn: async () =>
      (await api.get(`/api/giniflow/stations/doctor/${visitId}/trend/${marker}`)).data,
    enabled: !!visitId && !!marker,
    staleTime: 60_000,
  });
}

// The board shows the same patient moving into and out of "With doctor", so
// every write invalidates it too.
const invalidateAll = (queryClient, visitId) => {
  queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  if (visitId) {
    queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "consult", visitId] });
  }
};

export function useStartConsult() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (visitId) =>
      (await api.post(`/api/giniflow/stations/doctor/${visitId}/start`)).data,
    onSuccess: (_d, visitId) => invalidateAll(queryClient, visitId),
  });
}

export function useReleaseConsult() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (visitId) =>
      (await api.post(`/api/giniflow/stations/doctor/${visitId}/release`)).data,
    onSuccess: (_d, visitId) => invalidateAll(queryClient, visitId),
  });
}

// Autosaved as the consultant types — a consultation interrupted by a phone call
// must lose nothing. The queue is not invalidated on every keystroke-batch.
export function useSaveCarePlan(visitId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: visitWriteKey(visitId),
    mutationFn: async (plan) =>
      (await api.put(`/api/giniflow/stations/doctor/${visitId}/care-plan`, plan)).data,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["giniflow", "doctor", "consult", visitId],
        refetchType: "none",
      }),
  });
}

export function useDecideProposal(visitId) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ proposalId, ...decision }) =>
      (await api.patch(`/api/giniflow/stations/doctor/proposals/${proposalId}`, decision)).data,
    onSuccess: () => invalidateAll(queryClient, visitId),
  });
}
