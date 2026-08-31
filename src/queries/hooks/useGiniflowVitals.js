import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

// The queue polls like the board does; the detail pane is fetched per patient.
export function useVitalsQueue(date) {
  return useQuery({
    queryKey: ["giniflow", "vitals", "queue", date || "today"],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/vitals/queue", { params: date ? { date } : {} })).data,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useVitalsPatient(visitId) {
  return useQuery({
    queryKey: ["giniflow", "vitals", "patient", visitId],
    queryFn: async () => (await api.get(`/api/giniflow/stations/vitals/${visitId}`)).data,
    enabled: !!visitId,
  });
}

export function useSaveVitals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, ...body }) =>
      (await api.post(`/api/giniflow/stations/vitals/${visitId}`, body)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "vitals"] });
      // The board shows the same patient moving out of "At vitals".
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
    },
  });
}

export function useStartVitals() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (visitId) =>
      (await api.post(`/api/giniflow/stations/vitals/${visitId}/start`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["giniflow", "vitals", "queue"] }),
  });
}
