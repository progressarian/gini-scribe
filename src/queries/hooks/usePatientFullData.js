import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import api from "../../services/api";
import { qk } from "../keys";
import usePatientStore from "../../stores/patientStore";
import { parseExtractedData } from "../../utils/docStatus";

async function fetchPatientFull(id) {
  const { data } = await api.get(`/api/patients/${id}`);
  return data;
}

// Polled fetch of the full patient record (documents + labs + meds etc).
// Every time a page mounts this hook, it refetches — the /docs page
// therefore reloads when the user navigates back to it. Polling kicks in
// whenever any document is still extracting, so the status pills update
// live without a manual refresh. The zustand patient store is kept in
// sync so other pages that still read `patientFullData` see the same data.
export function usePatientFullData(patientId) {
  const setPatientFullData = usePatientStore((s) => s.setPatientFullData);
  const idStr = patientId ? String(patientId) : null;

  const query = useQuery({
    queryKey: qk.patient.full(idStr),
    queryFn: () => fetchPatientFull(patientId),
    enabled: !!patientId,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    staleTime: 0,
    refetchInterval: (q) => {
      const data = q.state.data;
      const docs = data?.documents || [];
      const anyPending = docs.some((d) => {
        const ext = parseExtractedData(d.extracted_data);
        return ext?.extraction_status === "pending";
      });
      return anyPending ? 5_000 : false;
    },
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (query.data && query.data.id) {
      setPatientFullData(query.data);
    }
  }, [query.data, setPatientFullData]);

  return query;
}
