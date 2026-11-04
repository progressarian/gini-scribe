import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { fileNameOf, readBlobError } from "./useBillingMaster";
import { dashboardFileName } from "../../../shared/billingDashboardText.js";

const DASHBOARD = "/api/billing/dashboard";

export const billingDashboardKeys = {
  all: ["billing", "dashboard"],
  view: (filters) => ["billing", "dashboard", "view", filters ?? {}],
  charges: (filters) => ["billing", "dashboard", "charges", filters ?? {}],
};

const withoutBlanks = (filters = {}) =>
  Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );

const retryUnlessRefused = (count, e) => !(e?.response?.status < 500) && count < 1;

export function useBillingDashboard(filters, { enabled = true } = {}) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: billingDashboardKeys.view(params),
    queryFn: async () => (await api.get(DASHBOARD, { params })).data,
    enabled,
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    retry: retryUnlessRefused,
  });
}

export function useRefreshBillingDashboard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (filters) => {
      const params = withoutBlanks(filters);
      const data = (await api.get(DASHBOARD, { params: { ...params, refresh: "1" } })).data;
      return { params, data };
    },
    onSuccess: ({ params, data }) =>
      queryClient.setQueryData(billingDashboardKeys.view(params), data),
  });
}

export function useBillingDashboardExport() {
  return useMutation({
    mutationFn: async ({ filters, resolved }) => {
      const params = withoutBlanks(filters);
      const response = await api
        .get(`${DASHBOARD}/export`, { params, responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(response.headers, dashboardFileName(resolved)),
      };
    },
  });
}

export function useChargeDetail(filters) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: billingDashboardKeys.charges(params),
    queryFn: async () => (await api.get(`${DASHBOARD}/charges`, { params })).data,
    enabled: Boolean(params.group),
    placeholderData: (previous) => previous,
    staleTime: 60_000,
    retry: retryUnlessRefused,
  });
}
