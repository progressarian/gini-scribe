import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

const BASE = "/api/giniflow/tests";
const LIST_KEY = ["giniflow", "cancel-requests"];

const targetParams = (target) =>
  target?.orderId
    ? { orderId: target.orderId, ...(target.testId ? { testId: target.testId } : {}) }
    : { caseNo: target?.caseNo, patientId: target?.patientId, date: target?.date };

export function useCancelStage(target, enabled = true) {
  const params = targetParams(target);
  return useQuery({
    queryKey: ["giniflow", "cancel-stage", params],
    queryFn: async () => (await api.get(`${BASE}/cancel-stage`, { params })).data,
    enabled: enabled && Boolean(target?.orderId || target?.caseNo),
  });
}

function useCancelMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["giniflow"] });
      queryClient.invalidateQueries({ queryKey: ["billing"] });
    },
  });
}

export const useRaiseCancelRequest = () =>
  useCancelMutation(async (body) => (await api.post(`${BASE}/cancel-requests`, body)).data);

export const useWithdrawCancelRequest = () =>
  useCancelMutation(
    async ({ id }) => (await api.post(`${BASE}/cancel-requests/${id}/withdraw`, {})).data,
  );

export const useApproveCancelRequest = () =>
  useCancelMutation(
    async ({ id, ...body }) => (await api.post(`${BASE}/cancel-requests/${id}/approve`, body)).data,
  );

export const useRejectCancelRequest = () =>
  useCancelMutation(
    async ({ id, ...body }) => (await api.post(`${BASE}/cancel-requests/${id}/reject`, body)).data,
  );

export const useCancelNow = () =>
  useCancelMutation(async (body) => (await api.post(`${BASE}/cancel-now`, body)).data);

export function useCancelRequests({
  status = "pending",
  q = "",
  from = "",
  to = "",
  page = 1,
  limit = 20,
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
    queryKey: [...LIST_KEY, params],
    queryFn: async () => (await api.get(`${BASE}/cancel-requests`, { params })).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });
}

export function useCancelRequestDetail(id) {
  return useQuery({
    queryKey: [...LIST_KEY, "detail", id],
    queryFn: async () => (await api.get(`${BASE}/cancel-requests/${id}`)).data,
    enabled: Boolean(id),
  });
}
