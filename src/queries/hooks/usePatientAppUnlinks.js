import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

export function usePhoneFamily(patientId) {
  return useQuery({
    queryKey: qk.patientAppUnlinks.family(patientId),
    enabled: !!patientId,
    queryFn: async () => {
      const { data } = await api.get("/api/patient-app-unlinks/family", {
        params: { patientId },
      });
      return data;
    },
  });
}

export function useUnlinkFamilyMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body) => (await api.post("/api/patient-app-unlinks", body)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.patientAppUnlinks.all }),
  });
}

export function useRelinkFamilyMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (unlinkId) =>
      (await api.post(`/api/patient-app-unlinks/${unlinkId}/relink`)).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.patientAppUnlinks.all }),
  });
}
