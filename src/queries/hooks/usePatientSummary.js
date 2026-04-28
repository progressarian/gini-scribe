import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const key = (patientId) => ["visit", String(patientId), "patient-summary"];

export function usePatientSummary(patientId) {
  return useQuery({
    queryKey: key(patientId),
    queryFn: async () => {
      const { data } = await api.get(`/api/visit/${patientId}/patient-summary`);
      return data || { versions: [], current: null };
    },
    enabled: !!patientId,
    staleTime: 30_000,
  });
}

export function useSavePatientSummary(patientId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ content, change_note, appointment_id, author_name, author_id }) => {
      const { data } = await api.post(`/api/visit/${patientId}/patient-summary`, {
        content,
        change_note,
        appointment_id,
        author_name,
        author_id,
      });
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(patientId) });
    },
  });
}

// Generate (or regenerate) the patient-facing summary via AI. Body is the
// visit data payload (same shape used by the prescription PDF endpoint).
export function useGeneratePatientSummary(patientId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (visitPayload) => {
      const { data } = await api.post(
        `/api/visit/${patientId}/patient-summary/generate`,
        visitPayload,
      );
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key(patientId) });
    },
  });
}
