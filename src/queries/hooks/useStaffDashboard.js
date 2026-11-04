import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { fileNameOf, readBlobError } from "./useBillingMaster";

const STAFF = "/api/billing/staff";

export const staffDashboardKeys = {
  all: ["billing", "staff"],
  view: (filters) => ["billing", "staff", "view", filters ?? {}],
  shift: (id) => ["billing", "staff", "shift", id],
};

const withoutBlanks = (filters = {}) =>
  Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== ""));

const retryUnlessRefused = (count, e) => !(e?.response?.status < 500) && count < 1;

export function useStaffDashboard(filters, { enabled = true } = {}) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: staffDashboardKeys.view(params),
    queryFn: async () => (await api.get(STAFF, { params })).data,
    enabled,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    refetchInterval: 120_000,
    retry: retryUnlessRefused,
  });
}

export function useStaffShift(id) {
  return useQuery({
    queryKey: staffDashboardKeys.shift(id),
    queryFn: async () => (await api.get(`${STAFF}/shifts/${id}`)).data,
    enabled: Boolean(id),
    staleTime: 30_000,
    retry: retryUnlessRefused,
  });
}

export function useAdminCloseShift() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...body }) =>
      (await api.post(`/api/billing/master/shifts/${id}/close`, body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: staffDashboardKeys.all }),
  });
}

export function useShiftHandover(id) {
  return useQuery({
    queryKey: ["billing", "staff", "handover", id],
    queryFn: async () => (await api.get(`/api/billing/shifts/${id}/handover`)).data,
    enabled: Boolean(id),
    retry: retryUnlessRefused,
  });
}

export function useStaffDashboardExport() {
  return useMutation({
    mutationFn: async (filters) => {
      const params = withoutBlanks(filters);
      const response = await api
        .get(`${STAFF}/export`, { params, responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(
          response.headers,
          `staff-and-shifts-${params.from}-to-${params.to}.xlsx`,
        ),
      };
    },
  });
}
