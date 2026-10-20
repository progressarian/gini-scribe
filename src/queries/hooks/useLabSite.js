import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

const labSiteKey = (visitId) => ["giniflow", "lab-site", visitId];

export function useLabSite(visitId) {
  return useQuery({
    queryKey: labSiteKey(visitId),
    queryFn: async () => (await api.get(`/api/giniflow/stations/lab-site/${visitId}`)).data,
    enabled: Boolean(visitId),
  });
}

export function useSetLabSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, site }) =>
      (await api.post(`/api/giniflow/stations/lab-site/${visitId}`, { site })).data,
    onSuccess: (data, { visitId }) => {
      queryClient.setQueryData(labSiteKey(visitId), data);
      queryClient.invalidateQueries({ queryKey: ["giniflow"] });
      queryClient.invalidateQueries({ queryKey: qk.ghm.all });
    },
  });
}
