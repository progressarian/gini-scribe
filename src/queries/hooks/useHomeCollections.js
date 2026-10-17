import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { fileNameOf, readBlobError } from "./useBillingMaster";

const BASE = "/api/giniflow/stations/lab/home-collections";

const withoutBlanks = (params = {}) =>
  Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
  );

const retryUnlessRefused = (count, e) => !(e?.response?.status < 500) && count < 1;

export function useHomeCollections(filters) {
  const params = withoutBlanks(filters);
  return useQuery({
    queryKey: ["giniflow", "lab", "home-collections", params],
    queryFn: async () => (await api.get(BASE, { params })).data,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    retry: retryUnlessRefused,
  });
}

export function useHomeCollectionsExport() {
  return useMutation({
    mutationFn: async (filters) => {
      const response = await api
        .get(`${BASE}/export.xlsx`, { params: withoutBlanks(filters), responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(
          response.headers,
          `home-collections-${filters.from}-to-${filters.to}.xlsx`,
        ),
      };
    },
  });
}
