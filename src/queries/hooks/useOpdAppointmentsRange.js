import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

async function fetchOpdAppointmentsRange(start, end) {
  try {
    const { data } = await api.get(
      `/api/opd/appointments-range?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}`,
    );
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

export function useOpdAppointmentsRange(start, end, options = {}) {
  return useQuery({
    queryKey: qk.opd.appointmentsRange(start, end),
    queryFn: () => fetchOpdAppointmentsRange(start, end),
    enabled: !!start && !!end,
    retry: 2,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    staleTime: 30_000,
    ...options,
  });
}
