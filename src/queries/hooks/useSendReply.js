import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api.js";
import { qk } from "../keys";
import { appendOptimistic, removeOptimistic } from "./useThreadMessages";

// Send a reply into a conversation. Server derives sender_name from the
// authenticated doctor and sender_role from the conversation kind — clients
// just pass the message body.
export function useSendReply({ conversationId, senderName = "Doctor" } = {}) {
  const queryClient = useQueryClient();
  const queryKey = qk.messages.conversationMessages(conversationId);

  return useMutation({
    // Retry transient failures (network, 5xx). 4xx fail fast.
    retry: (failureCount, error) => {
      if (failureCount >= 3) return false;
      const status = error?.response?.status;
      if (status && status >= 400 && status < 500) return false;
      return true;
    },
    retryDelay: (attempt) => Math.min(500 * Math.pow(3, attempt), 5000),
    mutationFn: async (message) => {
      const { data } = await api.post(`/api/conversations/${conversationId}/messages`, {
        message,
      });
      return data;
    },
    onMutate: async (message) => {
      const tmpId = `tmp-${Date.now()}`;
      const optimistic = {
        id: tmpId,
        conversation_id: conversationId,
        message,
        direction: "inbound",
        sender_name: senderName,
        created_at: new Date().toISOString(),
        is_read: true,
        _optimistic: true,
      };
      await queryClient.cancelQueries({ queryKey });
      appendOptimistic(queryClient, queryKey, optimistic);
      return { tmpId };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.tmpId) removeOptimistic(queryClient, queryKey, ctx.tmpId);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey });
    },
  });
}
