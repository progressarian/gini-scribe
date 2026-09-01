import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

export function useLabQueue(date) {
  return useQuery({
    queryKey: ["giniflow", "lab", "queue", date || "today"],
    queryFn: async () =>
      (await api.get("/api/giniflow/stations/lab/queue", { params: date ? { date } : {} })).data,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

// Uploading is one call: the file is stored and the order advanced together, so
// a report can never sit in storage with the MO still waiting.
export function useUploadReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, file }) => {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });
      return (
        await api.post(`/api/giniflow/stations/lab/${orderId}/report`, {
          base64,
          fileName: file.name,
          mediaType: file.type || "application/pdf",
        })
      ).data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "lab"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
    },
  });
}

export function useAdvanceSample() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, to, reportUrl }) =>
      (await api.post(`/api/giniflow/stations/lab/${orderId}/advance`, { to, reportUrl })).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow", "lab"] });
      // Uploading turns the patient green on the board and the MO queue.
      queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "reception"] });
    },
  });
}
