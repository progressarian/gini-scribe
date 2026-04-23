import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api.js";
import { qk } from "../keys";

const PAGE_SIZE = 30;

// Paginated messages for a conversation. Server returns pages ascending
// (oldest→newest within each page); flattenThread reverses page order so the
// final array is fully ascending for rendering.
async function fetchConversationPage({ conversationId, before, signal }) {
  const params = { limit: PAGE_SIZE };
  if (before) params.before = before;
  const { data } = await api.get(`/api/conversations/${conversationId}/messages`, {
    params,
    signal,
  });
  return {
    data: data?.data ?? [],
    nextCursor: data?.nextCursor ?? null,
    hasMore: !!data?.hasMore,
  };
}

export function useThreadMessages(conversationId, { enabled = true } = {}) {
  return useInfiniteQuery({
    queryKey: qk.messages.conversationMessages(conversationId),
    enabled: !!conversationId && enabled,
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      fetchConversationPage({ conversationId, before: pageParam, signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor || undefined,
    staleTime: 2_000,
    refetchOnWindowFocus: false,
  });
}

// Flatten pages into a single ascending array.
export function flattenThread(pages = []) {
  const out = [];
  for (let i = pages.length - 1; i >= 0; i--) out.push(...(pages[i]?.data || []));
  return out;
}

export function appendOptimistic(queryClient, queryKey, message) {
  queryClient.setQueryData(queryKey, (prev) => {
    if (!prev) {
      return {
        pages: [{ data: [message], nextCursor: null, hasMore: false }],
        pageParams: [null],
      };
    }
    const pages = prev.pages.slice();
    const first = pages[0] || { data: [], nextCursor: null, hasMore: false };
    pages[0] = { ...first, data: [...first.data, message] };
    return { ...prev, pages };
  });
}

export function removeOptimistic(queryClient, queryKey, tmpId) {
  queryClient.setQueryData(queryKey, (prev) => {
    if (!prev) return prev;
    const pages = prev.pages.map((p) => ({
      ...p,
      data: p.data.filter((m) => m.id !== tmpId),
    }));
    return { ...prev, pages };
  });
}

export { PAGE_SIZE };
