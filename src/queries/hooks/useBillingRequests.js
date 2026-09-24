import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { billingKeys } from "./useBillingMaster";

const INBOX = "/api/billing/master/requests";

export const INBOX_POLL_MS = 15_000;

const read = async (params) => (await api.get(INBOX, { params })).data;

export function useDeskRequests({ status, enabled = true, refetchInterval } = {}) {
  const params = status ? { status } : {};
  return useQuery({
    queryKey: billingKeys.requestInbox(params),
    queryFn: () => read(params),
    enabled,
    refetchInterval,
    refetchIntervalInBackground: false,
  });
}

export function usePendingDeskRequests(options = {}) {
  return useDeskRequests({ ...options, status: "pending" });
}

function useDecision(send) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSettled: () => queryClient.invalidateQueries({ queryKey: billingKeys.all }),
  });
}

export function useApproveDeskRequest() {
  return useDecision(
    async ({ id, ...body }) => (await api.post(`${INBOX}/${id}/approve`, body)).data,
  );
}

export function useRejectDeskRequest() {
  return useDecision(
    async ({ id, note }) => (await api.post(`${INBOX}/${id}/reject`, { note })).data,
  );
}
