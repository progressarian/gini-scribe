import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";

const BASE = "/api/pharmacy/bills";

const authToken = () => localStorage.getItem("gini_auth_token") || "";

export const pharmacyBillPdfUrl = (id) =>
  `${API_URL}${BASE}/${id}/bill.pdf?token=${encodeURIComponent(authToken())}`;

export const billKeys = {
  all: ["pharmacy-bills"],
  list: (params) => ["pharmacy-bills", "list", params],
  one: (id) => ["pharmacy-bills", "one", String(id)],
  patients: (q) => ["pharmacy-bills", "patients", q],
  prescription: (id) => ["pharmacy-bills", "prescription", String(id)],
  returns: (id) => ["pharmacy-bills", "returns", String(id)],
};

const STOCK_KEYS = [["pharmacy-stock"], ["pharmacy-batches"]];

export function useBillList(params) {
  return useQuery({
    queryKey: billKeys.list(params),
    queryFn: async () => (await api.get(BASE, { params })).data,
    placeholderData: keepPreviousData,
  });
}

export function useBill(id) {
  return useQuery({
    queryKey: billKeys.one(id),
    queryFn: async () => (await api.get(`${BASE}/${id}`)).data,
    enabled: Boolean(id),
  });
}

export function useBillPrescription(id, { enabled = true } = {}) {
  return useQuery({
    queryKey: billKeys.prescription(id),
    queryFn: async () => (await api.get(`${BASE}/${id}/prescription`)).data,
    enabled: Boolean(id) && enabled,
  });
}

export function useBillPatientSearch(q) {
  return useQuery({
    queryKey: billKeys.patients(q),
    queryFn: async () => (await api.get(`${BASE}/patients`, { params: { q } })).data,
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
}

export function useCreateWalkin() {
  return useMutation({
    mutationFn: async (input) => (await api.post(`${BASE}/patients`, input)).data,
  });
}

function useBillMutation(request, { touchesStock = false } = {}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await request(input)).data,
    onSuccess: (bill) => {
      if (bill?.lines) {
        queryClient.setQueryData(billKeys.one(bill.id), bill);
        queryClient.invalidateQueries({ queryKey: billKeys.prescription(bill.id) });
      }
      queryClient.invalidateQueries({ queryKey: [...billKeys.all, "list"] });
      if (touchesStock) {
        for (const key of STOCK_KEYS) queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export const useCreateBill = () => useBillMutation((input) => api.post(BASE, input));

export const useSaveBill = () =>
  useBillMutation(({ id, ...input }) => api.put(`${BASE}/${id}`, input));

export const useFinaliseBill = () =>
  useBillMutation(({ id, ...input }) => api.post(`${BASE}/${id}/finalise`, input), {
    touchesStock: true,
  });

export function useDiscardBill() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, version }) =>
      (await api.post(`${BASE}/${id}/discard`, { version })).data,
    onSuccess: ({ id }) => {
      queryClient.removeQueries({ queryKey: billKeys.one(id) });
      queryClient.invalidateQueries({ queryKey: [...billKeys.all, "list"] });
    },
  });
}

export function useBillReturns(id, { enabled = true } = {}) {
  return useQuery({
    queryKey: billKeys.returns(id),
    queryFn: async () => (await api.get(`${BASE}/${id}/returns`)).data,
    enabled: Boolean(id) && enabled,
  });
}

export function useCreateReturn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }) => (await api.post(`${BASE}/${id}/returns`, input)).data,
    onSuccess: (note) => {
      queryClient.setQueryData(billKeys.one(note.id), note);
      queryClient.invalidateQueries({ queryKey: billKeys.one(note.original_bill_id) });
      queryClient.invalidateQueries({ queryKey: billKeys.returns(note.original_bill_id) });
      queryClient.invalidateQueries({ queryKey: [...billKeys.all, "list"] });
      for (const key of STOCK_KEYS) queryClient.invalidateQueries({ queryKey: key });
    },
  });
}
