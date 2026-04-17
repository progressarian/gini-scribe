import { useQuery } from "@tanstack/react-query";
import api from "../../services/api.js";
import { qk } from "../keys.js";

// Clinical data — always refetch on mount and when the user tabs back to the
// app. Previous results stay in cache so the list paints instantly; the
// background refetch updates statuses (checked-in, uploaded counts) silently.
export function useCompanionAppointments(date) {
  return useQuery({
    queryKey: qk.companion.appointments(date),
    queryFn: async () => {
      const { data } = await api.get(`/api/opd/appointments?date=${date}`);
      return Array.isArray(data) ? data : [];
    },
    enabled: !!date,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
}
