import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";
import { billingKeys } from "./useBillingMaster";
import { pollInterval } from "./giniflowPolling";

const DESK = "/api/billing";

const DUES = billingKeys.dues().slice(0, -1);
const SHIFTS_MINE = billingKeys.myShifts().slice(0, -1);
const COUNTER_PATIENTS = ["giniflow", "reception", "billing-counter"];
const REFUND_BOARD = ["billing", "refund-board"];
const REFUND_BOARD_POLL_MS = 20 * 1000;

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
      queryClient.invalidateQueries({ queryKey: COUNTER_PATIENTS });
    },
  });
}

export function useCounterPatients(q = "", { enabled = true } = {}) {
  return useQuery({
    queryKey: [...COUNTER_PATIENTS, q],
    queryFn: () => read(`${DESK}/counter/patients`, q ? { q } : undefined),
    enabled,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });
}

export function useVisitBills(visitId) {
  return useQuery({
    queryKey: billingKeys.visitBills(visitId),
    queryFn: () => read(`${DESK}/visits/${visitId}/bills`),
    enabled: !!visitId,
    refetchInterval: 15 * 1000,
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

export function useDeskSettings({ enabled = true } = {}) {
  return useQuery({
    queryKey: billingKeys.deskSettings(),
    queryFn: () => read(`${DESK}/desk-settings`),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export const ITEM_SEARCH_MIN = 2;
export const ITEM_SEARCH_LIMIT = 20;

export function useItemSearch(q, visitId) {
  return useQuery({
    queryKey: [...billingKeys.deskItems(q), visitId ?? null],
    queryFn: () =>
      read(`${DESK}/items/search`, {
        q,
        limit: ITEM_SEARCH_LIMIT,
        ...(visitId ? { visit_id: visitId } : {}),
      }),
    enabled: q.length >= ITEM_SEARCH_MIN,
    staleTime: 60 * 1000,
  });
}

export function useConsultationSuggestion(billId, version, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...billingKeys.bill(billId), "consultation-suggestion", version ?? 0],
    queryFn: () => read(`${DESK}/consultation-suggestion`, { bill_id: billId }),
    enabled: !!billId && enabled,
  });
}

export function useLabCaseTests(billId, version, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...billingKeys.bill(billId), "lab-case-tests", version ?? 0],
    queryFn: () => read(`${DESK}/lab-case-tests`, { bill_id: billId }),
    enabled: !!billId && enabled,
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: false,
  });
}

export function useHealthrayBillLines(billId, version, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...billingKeys.bill(billId), "healthray-bill-lines", version ?? 0],
    queryFn: () => read(`${DESK}/healthray-bill-lines`, { bill_id: billId }),
    enabled: !!billId && enabled,
    refetchInterval: 60 * 1000,
    refetchIntervalInBackground: false,
  });
}

export function useAddLabCaseTests() {
  return useVisitMutation(
    async ({ billId, itemIds }) =>
      (await api.post(`${DESK}/bills/${billId}/lab-case-lines`, { item_ids: itemIds })).data,
  );
}

export function useAddBillLine() {
  return useVisitMutation(
    async ({ billId, visitId, ...body }) =>
      (await api.post(`${DESK}/bills/${billId}/lines`, body)).data,
  );
}

export function useSetLinePrice() {
  return useVisitMutation(
    async ({ billId, lineId, agreed_rate, reason }) =>
      (await api.post(`${DESK}/bills/${billId}/lines/${lineId}/price`, { agreed_rate, reason }))
        .data,
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

export function useDeleteDraft() {
  return useVisitMutation(
    async ({ billId, reason }) =>
      (await api.post(`${DESK}/bills/${billId}/delete-draft`, { reason })).data,
  );
}

export function useSaveDraft() {
  return useVisitMutation(
    async ({ billId }) => (await api.post(`${DESK}/bills/${billId}/save-draft`, {})).data,
  );
}

export function useDiscardDraft() {
  return useVisitMutation(
    async ({ billId }) => (await api.post(`${DESK}/bills/${billId}/discard-draft`, {})).data,
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
      queryClient.invalidateQueries({ queryKey: COUNTER_PATIENTS });
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

export function useDuesToday() {
  return useQuery({
    queryKey: [...DUES, "today"],
    queryFn: () => read(`${DESK}/dues/today`),
  });
}

export function usePatientDues(patientId) {
  return useQuery({
    queryKey: billingKeys.dues({ patient_id: patientId }),
    queryFn: () => read(`${DESK}/dues`, { patient_id: patientId }),
    enabled: !!patientId,
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

export const creditNotePdfHref = (creditNoteId) =>
  `${API_URL}${DESK}/credit-notes/${creditNoteId}/credit-note.pdf?token=${encodeURIComponent(authToken())}`;

export const refundReceiptPdfHref = (creditNoteId) =>
  `${API_URL}${DESK}/credit-notes/${creditNoteId}/refund-receipt.pdf?token=${encodeURIComponent(authToken())}`;

const refundsKey = (billId) => [...billingKeys.bill(billId), "refunds"];

export function useCreditableLines(billId, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...billingKeys.bill(billId), "creditable"],
    queryFn: () => read(`${DESK}/bills/${billId}/creditable`),
    enabled: !!billId && enabled,
  });
}

export function useRefundPreview(body, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...billingKeys.bill(body?.bill_id), "refund-preview", body],
    queryFn: async () => (await api.post(`${DESK}/refunds/preview`, body)).data,
    enabled: !!body?.bill_id && enabled,
    retry: false,
    placeholderData: (prev) => prev,
  });
}

export function useBillRefunds(billId, { enabled = true } = {}) {
  return useQuery({
    queryKey: refundsKey(billId),
    queryFn: () => read(`${DESK}/bills/${billId}/refunds`),
    enabled: !!billId && enabled,
    refetchInterval: 15 * 1000,
    refetchIntervalInBackground: false,
  });
}

function useRefundMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: refundsKey(variables?.billId) });
      queryClient.invalidateQueries({ queryKey: billingKeys.visitBills(variables?.visitId) });
      queryClient.invalidateQueries({ queryKey: billingKeys.currentShift() });
      queryClient.invalidateQueries({ queryKey: DUES });
      queryClient.invalidateQueries({ queryKey: COUNTER_PATIENTS });
      queryClient.invalidateQueries({ queryKey: ["billing", "requests"] });
      queryClient.invalidateQueries({ queryKey: REFUND_BOARD });
    },
  });
}

export function useRefundBoard(filters = {}, { enabled = true } = {}) {
  return useQuery({
    queryKey: [...REFUND_BOARD, filters],
    queryFn: () => read(`${DESK}/refunds`, filters),
    enabled,
    refetchInterval: REFUND_BOARD_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
}

export function useRefundRequest() {
  return useRefundMutation(
    async ({ billId, visitId, ...body }) =>
      (await api.post(`${DESK}/requests/refund`, { bill_id: billId, ...body })).data,
  );
}

export function usePayOut() {
  return useRefundMutation(
    async ({ creditNoteId, version, payments }) =>
      (await api.post(`${DESK}/credit-notes/${creditNoteId}/pay-out`, { version, payments })).data,
  );
}
