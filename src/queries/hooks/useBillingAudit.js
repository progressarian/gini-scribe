import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import api, { API_URL } from "../../services/api";
import { billingKeys, fileNameOf, readBlobError } from "./useBillingMaster";

const BASE = "/api/billing/audit";
const PATH = { bills: `${BASE}/bills`, items: `${BASE}/items` };

const cleanParams = (filters) =>
  Object.fromEntries(
    Object.entries(filters ?? {}).filter(([, value]) => value !== "" && value !== null),
  );

const retryUnlessRefused = (count, error) => {
  const status = error?.response?.status;
  return !(status >= 400 && status < 500) && count < 2;
};

const authToken = () => localStorage.getItem("gini_auth_token") || "";

export const billingAuditKeys = {
  all: () => [...billingKeys.all, "audit"],
  list: (view, params) => [...billingAuditKeys.all(), view, params ?? {}],
};

export function useBillingAudit(view, filters, enabled = true) {
  const params = cleanParams(filters);
  return useQuery({
    queryKey: billingAuditKeys.list(view, params),
    queryFn: async () => (await api.get(PATH[view], { params })).data,
    placeholderData: keepPreviousData,
    retry: retryUnlessRefused,
    enabled,
  });
}

export function useBillingAuditExport() {
  return useMutation({
    mutationFn: async ({ view, filters }) => {
      const response = await api
        .get(`${PATH[view]}/export`, { params: cleanParams(filters), responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(response.headers, `billing-audit-${view}.xlsx`),
      };
    },
  });
}

export const auditBillPdfHref = (billId) =>
  `${API_URL}${BASE}/bills/${billId}/bill.pdf?token=${encodeURIComponent(authToken())}`;
