import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const stationPath = (visitId, station) => `/api/giniflow/stations/${station}/${visitId}`;

export const rxParameterKeys = {
  table: (visitId, station = "doctor") => ["giniflow", "rx-parameters", station, visitId],
  summary: (visitId, station = "doctor") => ["giniflow", "visit-summary", station, visitId],
  defaults: ["admin", "rx-parameters"],
};

export function useRxParameters(visitId, station = "doctor") {
  return useQuery({
    queryKey: rxParameterKeys.table(visitId, station),
    queryFn: async () => (await api.get(`${stationPath(visitId, station)}/rx-parameters`)).data,
    enabled: !!visitId,
  });
}

export function useSaveRxParameters(visitId, station = "doctor") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows) =>
      (await api.put(`${stationPath(visitId, station)}/rx-parameters`, { rows })).data,
    onSuccess: (data) => {
      qc.setQueryData(rxParameterKeys.table(visitId, station), data);
      qc.invalidateQueries({ queryKey: ["giniflow", "rx-parameters"] });
    },
  });
}

export function useVisitSummary(visitId, station = "doctor") {
  return useQuery({
    queryKey: rxParameterKeys.summary(visitId, station),
    queryFn: async () => (await api.get(`${stationPath(visitId, station)}/visit-summary`)).data,
    enabled: !!visitId,
  });
}

export function useGenerateVisitSummary(visitId, station = "doctor") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post(`${stationPath(visitId, station)}/visit-summary`)).data,
    onSuccess: (data) => {
      qc.setQueryData(rxParameterKeys.summary(visitId, station), data);
      qc.invalidateQueries({ queryKey: ["giniflow", "visit-summary"] });
    },
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
