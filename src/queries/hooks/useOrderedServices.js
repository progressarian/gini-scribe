import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const base = (station, visitId) => `/api/giniflow/stations/${station}/${visitId}/services`;
const servicesKey = (visitId) => ["ordered-services", visitId];

export function useOrderedServices(station, visitId) {
  return useQuery({
    queryKey: servicesKey(visitId),
    queryFn: async () => (await api.get(base(station, visitId))).data,
    enabled: !!visitId,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useOrderedServiceChoices(station, visitId, q) {
  return useQuery({
    queryKey: ["ordered-services", "choices", visitId, q],
    queryFn: async () =>
      (await api.get(`${base(station, visitId)}/choices`, { params: q ? { q } : {} })).data,
    enabled: !!visitId,
    staleTime: 30_000,
  });
}

function useServicesMutation(station, visitId, mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data) => {
      queryClient.setQueryData(servicesKey(visitId), data);
      queryClient.invalidateQueries({ queryKey: ["billing"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
    },
  });
}

export function useAddOrderedService(station, visitId) {
  return useServicesMutation(
    station,
    visitId,
    async (body) => (await api.post(base(station, visitId), body)).data,
  );
}

export function useRemoveOrderedService(station, visitId) {
  return useServicesMutation(
    station,
    visitId,
    async ({ lineId, reason }) =>
      (await api.post(`${base(station, visitId)}/${lineId}/remove`, { reason })).data,
  );
}
