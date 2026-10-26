import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

export function useNewPatientWorkup(patientId, appointmentId) {
  return useQuery({
    queryKey: qk.visit.workup(patientId, appointmentId),
    queryFn: async () => {
      const { data } = await api.get(`/api/visit/${patientId}/workup`, {
        params: appointmentId ? { appointment_id: appointmentId } : {},
      });
      return data;
    },
    enabled: !!patientId,
    staleTime: 30_000,
  });
}

export function useSaveNewPatientWorkup(patientId, appointmentId) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body) =>
      (
        await api.put(`/api/visit/${patientId}/workup`, {
          ...body,
          appointment_id: appointmentId,
        })
      ).data,
    onSuccess: (data, body) => {
      qc.setQueryData(qk.visit.workup(patientId, appointmentId), (old) =>
        old ? { ...old, workup: data.workup, allergy: data.allergy } : old,
      );
      if (body.allergy) qc.invalidateQueries({ queryKey: ["visit", String(patientId)] });
    },
  });
}
