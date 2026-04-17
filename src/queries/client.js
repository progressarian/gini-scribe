import { QueryClient } from "@tanstack/react-query";

// staleTime: 0 — treat data as stale immediately on each mount so the user
// always gets a refetch. Previous data is kept in cache and shown instantly
// while the refetch happens in the background (no loading flicker).
// refetchOnWindowFocus: true — when the user tabs back to the app, re-pull
// anything they're currently looking at. Important for a clinical app where
// stale data can mislead.
// gcTime: 30min — keep cached entries for 30 minutes after the last subscriber
// unmounts so back-nav (and re-opening a patient during the same session)
// paints instantly from cache. Memory footprint is small for JSON of this size.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
    mutations: {
      retry: 0,
    },
  },
});

export default queryClient;
