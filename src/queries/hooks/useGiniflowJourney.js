import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

// The journey reception builds at check-in (29-RECEPTION-JOURNEY-PLAN.md).
// The reference data — visit types, catalog, templates, staff — is the /flow
// module's and is read through useFlow.js: one catalog, not two.

const invalidate = (queryClient) => {
  queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "arrivals"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  // Only the patients' journeys — NOT ["giniflow","journey","plan",…], which is
  // the visit type's template. Refetching that under an open check-in panel
  // would reset the steps reception had just edited.
  queryClient.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === "giniflow" && q.queryKey[1] === "journey" && q.queryKey[2] !== "plan",
  });
};

// The default plan for a visit type, straight from its template.
export function useJourneyPlan(visitTypeId) {
  return useQuery({
    queryKey: ["giniflow", "journey", "plan", visitTypeId],
    queryFn: async () => (await api.get(`/api/giniflow/journey/plan/${visitTypeId}`)).data,
    enabled: !!visitTypeId,
    staleTime: 5 * 60_000,
  });
}

// A patient's own journey. The server seeds one on first read for anyone the
// HealthRay sync checked in, so this never comes back empty for a real visit.
export function useJourney(visitId) {
  return useQuery({
    queryKey: ["giniflow", "journey", visitId],
    queryFn: async () => (await api.get(`/api/giniflow/journey/${visitId}`)).data,
    enabled: !!visitId,
  });
}

export function useCheckIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, ...body }) =>
      (await api.post(`/api/giniflow/stations/reception/${visitId}/checkin`, body)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useJourneyStep() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, visitId, stepId, ...body }) => {
      if (action === "add")
        return (await api.post(`/api/giniflow/journey/${visitId}/steps`, body)).data;
      if (action === "remove")
        return (await api.delete(`/api/giniflow/journey/steps/${stepId}`)).data;
      if (action === "order")
        return (await api.post(`/api/giniflow/journey/${visitId}/order`, body)).data;
      return (await api.patch(`/api/giniflow/journey/steps/${stepId}`, body)).data;
    },
    onSuccess: () => invalidate(queryClient),
  });
}
