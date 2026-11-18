import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { billKeys } from "./usePharmacyBills";
import { creditKeys } from "./usePharmacyCredit";

const BASE = "/api/pharmacy/accounts";
const KEY = ["pharmacy-accounts"];

export const usePatientLedger = (params) =>
  useQuery({
    queryKey: [...KEY, "ledger", params],
    queryFn: async () => (await api.get(`${BASE}/ledger`, { params })).data,
    placeholderData: keepPreviousData,
  });

export const usePatientAccount = (patientId) =>
  useQuery({
    queryKey: [...KEY, "one", String(patientId)],
    queryFn: async () => (await api.get(`${BASE}/${patientId}`)).data,
    enabled: Boolean(patientId),
  });

function useAccountMutation(path) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ target, ...input }) => (await api.post(path(target), input)).data,
    onSuccess: () => {
      for (const key of [KEY, billKeys.all, creditKeys.all, ["billing"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export const useReceiveDeposit = () => useAccountMutation((id) => `${BASE}/${id}/deposits`);
export const useRefundDeposit = () => useAccountMutation((id) => `${BASE}/${id}/deposit-refunds`);
export const useWriteOff = () =>
  useAccountMutation((billId) => `${BASE}/bills/${billId}/write-off`);
