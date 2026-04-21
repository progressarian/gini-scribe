import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

async function fetchOpdAppointments(date) {
  // Fire no-show sync but don't block the list — if it fails the list still loads.
  api.post("/api/opd/sync-noshow").catch(() => {});
  try {
    const { data } = await api.get(`/api/opd/appointments?date=${encodeURIComponent(date)}`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    const msg =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err?.message ||
      "Failed to load OPD appointments";
    const wrapped = new Error(msg);
    wrapped.status = err?.response?.status;
    throw wrapped;
  }
}

export function useOpdAppointments(date, options = {}) {
  return useQuery({
    queryKey: qk.opd.appointments(date),
    queryFn: () => fetchOpdAppointments(date),
    enabled: !!date,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    staleTime: 15_000,
    ...options,
  });
}
