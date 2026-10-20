import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

const historyKey = (visitId) => ["giniflow", "reception", "home-sample", visitId];

export function useHomeSampleHistory(visitId, enabled = true) {
  return useQuery({
    queryKey: historyKey(visitId),
    queryFn: async () =>
      (await api.get(`/api/giniflow/stations/reception/${visitId}/home-sample/history`)).data
        .history,
    enabled: Boolean(visitId) && enabled,
  });
}

export function useSaveHomeSample() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, ...answer }) =>
      (await api.post(`/api/giniflow/stations/reception/${visitId}/home-sample`, answer)).data,
    onSuccess: (_, { visitId }) => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception", "arrivals"] });
      queryClient.invalidateQueries({ queryKey: historyKey(visitId) });
      queryClient.invalidateQueries({ queryKey: qk.ghm.all });
    },
  });
}
