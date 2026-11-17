import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { billKeys } from "./usePharmacyBills";
import { creditKeys } from "./usePharmacyCredit";

const STOCK_KEYS = [["pharmacy-stock"], ["pharmacy-batches"]];

export const departmentKeys = {
  transfers: (params) => ["pharmacy-transfers", params],
  indents: (params) => ["pharmacy-indents", params],
  indentPatients: (q) => ["pharmacy-indents", "patients", q],
  collect: (params) => ["pharmacy-collect", params],
  collectBill: (id) => ["pharmacy-collect", "bill", String(id)],
};

const list = (key, url) => (params) =>
  useQuery({
    queryKey: key(params),
    queryFn: async () => (await api.get(url, { params })).data,
    placeholderData: keepPreviousData,
  });

export const useTransfers = list(departmentKeys.transfers, "/api/pharmacy/transfers");
export const useIndents = list(departmentKeys.indents, "/api/pharmacy/indents");
export const useReceptionDues = list(departmentKeys.collect, "/api/pharmacy/collect/dues");
export const useExpiryList = list((p) => ["pharmacy-expiry", p], "/api/pharmacy/expiry");
export const useVendorReturns = list(
  (p) => ["pharmacy-vendor-returns", p],
  "/api/pharmacy/vendor-returns",
);

export function useIndentPatientSearch(q) {
  return useQuery({
    queryKey: departmentKeys.indentPatients(q),
    queryFn: async () => (await api.get("/api/pharmacy/indents/patients", { params: { q } })).data,
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
}

export function useReceptionBill(id) {
  return useQuery({
    queryKey: departmentKeys.collectBill(id),
    queryFn: async () => (await api.get(`/api/pharmacy/collect/bills/${id}`)).data,
    enabled: Boolean(id),
  });
}

function useStockMutation(url, invalidate) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await api.post(url, input)).data,
    onSuccess: () => {
      for (const key of [...STOCK_KEYS, ...invalidate]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export const useCreateTransfer = () =>
  useStockMutation("/api/pharmacy/transfers", [["pharmacy-transfers"]]);

export const useCreateIndent = () =>
  useStockMutation("/api/pharmacy/indents", [["pharmacy-indents"], billKeys.all, creditKeys.all]);

export const useCreateVendorReturn = () =>
  useStockMutation("/api/pharmacy/vendor-returns", [
    ["pharmacy-expiry"],
    ["pharmacy-vendor-returns"],
  ]);

export function useReturnIndent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }) =>
      (await api.post(`/api/pharmacy/indents/${id}/returns`, input)).data,
    onSuccess: () => {
      for (const key of [
        ...STOCK_KEYS,
        ["pharmacy-indents"],
        billKeys.all,
        creditKeys.all,
        ["pharmacy-collect"],
      ]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export function useIndent(id) {
  return useQuery({
    queryKey: ["pharmacy-indents", "one", String(id)],
    queryFn: async () => (await api.get(`/api/pharmacy/indents/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useReceptionCollect() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId, ...input }) =>
      (await api.post(`/api/pharmacy/collect/bills/${billId}/payments`, input)).data,
    onSuccess: () => {
      for (const key of [["pharmacy-collect"], billKeys.all, creditKeys.all, ["billing"]]) {
        queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}
