import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

// Fires server-side retry for a failed (or stuck) document extraction.
// Server is authoritative: it re-fetches the file from storage, calls
// Claude with timeout + 3 retries, and either cascades the extracted
// data or persists extraction_status: "failed" with an error_message.
// We invalidate every query that renders doc status pills so the UI
// reflects the new state without a manual refresh.
export function useRetryExtraction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ docId }) => {
      const { data } = await api.post(`/api/documents/${docId}/retry-extract`);
      return data;
    },
    onSettled: (_data, _err, variables) => {
      const patientId = variables?.patientId;
      if (patientId) {
        qc.invalidateQueries({ queryKey: qk.patient.full(patientId) });
        qc.invalidateQueries({ queryKey: qk.companion.patient(patientId) });
      }
      qc.invalidateQueries({ queryKey: qk.opd.all });
      qc.invalidateQueries({ queryKey: ["visit"], exact: false });
    },
  });
}
