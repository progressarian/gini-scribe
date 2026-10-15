import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { fileNameOf, readBlobError } from "./useBillingMaster";
import { opdSummaryFileName } from "../../../shared/opdSummary.js";

const BASE = "/api/reports/opd";

const withoutBlanks = (params = {}) =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );

const retryUnlessRefused = (count, e) => !(e?.response?.status < 500) && count < 1;

export const opdSummaryKeys = {
  all: ["reports", "opd"],
  summary: (params) => ["reports", "opd", "summary", params],
  visits: (params) => ["reports", "opd", "visits", params],
  filters: (month) => ["reports", "opd", "filters", month],
};

const get = (path, params) => async () => (await api.get(`${BASE}/${path}`, { params })).data;

export function useOpdSummary(filters) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: opdSummaryKeys.summary(params),
    queryFn: get("summary", params),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: retryUnlessRefused,
  });
}

export function useOpdVisits(filters) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: opdSummaryKeys.visits(params),
    queryFn: get("visits", params),
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: retryUnlessRefused,
  });
}

export function useOpdFilters(month) {
  return useQuery({
    queryKey: opdSummaryKeys.filters(month),
    queryFn: get("filters", withoutBlanks({ month })),
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
    retry: retryUnlessRefused,
  });
}

export function useOpdSummaryExport() {
  return useMutation({
    mutationFn: async (filters) => {
      const response = await api
        .get(`${BASE}/export.xlsx`, { params: withoutBlanks(filters), responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(response.headers, opdSummaryFileName(filters.month)),
      };
    },
  });
}
