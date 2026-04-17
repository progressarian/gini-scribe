import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

async function fetchOpdAppointments(date) {
  // Fire no-show sync but don't block the list — if it fails the list still loads.
  api.post("/api/opd/sync-noshow").catch(() => {});
  const { data } = await api.get(`/api/opd/appointments?date=${encodeURIComponent(date)}`);
  return Array.isArray(data) ? data : [];
}

export function useOpdAppointments(date) {
  return useQuery({
    queryKey: qk.opd.appointments(date),
    queryFn: () => fetchOpdAppointments(date),
    enabled: !!date,
  });
}
