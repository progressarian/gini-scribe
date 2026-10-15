import { keepPreviousData, useQuery } from "@tanstack/react-query";
import api from "../../services/api";

const withoutBlanks = (params = {}) =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );

const retryUnlessRefused = (count, e) => !(e?.response?.status < 500) && count < 1;

const paged = (key, path, params) => ({
  queryKey: ["reports", "clinical", key, params],
  queryFn: async () => (await api.get(path, { params })).data,
  staleTime: 60_000,
  placeholderData: keepPreviousData,
  retry: retryUnlessRefused,
});

export function useBiomarkerPatients(bioKey, filters) {
  const params = withoutBlanks(filters);
  return useQuery(paged(["biomarker", bioKey], `/api/reports/today/biomarker/${bioKey}`, params));
}

export function useReportScorecard(filters) {
  const params = withoutBlanks(filters);
  return useQuery(paged(["scorecard"], "/api/reports/today/scorecard", params));
}
