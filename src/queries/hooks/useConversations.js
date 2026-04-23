import { useQuery } from "@tanstack/react-query";
import api from "../../services/api.js";
import { qk } from "../keys";

// List conversations visible to the current scribe user.
//   kind='doctor'     → only conversations where current doctor is the participant
//   kind='lab'|'reception' → shared team inbox
export function useConversations(kind, { enabled = true, refetchInterval = 15000 } = {}) {
  return useQuery({
    queryKey: qk.messages.conversations(kind),
    enabled: !!kind && enabled,
    queryFn: async ({ signal }) => {
      const { data } = await api.get(`/api/conversations`, { params: { kind }, signal });
      return data?.data ?? [];
    },
    staleTime: 5_000,
    refetchInterval,
  });
}
