import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/pharmacy/settings";
export const pharmacySettingsKey = ["pharmacy-settings"];

export function usePharmacySettings() {
  return useQuery({
    queryKey: pharmacySettingsKey,
    queryFn: async () => (await api.get(BASE)).data,
  });
}

export function useSavePharmacySettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await api.put(BASE, input)).data,
    onSuccess: (saved) => queryClient.setQueryData(pharmacySettingsKey, saved),
  });
}

const seriesKey = ["pharmacy-settings", "series"];

export function usePharmacySeries() {
  return useQuery({
    queryKey: seriesKey,
    queryFn: async () => (await api.get(`${BASE}/series`)).data,
  });
}

export function useSavePharmacySeries() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input) => (await api.put(`${BASE}/series`, input)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: seriesKey }),
  });
}
