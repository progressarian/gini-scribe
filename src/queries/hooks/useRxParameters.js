import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const station = (visitId) => `/api/giniflow/stations/doctor/${visitId}`;

export const rxParameterKeys = {
  table: (visitId) => ["giniflow", "rx-parameters", visitId],
  summary: (visitId) => ["giniflow", "visit-summary", visitId],
  defaults: ["admin", "rx-parameters"],
};

export function useRxParameters(visitId) {
  return useQuery({
    queryKey: rxParameterKeys.table(visitId),
    queryFn: async () => (await api.get(`${station(visitId)}/rx-parameters`)).data,
    enabled: !!visitId,
  });
}

export function useSaveRxParameters(visitId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows) => (await api.put(`${station(visitId)}/rx-parameters`, { rows })).data,
    onSuccess: (data) => qc.setQueryData(rxParameterKeys.table(visitId), data),
  });
}

export function useVisitSummary(visitId) {
  return useQuery({
    queryKey: rxParameterKeys.summary(visitId),
    queryFn: async () => (await api.get(`${station(visitId)}/visit-summary`)).data,
    enabled: !!visitId,
  });
}

export function useGenerateVisitSummary(visitId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post(`${station(visitId)}/visit-summary`)).data,
    onSuccess: (data) => qc.setQueryData(rxParameterKeys.summary(visitId), data),
  });
}

export function useRxParameterDefaults() {
  return useQuery({
    queryKey: rxParameterKeys.defaults,
    queryFn: async () => (await api.get("/api/admin/rx-parameters")).data,
  });
}

export function useSaveRxParameterDefaults() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (parameters) =>
      (await api.put("/api/admin/rx-parameters", { parameters })).data,
    onSuccess: (data) => qc.setQueryData(rxParameterKeys.defaults, data),
  });
}
