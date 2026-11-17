import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/pharmacy/batches";

export const batchKeys = {
  all: ["pharmacy-batches"],
  locations: ["pharmacy-batches", "locations"],
  stock: (params) => ["pharmacy-batches", "stock", params],
  summary: (locationId) => ["pharmacy-batches", "summary", String(locationId ?? "main")],
  medicine: (params) => ["pharmacy-batches", "medicine", params],
  movements: (id, params) => ["pharmacy-batches", "movements", String(id), params],
  adjustments: (params) => ["pharmacy-batches", "adjustments", params],
};

const get = async (url, params) => (await api.get(url, { params })).data;

export const useStockLocations = () =>
  useQuery({ queryKey: batchKeys.locations, queryFn: () => get(`${BASE}/locations`) });

export const useBatchStock = (params, { enabled = true } = {}) =>
  useQuery({
    queryKey: batchKeys.stock(params),
    queryFn: () => get(`${BASE}/stock`, params),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useBatchSummary = (locationId) =>
  useQuery({
    queryKey: batchKeys.summary(locationId),
    queryFn: () => get(`${BASE}/summary`, locationId ? { location_id: locationId } : {}),
  });

export const useMedicineBatches = (params, { enabled = true } = {}) =>
  useQuery({
    queryKey: batchKeys.medicine(params),
    queryFn: () => get(BASE, params),
    enabled: enabled && Boolean(params?.medicine_id),
  });

export const useBatchMovements = (id, params) =>
  useQuery({
    queryKey: batchKeys.movements(id, params),
    queryFn: () => get(`${BASE}/${id}/movements`, params),
    placeholderData: keepPreviousData,
    enabled: Boolean(id),
  });

export const useAdjustments = (params) =>
  useQuery({
    queryKey: batchKeys.adjustments(params),
    queryFn: () => get("/api/pharmacy/adjustments", params),
    placeholderData: keepPreviousData,
  });

export function useAdjustStock() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await api.post("/api/pharmacy/adjustments", input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: batchKeys.all }),
  });
}

export const useStockList = (params) =>
  useQuery({
    queryKey: [...batchKeys.all, "list", params],
    queryFn: () => get(`${BASE}/list`, params),
    placeholderData: keepPreviousData,
  });
