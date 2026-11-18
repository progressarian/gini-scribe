import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const BASE = "/api/pharmacy/prescriptions";

export const rxKeys = {
  all: ["pharmacy-rx"],
  queue: (params) => ["pharmacy-rx", "queue", params],
  patient: (id, date) => ["pharmacy-rx", "patient", String(id), date],
};

export function useRxQueue(params) {
  return useQuery({
    queryKey: rxKeys.queue(params),
    queryFn: async () => (await api.get(BASE, { params })).data,
    placeholderData: keepPreviousData,
    refetchInterval: 60000,
  });
}

export function useRxPatient(patientId, date) {
  return useQuery({
    queryKey: rxKeys.patient(patientId, date),
    queryFn: async () =>
      (await api.get(`${BASE}/patients/${patientId}`, { params: { date } })).data,
    enabled: Boolean(patientId),
  });
}

export function useSaveRxOutcomes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ patientId, ...body }) =>
      (await api.post(`${BASE}/patients/${patientId}/outcomes`, body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: rxKeys.all }),
  });
}

export function useRequestRxMedicine() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ patientId, medicationId }) =>
      (await api.post(`${BASE}/patients/${patientId}/requests`, { medication_id: medicationId }))
        .data,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pharmacy-stock"] });
      queryClient.invalidateQueries({ queryKey: rxKeys.all });
    },
  });
}
