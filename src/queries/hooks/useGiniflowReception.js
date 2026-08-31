import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

export function useReceptionQueue(date) {
  return useQuery({
    queryKey: ["giniflow", "reception", "queue", date || "today"],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/reception/queue", { params: date ? { date } : {} }))
        .data,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useClearPayment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, method }) =>
      (await api.post(`/api/giniflow/stations/reception/${orderId}/clear`, { method })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
      // Clearing a payment is what makes the sample task appear for the lab.
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
    },
  });
}
