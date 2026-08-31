import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";

// The board polls; the second-by-second timers are computed client-side from
// each card's timestamps against server time, so a 10s refetch still reads as
// live. See docs/gini-flow/00-OVERVIEW.md §2.2 for why this is not Realtime.
export function useGiniflowBoard(date) {
  return useQuery({
    queryKey: ["giniflow", "board", date || "today"],
    queryFn: async () =>
      (await api.get("/api/giniflow/board", { params: date ? { date } : {} })).data,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
    // A 401 means the session expired overnight; retrying it every 10s only
    // hides the fact that someone has to log in again.
    retry: (count, err) => err?.response?.status !== 401 && count < 2,
    // A floor display must never blank on a network blip: keep the last good
    // board on screen and let the page show it as stale.
    placeholderData: (prev) => prev,
    staleTime: 5_000,
  });
}

// Server-side search. The floor can hold 100+ patients and the board only
// renders what fits, so filtering the loaded cards would quietly miss people.
// Debounced by the caller; disabled under 2 characters, which the API also
// rejects.
export function useGiniflowSearch(query, date) {
  const q = (query || "").trim();
  return useQuery({
    queryKey: ["giniflow", "search", date || "today", q],
    queryFn: async () =>
      (await api.get("/api/giniflow/search", { params: { q, ...(date ? { date } : {}) } })).data,
    enabled: q.length >= 2,
    staleTime: 5_000,
  });
}

export function useGiniflowTimeline(visitId) {
  return useQuery({
    queryKey: ["giniflow", "timeline", visitId],
    queryFn: async () => (await api.get(`/api/giniflow/visits/${visitId}/timeline`)).data,
    enabled: !!visitId,
  });
}
