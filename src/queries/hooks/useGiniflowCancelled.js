import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

export function useCancelledTests(station) {
  return useQuery({
    queryKey: ["giniflow", station, "cancelled"],
    queryFn: async () =>
      (await api.get(`/api/giniflow/stations/${station}/cancelled`)).data.cancelled,
    refetchInterval: pollInterval,
  });
}

export function useRestoreTest(station) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId }) =>
      (await api.post(`/api/giniflow/stations/${station}/cancelled/${orderId}/restore`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["giniflow"] }),
  });
}
