import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const url = (station, visitId) => `/api/giniflow/stations/${station}/${visitId}/tests-due`;

export const testsDueKey = (visitId) => ["giniflow", "tests-due", visitId];

export function useTestsDue(visitId, station, enabled = true) {
  return useQuery({
    queryKey: testsDueKey(visitId),
    queryFn: async () => (await api.get(url(station, visitId))).data,
    enabled: !!visitId && enabled,
    staleTime: 60_000,
  });
}

export function useDecideTestsDue(visitId, station) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (decision) => (await api.post(url(station, visitId), decision)).data,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: testsDueKey(visitId) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "doctor", "consult", visitId] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "mo"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
    },
  });
}
