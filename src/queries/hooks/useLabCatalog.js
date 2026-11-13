import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

export const LAB_CATALOG_KEY = ["lab-catalog"];
const BASE = "/api/lab-catalog";

export function useLabCatalogTest(catalogId) {
  return useQuery({
    queryKey: [...LAB_CATALOG_KEY, "test", catalogId],
    queryFn: async () => (await api.get(`${BASE}/tests/${catalogId}`)).data,
    enabled: Boolean(catalogId),
  });
}

export function useLabCatalogHistory(catalogId, enabled = true) {
  return useQuery({
    queryKey: [...LAB_CATALOG_KEY, "history", catalogId],
    queryFn: async () => (await api.get(`${BASE}/tests/${catalogId}/history`)).data,
    enabled: Boolean(catalogId) && enabled,
  });
}

export function useLabReportSearch(q, enabled = true) {
  return useQuery({
    queryKey: [...LAB_CATALOG_KEY, "reports", q],
    queryFn: async () => (await api.get(`${BASE}/reports`, { params: { q } })).data,
    enabled,
  });
}

function useCatalogWrite(request) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars) => (await request(vars)).data,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: LAB_CATALOG_KEY });
      queryClient.invalidateQueries({ queryKey: ["giniflow", "test-catalog"] });
    },
  });
}

export const useLinkReport = () =>
  useCatalogWrite(({ catalogId, ...body }) => api.put(`${BASE}/tests/${catalogId}/report`, body));

export const useUnlinkReport = () =>
  useCatalogWrite(({ catalogId, ...body }) =>
    api.delete(`${BASE}/tests/${catalogId}/report`, { data: body }),
  );

export const useCreateReport = () =>
  useCatalogWrite(({ catalogId, ...body }) => api.post(`${BASE}/tests/${catalogId}/report`, body));

export const useResultsAsFile = () =>
  useCatalogWrite(({ catalogId, ...body }) =>
    api.put(`${BASE}/tests/${catalogId}/results-as-file`, body),
  );

export const useAddField = () =>
  useCatalogWrite(({ reportId, ...body }) => api.post(`${BASE}/reports/${reportId}/fields`, body));

export const useUpdateField = () =>
  useCatalogWrite(({ fieldId, ...body }) => api.patch(`${BASE}/fields/${fieldId}`, body));

export const useMoveField = () =>
  useCatalogWrite(({ reportId, ...body }) => api.put(`${BASE}/reports/${reportId}/order`, body));

export const useSaveRanges = () =>
  useCatalogWrite(({ fieldId, ...body }) => api.put(`${BASE}/fields/${fieldId}/ranges`, body));

export const useFormulaFromText = () =>
  useMutation({
    mutationFn: async ({ reportId, ...body }) =>
      (await api.post(`${BASE}/reports/${reportId}/formula-from-text`, body)).data,
  });

export const useRemoveField = () =>
  useCatalogWrite(({ reportId, fieldId, ...body }) =>
    api.delete(`${BASE}/reports/${reportId}/fields/${fieldId}`, { data: body }),
  );
