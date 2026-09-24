import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";
import { billingKeys } from "./useBillingMaster";

const DESK = "/api/billing";

const DUES = billingKeys.dues().slice(0, -1);
const SHIFTS_MINE = billingKeys.myShifts().slice(0, -1);

const read = async (url, params) => (await api.get(url, params ? { params } : undefined)).data;

const authToken = () => localStorage.getItem("gini_auth_token") || "";

export const billPdfHref = (billId) =>
  `${API_URL}${DESK}/bills/${billId}/bill.pdf?token=${encodeURIComponent(authToken())}`;

export const receiptPdfHref = (billId, paymentId) =>
  `${API_URL}${DESK}/bills/${billId}/receipt.pdf?token=${encodeURIComponent(authToken())}` +
  (paymentId ? `&payment_id=${encodeURIComponent(paymentId)}` : "");

function useVisitMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (_bill, variables) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.visitBills(variables?.visitId) });
      queryClient.invalidateQueries({ queryKey: billingKeys.visitNotPriced(variables?.visitId) });
    },
  });
}

export function useVisitBills(visitId) {
  return useQuery({
    queryKey: billingKeys.visitBills(visitId),
    queryFn: () => read(`${DESK}/visits/${visitId}/bills`),
    enabled: !!visitId,
  });
}

export function useVisitNotPriced(visitId) {
  return useQuery({
    queryKey: billingKeys.visitNotPriced(visitId),
    queryFn: () => read(`${DESK}/visits/${visitId}/not-priced`),
    enabled: !!visitId,
  });
}

export function useOpenDraft() {
  return useVisitMutation(
    async ({ visitId }) => (await api.post(`${DESK}/visits/${visitId}/bills`, {})).data,
  );
}

export function useRereadBill() {
  return useMutation({ mutationFn: async ({ billId }) => read(`${DESK}/bills/${billId}`) });
}

export function useSetBillCategory() {
  return useVisitMutation(
    async ({ billId, visitId, ...body }) =>
      (await api.patch(`${DESK}/bills/${billId}/category`, body)).data,
  );
}

export function useChangeLineQuantity() {
  return useVisitMutation(
    async ({ billId, lineId, quantity }) =>
      (await api.patch(`${DESK}/bills/${billId}/lines/${lineId}`, { quantity })).data,
  );
}

export function useRemoveBillLine() {
  return useVisitMutation(
    async ({ billId, lineId, reason }) =>
      (await api.post(`${DESK}/bills/${billId}/lines/${lineId}/remove`, { reason })).data,
  );
}

export function usePatientSchemeList() {
  return useQuery({
    queryKey: ["patient-schemes"],
    queryFn: () => read("/api/patient-schemes"),
    staleTime: 10 * 60 * 1000,
  });
}

export function useDeskSettings() {
  return useQuery({
    queryKey: billingKeys.deskSettings(),
    queryFn: () => read(`${DESK}/desk-settings`),
    staleTime: 5 * 60 * 1000,
  });
}

export function useItemSearch(q) {
  return useQuery({
    queryKey: billingKeys.deskItems(q),
    queryFn: () => read(`${DESK}/items/search`, q ? { q } : undefined),
    staleTime: 60 * 1000,
  });
}

export function useAddBillLine() {
  return useVisitMutation(
    async ({ billId, visitId, ...body }) =>
      (await api.post(`${DESK}/bills/${billId}/lines`, body)).data,
  );
}

export function useAddCode() {
  return useVisitMutation(
    async ({ billId, code }) => (await api.post(`${DESK}/bills/${billId}/codes`, { code })).data,
  );
}

export function useRemoveCode() {
  return useVisitMutation(
    async ({ billId, code }) =>
      (await api.delete(`${DESK}/bills/${billId}/codes/${encodeURIComponent(code)}`)).data,
  );
}

export function useFinaliseBill() {
  return useVisitMutation(
    async ({ billId, visitId, ...body }) =>
      (await api.post(`${DESK}/bills/${billId}/finalise`, body)).data,
  );
}

export function useCancelBill() {
  return useVisitMutation(
    async ({ billId, reason }) =>
      (await api.post(`${DESK}/bills/${billId}/cancel`, { reason })).data,
  );
}

export function useTakePayments() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ billId, version, payments }) => {
      await api.post(`${DESK}/bills/${billId}/payments`, { version, payments });
      try {
        return await read(`${DESK}/bills/${billId}`);
      } catch (e) {
        e.paymentTaken = true;
        throw e;
      }
    },
    onSettled: (_bill, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.visitBills(variables?.visitId) });
      queryClient.invalidateQueries({ queryKey: billingKeys.billPayments(variables?.billId) });
      queryClient.invalidateQueries({ queryKey: billingKeys.currentShift() });
      queryClient.invalidateQueries({ queryKey: DUES });
    },
  });
}

export function useBillPayments(billId) {
  return useQuery({
    queryKey: billingKeys.billPayments(billId),
    queryFn: () => read(`${DESK}/bills/${billId}/payments`),
    enabled: !!billId,
  });
}

export function useDues(filters) {
  return useQuery({
    queryKey: billingKeys.dues(filters),
    queryFn: () => read(`${DESK}/dues`, filters),
  });
}

export function useMyShifts(filters) {
  return useQuery({
    queryKey: billingKeys.myShifts(filters),
    queryFn: () => read(`${DESK}/shifts/mine`, filters),
  });
}

export function useCurrentShift() {
  return useQuery({
    queryKey: billingKeys.currentShift(),
    queryFn: () => read(`${DESK}/shifts/current`),
  });
}

function useShiftMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: billingKeys.currentShift() }),
        queryClient.invalidateQueries({ queryKey: SHIFTS_MINE }),
      ]),
  });
}

export function useOpenShift() {
  return useShiftMutation(async (body) => (await api.post(`${DESK}/shifts/open`, body ?? {})).data);
}

export function useCloseShift() {
  return useShiftMutation(async (body) => (await api.post(`${DESK}/shifts/close`, body)).data);
}

export function useMyRequests(visitId) {
  return useQuery({
    queryKey: billingKeys.myRequests({ visitId: visitId || "any" }),
    queryFn: () => read(`${DESK}/requests/mine`),
    refetchInterval: 15 * 1000,
  });
}

function useRequestMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["billing", "requests", "mine"] }),
  });
}

export function useNewItemRequest() {
  return useRequestMutation(
    async (body) => (await api.post(`${DESK}/requests/new-item`, body)).data,
  );
}

export function useRepeatRequest() {
  return useRequestMutation(async (body) => (await api.post(`${DESK}/requests/repeat`, body)).data);
}
