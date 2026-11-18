import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";

const LIMITS_KEY = ["giniflow", "follow-up-limits"];
const LOAD_KEY = ["giniflow", "follow-up-load"];

export const fetchFollowUpLoad = async ({ from, to, visitId }) =>
  (
    await api.get("/api/giniflow/follow-up-load", {
      params: { from, to, ...(visitId ? { visitId } : {}) },
    })
  ).data;

export const followUpLoadQuery = ({ from, to, visitId }) => ({
  queryKey: [...LOAD_KEY, from, to, visitId || ""],
  queryFn: () => fetchFollowUpLoad({ from, to, visitId }),
  staleTime: 20_000,
});

export function useFollowUpLoad({ from, to, visitId, enabled = true }) {
  return useQuery({
    ...followUpLoadQuery({ from, to, visitId }),
    enabled: enabled && !!from && !!to,
  });
}

export function useInvalidateFollowUpLoad() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: LOAD_KEY });
}

export function useFollowUpLimits() {
  return useQuery({
    queryKey: LIMITS_KEY,
    queryFn: async () => (await api.get("/api/giniflow/follow-up-limits")).data.limits,
    staleTime: 30_000,
  });
}

export function useSaveFollowUpLimits() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (limits) =>
      (await api.put("/api/giniflow/follow-up-limits", limits)).data.limits,
    onSuccess: (limits) => {
      queryClient.setQueryData(LIMITS_KEY, limits);
      queryClient.invalidateQueries({ queryKey: LOAD_KEY });
    },
  });
}
