import { useMutation, useQueryClient } from "@tanstack/react-query";
import api from "../../services/api";
import { qk } from "../keys";

// Saves a full consultation. Invalidates the patient's visit view and the
// OPD list so the next render pulls fresh data with the new consultation,
// meds, diagnoses, and auto-completed appointment status.
export function useSaveConsultation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload) => {
      const { data } = await api.post("/api/consultations", payload);
      return data;
    },
    onSuccess: (data) => {
      // Visit family — patientId can come from the response.
      if (data?.patient_id) {
        qc.invalidateQueries({
          queryKey: ["visit", String(data.patient_id)],
          exact: false,
        });
        qc.invalidateQueries({
          queryKey: qk.companion.patient(data.patient_id),
        });
      }
      // OPD list always refreshes (appointment may have flipped to "completed").
      qc.invalidateQueries({ queryKey: qk.opd.all });
    },
  });
}

// Saves biomarkers for an appointment. Invalidates OPD list (prep_steps +
// biomarkers change) and the visit view for that patient.
export function useSaveBiomarkers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ appointmentId, body }) => {
      const { data } = await api.post(`/api/appointments/${appointmentId}/biomarkers`, body);
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: qk.opd.all });
      if (data?.patient_id) {
        qc.invalidateQueries({
          queryKey: ["visit", String(data.patient_id)],
          exact: false,
        });
      }
    },
  });
}

// Saves compliance + extracted meds/diagnoses for an appointment.
export function useSaveCompliance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ appointmentId, body }) => {
      const { data } = await api.post(`/api/appointments/${appointmentId}/compliance`, body);
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: qk.opd.all });
      if (data?.patient_id) {
        qc.invalidateQueries({
          queryKey: ["visit", String(data.patient_id)],
          exact: false,
        });
      }
    },
  });
}

// Patches a single appointment (status change, prep step tick, etc.). Keeps
// the UI optimistic: we update the cached list immediately, then refetch on
// settle to reconcile.
export function usePatchAppointment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, body }) => {
      const { data } = await api.patch(`/api/appointments/${id}`, body);
      return data;
    },
    onSuccess: (updated) => {
      // Update every cached OPD list entry that contains this appointment
      // so the UI shows the new status/prep without waiting for refetch.
      if (updated?.id) {
        qc.setQueriesData({ queryKey: qk.opd.all }, (old) => {
          if (!Array.isArray(old)) return old;
          return old.map((row) => (row.id === updated.id ? { ...row, ...updated } : row));
        });
      }
      // Still invalidate so stats (visit counts, biomarker fallbacks) reconcile.
      qc.invalidateQueries({ queryKey: qk.opd.all });
    },
  });
}
