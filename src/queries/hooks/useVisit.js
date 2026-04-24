import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

async function fetchVisit(patientId, appointmentId) {
  const url = `/api/visit/${patientId}${appointmentId ? `?appointment_id=${appointmentId}` : ""}`;
  const { data } = await api.get(url);
  return data;
}

export function useVisit(patientId, appointmentId) {
  return useQuery({
    queryKey: qk.visit.byPatient(patientId, appointmentId),
    queryFn: () => fetchVisit(patientId, appointmentId),
    enabled: !!patientId,
    // Each /visit GET runs a Genie sync server-side. The global React Query
    // defaults (staleTime:0, refetchOnWindowFocus:true) turned a normal
    // doctor session into a storm of sync calls. Override both for just
    // this query — other screens keep the global behaviour.
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}
