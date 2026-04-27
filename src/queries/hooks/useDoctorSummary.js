import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const key = (patientId) => ["visit", String(patientId), "doctor-summary"];

export function useDoctorSummary(patientId) {
  return useQuery({
    queryKey: key(patientId),
    queryFn: async () => {
      const { data } = await api.get(`/api/visit/${patientId}/doctor-summary`);
      return data || { versions: [], current: null };
    },
    enabled: !!patientId,
    staleTime: 30_000,
  });
}

export function useSaveDoctorSummary(patientId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ content, change_note, appointment_id, author_name, author_id }) => {
      const { data } = await api.post(`/api/visit/${patientId}/doctor-summary`, {
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
