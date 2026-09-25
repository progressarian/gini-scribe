import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { billingKeys, fileNameOf, readBlobError } from "./useBillingMaster";

const CLAIMS = "/api/billing/claims";

export const claimsKeys = {
  all: [...billingKeys.all, "claims"],
  list: (tab, filters) => [...billingKeys.all, "claims", tab, filters ?? {}],
};

const cleanParams = (filters) =>
  Object.fromEntries(
    Object.entries(filters ?? {}).filter(([, value]) => value !== "" && value !== null),
  );

export function useClaimsRegister(tab, filters) {
  const params = cleanParams(filters);
  return useQuery({
    queryKey: claimsKeys.list(tab, params),
    queryFn: async () => (await api.get(`${CLAIMS}/${tab}`, { params })).data,
    placeholderData: keepPreviousData,
  });
}

function useClaimsChange(send) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: send,
    onSettled: () => queryClient.invalidateQueries({ queryKey: billingKeys.all }),
  });
}

export const useClearClaims = () =>
  useClaimsChange(async (body) => (await api.post(`${CLAIMS}/clear`, body)).data);

export const useUndoClear = () =>
  useClaimsChange(
    async ({ id, reason }) => (await api.post(`${CLAIMS}/settlements/${id}/undo`, { reason })).data,
  );

export function useClaimsExport() {
  return useMutation({
    mutationFn: async ({ tab, filters }) => {
      const response = await api
        .get(`${CLAIMS}/${tab}/export`, { params: cleanParams(filters), responseType: "blob" })
        .catch(readBlobError);
      return {
        blob: response.data,
        fileName: fileNameOf(response.headers, `cghs-${tab}.xlsx`),
      };
    },
  });
}
