import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

// The machine room. Every filter is a query parameter, never a client-side
// `.filter()`: the server holds the whole day and returns the rows asked for, so
// a phone is not sent 200 orders to throw 195 of them away.
export function useMachineQueue({ machine = null, group = "all", q = "" } = {}) {
  const search = q.trim().length >= 2 ? q.trim() : "";
  return useQuery({
    queryKey: ["giniflow", "machine", "queue", machine || "all", group, search],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/machine/queue", {
          params: {
            ...(machine ? { machine } : {}),
            ...(group && group !== "all" ? { group } : {}),
            ...(search ? { q: search } : {}),
          },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

// Tests whose report landed with no order behind them — the work that happened
// without touching this screen. Slower poll: it is a reconciliation, not a queue.
export function useMachineReconciliation() {
  return useQuery({
    queryKey: ["giniflow", "machine", "reconciliation"],
    queryFn: async () => (await api.get("/api/giniflow/stations/machine/reconciliation")).data,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

const invalidate = (queryClient) => {
  queryClient.invalidateQueries({ queryKey: ["giniflow", "machine"] });
  // Closing a test can turn the patient green for the MO and the consultant.
  queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "mo"] });
};

// Who is on the floor and could be walked to a machine. Searched server-side.
export function useMachineCandidates(q) {
  const search = q.trim().length >= 2 ? q.trim() : "";
  return useQuery({
    queryKey: ["giniflow", "machine", "candidates", search],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/machine/candidates", {
          params: search ? { q: search } : {},
        })
      ).data,
    enabled: search.length >= 2,
    staleTime: 30_000,
  });
}

// Raising a test at the machine, for the patient standing there.
export function useAddMachineTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, machine }) =>
      (await api.post("/api/giniflow/stations/machine/add", { visitId, machine })).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useAdvanceMachineTest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, to }) =>
      (await api.post(`/api/giniflow/stations/machine/${orderId}/advance`, { to })).data,
    onSuccess: () => invalidate(queryClient),
  });
}

// One call: the file is stored and the test closed together, so a report can
// never sit in storage with the test still open.
export function useUploadMachineReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, file, confirmAdditional = false }) => {
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Could not read that file"));
        reader.readAsDataURL(file);
      });
      return (
        await api.post(`/api/giniflow/stations/machine/${orderId}/report`, {
          base64,
          confirmAdditional,
          fileName: file.name,
          mediaType: file.type || "application/pdf",
        })
      ).data;
    },
    onSuccess: () => invalidate(queryClient),
  });
}

export function useRemoveMachineReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId }) =>
      (await api.delete(`/api/giniflow/stations/machine/${orderId}/report`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}
