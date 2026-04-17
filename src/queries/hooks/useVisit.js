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
  });
}
