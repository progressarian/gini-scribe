import { useMutation, useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { fileNameOf, readBlobError } from "./useBillingMaster";
import { reportFileName } from "../../../shared/billingReportFiles.js";

const REPORTS = "/api/billing/reports";

export const billingReportKeys = {
  all: ["billing", "reports"],
  catalog: () => ["billing", "reports", "catalog"],
  report: (key, filters) => ["billing", "reports", key ?? "none", filters ?? {}],
};

const withoutBlanks = (filters = {}) =>
  Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );

const retryUnlessRefused = (count, e) => !(e?.response?.status < 500) && count < 1;

export function useBillingReportCatalog() {
  return useQuery({
    queryKey: billingReportKeys.catalog(),
    queryFn: async () => (await api.get(REPORTS)).data,
    staleTime: 5 * 60_000,
    retry: retryUnlessRefused,
  });
}

export function useBillingReport(key, filters, { enabled = true } = {}) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: billingReportKeys.report(key, params),
    queryFn: async () => (await api.get(`${REPORTS}/${key}`, { params })).data,
    enabled: Boolean(key) && enabled,
    placeholderData: (prev) => (prev?.key === key ? prev : undefined),
    retry: retryUnlessRefused,
  });
}

export function useBillingReportExport() {
  return useMutation({
    mutationFn: async ({ key, filters }) => {
      const response = await api
        .get(`${REPORTS}/${key}/export`, { params: withoutBlanks(filters), responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(response.headers, reportFileName(key, filters)),
      };
    },
  });
}
