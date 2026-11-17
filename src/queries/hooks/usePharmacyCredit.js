import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { billKeys } from "./usePharmacyBills";

const BASE = "/api/pharmacy/credit";

export const creditKeys = {
  all: ["pharmacy-credit"],
  requests: (params) => ["pharmacy-credit", "requests", params],
  dues: (params) => ["pharmacy-credit", "dues", params],
};

export function useCreditRequests(params) {
  return useQuery({
    queryKey: creditKeys.requests(params),
    queryFn: async () => (await api.get(`${BASE}/requests`, { params })).data,
    placeholderData: keepPreviousData,
  });
}

export function useDues(params) {
  return useQuery({
    queryKey: creditKeys.dues(params),
    queryFn: async () => (await api.get(`${BASE}/dues`, { params })).data,
    placeholderData: keepPreviousData,
  });
}

function useCreditMutation(request) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await request(input)).data,
    onSuccess: (result) => {
      const billId = result?.lines ? result.id : result?.bill_id;
      if (result?.lines) queryClient.setQueryData(billKeys.one(result.id), result);
      else if (billId) queryClient.invalidateQueries({ queryKey: billKeys.one(billId) });
      queryClient.invalidateQueries({ queryKey: creditKeys.all });
      queryClient.invalidateQueries({ queryKey: [...billKeys.all, "list"] });
    },
  });
}

export const useAskCredit = () =>
  useCreditMutation(({ billId, ...input }) => api.post(`${BASE}/bills/${billId}/requests`, input));

export const useWithdrawCredit = () =>
  useCreditMutation(({ id }) => api.post(`${BASE}/requests/${id}/withdraw`));

export const useDecideCredit = () =>
  useCreditMutation(({ id, ...input }) => api.post(`${BASE}/requests/${id}/decision`, input));

export const useCollectDue = () =>
  useCreditMutation(({ billId, ...input }) => api.post(`${BASE}/bills/${billId}/payments`, input));

export function usePatientCreditHistory(patientId) {
  return useQuery({
    queryKey: [...creditKeys.all, "history", String(patientId)],
    queryFn: async () => (await api.get(`${BASE}/patients/${patientId}/history`)).data,
    enabled: Boolean(patientId),
  });
}
