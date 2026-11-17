import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/pharmacy/purchases";

export const purchaseKeys = {
  all: ["pharmacy-purchases"],
  list: (params) => ["pharmacy-purchases", "list", params],
  one: (id) => ["pharmacy-purchases", "one", String(id)],
};

const STOCK_KEYS = [["pharmacy-stock"], ["pharmacy-batches"]];

export function usePurchaseList(params) {
  return useQuery({
    queryKey: purchaseKeys.list(params),
    queryFn: async () => (await api.get(BASE, { params })).data,
    placeholderData: keepPreviousData,
  });
}

export function usePurchase(id) {
  return useQuery({
    queryKey: purchaseKeys.one(id),
    queryFn: async () => (await api.get(`${BASE}/${id}`)).data,
    enabled: Boolean(id),
  });
}

function usePurchaseMutation(request, { touchesStock = false } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await request(input)).data,
    onSuccess: (purchase) => {
      queryClient.setQueryData(purchaseKeys.one(purchase.id), purchase);
      queryClient.invalidateQueries({ queryKey: [...purchaseKeys.all, "list"] });
      if (touchesStock) {
        for (const key of STOCK_KEYS) queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export const useCreatePurchase = () => usePurchaseMutation((input) => api.post(BASE, input));

export const useSavePurchase = () =>
  usePurchaseMutation(({ id, ...input }) => api.put(`${BASE}/${id}`, input));

export const usePostPurchase = () =>
  usePurchaseMutation(({ id, version }) => api.post(`${BASE}/${id}/post`, { version }), {
    touchesStock: true,
  });

export const useCancelPurchase = () =>
  usePurchaseMutation(({ id, version, reason }) =>
    api.post(`${BASE}/${id}/cancel`, { version, reason }),
  );

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function useImportReceipt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, version, file }) =>
      (
        await api.post(`${BASE}/${id}/import`, file, {
          params: { version },
          headers: { "Content-Type": XLSX },
        })
      ).data,
    onSuccess: ({ purchase }) => {
      queryClient.setQueryData(purchaseKeys.one(purchase.id), purchase);
      queryClient.invalidateQueries({ queryKey: [...purchaseKeys.all, "list"] });
    },
  });
}

export const RECEIPT_TEMPLATE_URL = `${BASE}/template.xlsx`;
