import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

// Both the machine room and Echo Station (45-ECHO-STATION-PLAN.md) run on this
// same engine, mounted twice server-side under "machine" and "echo" — `station`
// picks the URL prefix and folds into every query key, so the two screens never
// share a cache entry.
const DEFAULT_STATION = "machine";

// The machine room. Every filter is a query parameter, never a client-side
// `.filter()`: the server holds the whole day and returns the rows asked for, so
// a phone is not sent 200 orders to throw 195 of them away.
export function useMachineQueue({
  machine = null,
  group = "all",
  q = "",
  station = DEFAULT_STATION,
} = {}) {
  const search = q.trim().length >= 2 ? q.trim() : "";
  return useQuery({
    queryKey: ["giniflow", station, "queue", machine || "all", group, search],
    queryFn: async () =>
      (
        await api.get(`/api/giniflow/stations/${station}/queue`, {
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
export function useMachineReconciliation(station = DEFAULT_STATION) {
  return useQuery({
    queryKey: ["giniflow", station, "reconciliation"],
    queryFn: async () => (await api.get(`/api/giniflow/stations/${station}/reconciliation`)).data,
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

const invalidate = (queryClient, station) => {
  queryClient.invalidateQueries({ queryKey: ["giniflow", station] });
  // Closing a test can turn the patient green for the MO and the consultant.
  queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "mo"] });
};

// Who is on the floor and could be walked to a machine. Searched server-side.
export function useMachineCandidates(q, station = DEFAULT_STATION) {
  const search = q.trim().length >= 2 ? q.trim() : "";
  return useQuery({
    queryKey: ["giniflow", station, "candidates", search],
    queryFn: async () =>
      (
        await api.get(`/api/giniflow/stations/${station}/candidates`, {
          params: search ? { q: search } : {},
        })
      ).data,
    enabled: search.length >= 2,
    staleTime: 30_000,
  });
}

// Raising a test at the machine, for the patient standing there.
export function useAddMachineTest(station = DEFAULT_STATION) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, machine }) =>
      (await api.post(`/api/giniflow/stations/${station}/add`, { visitId, machine })).data,
    onSuccess: () => invalidate(queryClient, station),
  });
}

export function useAdvanceMachineTest(station = DEFAULT_STATION) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, to }) =>
      (await api.post(`/api/giniflow/stations/${station}/${orderId}/advance`, { to })).data,
    onSuccess: () => invalidate(queryClient, station),
  });
}

export function useCancelMachineStart(station = DEFAULT_STATION) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId }) =>
      (await api.post(`/api/giniflow/stations/${station}/${orderId}/cancel-start`, {})).data,
    onSuccess: () => invalidate(queryClient, station),
  });
}

export function useCancelMachineTest(station = DEFAULT_STATION) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId, ...body }) =>
      (await api.post(`/api/giniflow/stations/${station}/${orderId}/cancel-test`, body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["giniflow"] }),
  });
}

// One call: the file is stored and the test closed together, so a report can
// never sit in storage with the test still open.
export function useUploadMachineReport(station = DEFAULT_STATION) {
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
        await api.post(`/api/giniflow/stations/${station}/${orderId}/report`, {
          base64,
          confirmAdditional,
          fileName: file.name,
          mediaType: file.type || "application/pdf",
        })
      ).data;
    },
    onSuccess: () => invalidate(queryClient, station),
  });
}

export function useRemoveMachineReport(station = DEFAULT_STATION) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ orderId }) =>
      (await api.delete(`/api/giniflow/stations/${station}/${orderId}/report`)).data,
    onSuccess: () => invalidate(queryClient, station),
  });
}

export function useMachines(station = DEFAULT_STATION) {
  return useQuery({
    queryKey: ["giniflow", "machines", station],
    queryFn: async () =>
      (
        await api.get(
          station === DEFAULT_STATION
            ? "/api/giniflow/machines"
            : `/api/giniflow/machines/${station}`,
        )
      ).data.machines,
    staleTime: 60 * 1000,
  });
}
