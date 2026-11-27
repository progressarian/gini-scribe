import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";
import { APPROVALS_WAITING_KEY } from "./useApprovals";

const BASE = "/api/giniflow/report-releases";
export const REPORT_RELEASE_KEY = ["giniflow", "report-releases"];

function useReleaseMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: REPORT_RELEASE_KEY });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "lab"] });
      queryClient.invalidateQueries({ queryKey: APPROVALS_WAITING_KEY });
    },
  });
}

export const useRaiseReleaseRequest = () =>
  useReleaseMutation(async (body) => (await api.post(BASE, body)).data);

export const useWithdrawReleaseRequest = () =>
  useReleaseMutation(async ({ id }) => (await api.post(`${BASE}/${id}/withdraw`, {})).data);

export const useApproveReleaseRequest = () =>
  useReleaseMutation(
    async ({ id, note }) => (await api.post(`${BASE}/${id}/approve`, note ? { note } : {})).data,
  );

export const useRejectReleaseRequest = () =>
  useReleaseMutation(
    async ({ id, note }) => (await api.post(`${BASE}/${id}/reject`, { note })).data,
  );

export function useReleaseRequests({
  status = "pending",
  q = "",
  from = "",
  to = "",
  page = 1,
  limit = 20,
  enabled = true,
}) {
  const search = q.trim().length >= 2 ? q.trim() : "";
  const params = {
    ...(status !== "all" ? { status } : {}),
    ...(search ? { q: search } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    page: String(page),
    limit: String(limit),
  };
  return useQuery({
    queryKey: [...REPORT_RELEASE_KEY, params],
    queryFn: async () => (await api.get(BASE, { params })).data,
    enabled,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useReleaseState(visitId, enabled = true) {
  return useQuery({
    queryKey: [...REPORT_RELEASE_KEY, "visit", visitId],
    queryFn: async () => (await api.get(`${BASE}/visit/${visitId}`)).data,
    enabled: enabled && Boolean(visitId),
  });
}
