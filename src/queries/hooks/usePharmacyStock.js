import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/pharmacy/stock";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const stockKeys = {
  all: ["pharmacy-stock"],
  list: (params) => ["pharmacy-stock", "list", params],
  summary: ["pharmacy-stock", "summary"],
  uploads: ["pharmacy-stock", "uploads"],
  upload: (id) => ["pharmacy-stock", "upload", id],
  links: (itemKey) => ["pharmacy-stock", "links", itemKey],
  needed: ["pharmacy-stock", "needed"],
};

export function useStockList(params) {
  return useQuery({
    queryKey: stockKeys.list(params),
    queryFn: async () => (await api.get(BASE, { params })).data,
    placeholderData: keepPreviousData,
  });
}

export function useStockSummary() {
  return useQuery({
    queryKey: stockKeys.summary,
    queryFn: async () => (await api.get(`${BASE}/summary`)).data,
  });
}

export function useStockUploads(enabled) {
  return useQuery({
    queryKey: stockKeys.uploads,
    queryFn: async () => (await api.get(`${BASE}/uploads`)).data,
    enabled,
  });
}

export function useStockUpload(id) {
  return useQuery({
    queryKey: stockKeys.upload(id),
    queryFn: async () => (await api.get(`${BASE}/uploads/${id}`)).data,
    enabled: !!id,
  });
}

export function useCreateStockUpload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file) =>
      (
        await api.post(`${BASE}/uploads`, file, {
          params: { fileName: file.name },
          headers: { "Content-Type": XLSX_TYPE },
        })
      ).data,
    onSuccess: (upload) => {
      queryClient.setQueryData(stockKeys.upload(upload.id), upload);
      queryClient.invalidateQueries({ queryKey: stockKeys.uploads });
    },
  });
}

export function useCommitStockUpload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => (await api.post(`${BASE}/uploads/${id}/commit`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: stockKeys.all }),
  });
}

export function useDiscardStockUpload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id) => (await api.post(`${BASE}/uploads/${id}/discard`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: stockKeys.uploads }),
  });
}

export function useStockLinks(itemKey) {
  return useQuery({
    queryKey: stockKeys.links(itemKey),
    queryFn: async () => (await api.get(`${BASE}/items/${encodeURIComponent(itemKey)}/links`)).data,
    enabled: !!itemKey,
  });
}

function useLinkMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: (data, { itemKey }) => {
      queryClient.setQueryData(stockKeys.links(itemKey), data);
      queryClient.invalidateQueries({ queryKey: ["pharmacy-stock", "list"] });
      queryClient.invalidateQueries({ queryKey: stockKeys.summary });
    },
  });
}

export const useAddStockLink = () =>
  useLinkMutation(
    async ({ itemKey, medicineName }) =>
      (await api.post(`${BASE}/items/${encodeURIComponent(itemKey)}/links`, { medicineName })).data,
  );

export const useRemoveStockLink = () =>
  useLinkMutation(
    async ({ itemKey, medicineKey }) =>
      (
        await api.delete(
          `${BASE}/items/${encodeURIComponent(itemKey)}/links/${encodeURIComponent(medicineKey)}`,
        )
      ).data,
  );

export function useNeededStock() {
  return useQuery({
    queryKey: stockKeys.needed,
    queryFn: async () => (await api.get(`${BASE}/needed`)).data,
  });
}

function useNeededMutation(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: stockKeys.needed }),
  });
}

export function useMarkNeededOrdered() {
  return useNeededMutation(async (body) => (await api.post(`${BASE}/needed/ordered`, body)).data);
}

export function useClearNeededOrdered() {
  return useNeededMutation(
    async ({ medicineKey }) =>
      (await api.post(`${BASE}/needed/ordered/clear`, { medicineKey })).data,
  );
}
