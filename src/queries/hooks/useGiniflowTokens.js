import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { pollInterval } from "./giniflowPolling";

const TOKENS_KEY = ["giniflow", "tokens"];

const AFFECTED_KEYS = [TOKENS_KEY, ["giniflow", "board"], ["giniflow", "mo"]];

const paramsOf = ({ date, doctorId, from, to, q }) => ({
  ...(date ? { date } : {}),
  ...(doctorId ? { doctor: String(doctorId) } : {}),
  ...(from ? { from } : {}),
  ...(to ? { to } : {}),
  ...(q?.trim() ? { q: q.trim() } : {}),
});

export function useTokenQueue(filters) {
  const params = paramsOf(filters);
  return useQuery({
    queryKey: [...TOKENS_KEY, params],
    queryFn: async () => (await api.get("/api/giniflow/tokens", { params })).data,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
    retry: (count, err) => err?.response?.status !== 401 && count < 2,
    placeholderData: (prev) => prev,
    staleTime: 5_000,
  });
}

export function useSetToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ visitId, token }) =>
      (await api.patch(`/api/giniflow/visits/${visitId}/token`, { token })).data,
    onSettled: () =>
      Promise.all(AFFECTED_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey }))),
  });
}
