import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";
import { pollInterval } from "./giniflowPolling";

const invalidate = (queryClient) => {
  queryClient.invalidateQueries({ queryKey: ["giniflow", "rx"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "board"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "pharmacy"] });
  queryClient.invalidateQueries({ queryKey: ["giniflow", "stations", "summary"] });
};

export function useRxQueue(date, q = "") {
  const search = q.trim().length >= 2 ? q.trim() : "";
  return useQuery({
    queryKey: ["giniflow", "rx", "queue", date || "today", search],
    queryFn: async () =>
      (
        await api.get("/api/giniflow/stations/rx/queue", {
          params: { ...(date ? { date } : {}), ...(search ? { q: search } : {}) },
        })
      ).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useHandOverEchoReport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/echo-handover`)).data,
    onSuccess: () => {
      invalidate(queryClient);
      queryClient.invalidateQueries({ queryKey: ["giniflow", "vitals"] });
    },
  });
}

export function useRxPatient(visitId) {
  return useQuery({
    queryKey: ["giniflow", "rx", "patient", visitId],
    queryFn: async () => (await api.get(`/api/giniflow/stations/rx/${visitId}`)).data,
    enabled: !!visitId,
  });
}

export function useStartRxExplain() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/start`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useReturnRxToQueue() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/return`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useMarkRxExplained() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/explained`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export function useReissueRx() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/rx/${visitId}/reissue`)).data,
    onSuccess: () => invalidate(queryClient),
  });
}

export const printRxHref = (visitId) =>
  `${API_URL}/api/giniflow/stations/rx/${visitId}/print?token=${encodeURIComponent(
    localStorage.getItem("gini_auth_token") || "",
  )}`;

// Ending a visit that never reaches a dispense — about nine in ten do not. The
// counter is where the visit actually ends, so the two people standing at it can
// say so (38-MANUAL-FLOOR-PLAN.md).
export function useEndVisit(station) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId }) =>
      (await api.post(`/api/giniflow/stations/${station}/${visitId}/end-visit`)).data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow"] });
    },
  });
}

const RX_READY_TRIES = 12;
const RX_READY_WAIT_MS = 2000;

async function rxErrorOf(error) {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      return JSON.parse(await data.text());
    } catch {
      return {};
    }
  }
  return data || {};
}

export async function fetchPrintableRx(visitId) {
  let reissued = false;
  for (let attempt = 0; attempt < RX_READY_TRIES; attempt += 1) {
    try {
      const { data } = await api.get(`/api/giniflow/stations/rx/${visitId}/print`, {
        responseType: "blob",
      });
      return data;
    } catch (error) {
      const body = await rxErrorOf(error);
      if (body.reason === "stale" && !reissued) {
        reissued = true;
        await api.post(`/api/giniflow/stations/rx/${visitId}/reissue`);
        continue;
      }
      if (body.reason === "not_ready") {
        await new Promise((resolve) => setTimeout(resolve, RX_READY_WAIT_MS));
        continue;
      }
      throw Object.assign(new Error(body.error || "The prescription could not be opened"), {
        reason: body.reason,
      });
    }
  }
  throw new Error("The prescription is still being prepared — try Print Rx again in a minute");
}
