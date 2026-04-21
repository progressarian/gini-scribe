import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";

async function fetchMismatchReviews() {
  const { data } = await api.get("/api/companion/mismatch-reviews");
  return Array.isArray(data) ? data : [];
}

// Polled list of docs awaiting patient-mismatch review. Used by the
// companion bell icon so new mismatches surface without a manual refresh.
export function useMismatchReviews() {
  return useQuery({
    queryKey: ["companion", "mismatchReviews"],
    queryFn: fetchMismatchReviews,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    staleTime: 5_000,
  });
}
