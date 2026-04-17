import { useQuery } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

async function fetchCompanionPatient(id) {
  const { data } = await api.get(`/api/patients/${id}`);
  return data;
}

export function useCompanionPatient(id) {
  return useQuery({
    queryKey: qk.companion.patient(id),
    queryFn: () => fetchCompanionPatient(id),
    enabled: !!id,
  });
}
