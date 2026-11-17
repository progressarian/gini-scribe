import { keepPreviousData, useQuery } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/pharmacy/reports";

export const useReportList = () =>
  useQuery({
    queryKey: ["pharmacy-reports", "list"],
    queryFn: async () => (await api.get(BASE)).data,
    staleTime: Infinity,
  });

export const useReport = (key, params, { enabled = true } = {}) =>
  useQuery({
    queryKey: ["pharmacy-reports", "run", key, params],
    queryFn: async () => (await api.get(`${BASE}/${key}`, { params })).data,
    enabled: Boolean(key) && enabled,
    placeholderData: keepPreviousData,
  });

export const usePharmacyDashboard = () =>
  useQuery({
    queryKey: ["pharmacy-reports", "dashboard"],
    queryFn: async () => (await api.get(`${BASE}/dashboard`)).data,
    refetchInterval: 60 * 1000,
  });

export const reportExportUrl = (key, params) => {
  const query = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== ""),
  ).toString();
  return `${BASE}/${key}/export.xlsx${query ? `?${query}` : ""}`;
};
