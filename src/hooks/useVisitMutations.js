import { useCallback } from "react";
import api from "../services/api";
import { toast } from "../stores/uiStore";

export function useVisitMutations(patientId, refreshData, appointmentId) {
  const extra = appointmentId ? { appointment_id: appointmentId } : {};

  const addLab = useCallback(
    async (data) => {
      try {
        await api.post(`/api/visit/${patientId}/lab`, { ...data, ...extra });
        toast("Lab value added", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to add lab value", "error");
        return { success: false };
      }
    },
    [patientId, refreshData, extra],
  );

  const addDiagnosis = useCallback(
    async (data, opts = {}) => {
      try {
        await api.post(`/api/visit/${patientId}/diagnosis`, data);
        if (!opts.silent) toast("Diagnosis added", "success");
        if (!opts.skipRefresh) await refreshData();
        return { success: true };
      } catch {
        if (!opts.silent) toast("Failed to add diagnosis", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const updateDiagnosis = useCallback(
    async (id, data) => {
      try {
        await api.patch(`/api/visit/${patientId}/diagnosis/${id}`, data);
        toast("Diagnosis updated", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to update diagnosis", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const addMedication = useCallback(
    async (data, opts = {}) => {
      try {
        await api.post(`/api/visit/${patientId}/medication`, { ...data, ...extra });
        if (!opts.silent) toast("Medication added", "success");
        if (!opts.skipRefresh) await refreshData();
        return { success: true };
      } catch {
        if (!opts.silent) toast("Failed to add medication", "error");
        return { success: false };
      }
    },
    [patientId, refreshData, extra],
  );

  const editMedication = useCallback(
    async (id, data) => {
      try {
        await api.patch(`/api/visit/${patientId}/medication/${id}`, data);
        toast("Medication updated", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to update medication", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const stopMedication = useCallback(
    async (id, data, opts = {}) => {
      try {
        await api.patch(`/api/visit/${patientId}/medication/${id}/stop`, data);
        if (!opts.silent) toast("Medication stopped", "success");
        if (!opts.skipRefresh) await refreshData();
        return { success: true };
      } catch {
        if (!opts.silent) toast("Failed to stop medication", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const restartMedication = useCallback(
    async (id, opts = {}) => {
      try {
        await api.patch(`/api/visit/${patientId}/medication/${id}/restart`);
        if (!opts.silent) toast("Medication restarted", "success");
        if (!opts.skipRefresh) await refreshData();
        return { success: true };
      } catch (err) {
        const status = err?.response?.status;
        const msg =
          status === 409
            ? "An active prescription with this name already exists"
            : "Failed to restart medication";
        if (!opts.silent) toast(msg, "error");
        return { success: false, status };
      }
    },
    [patientId, refreshData],
  );

  const deleteMedication = useCallback(
    async (id) => {
      try {
        await api.delete(`/api/visit/${patientId}/medication/${id}`);
        toast("Medication deleted", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to delete medication", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const addSymptom = useCallback(
    async (data, opts = {}) => {
      try {
        await api.post(`/api/visit/${patientId}/symptom`, { ...data, ...extra });
        if (!opts.silent) toast("Symptom added", "success");
        if (!opts.skipRefresh) await refreshData();
        return { success: true };
      } catch {
        if (!opts.silent) toast("Failed to add symptom", "error");
        return { success: false };
      }
    },
    [patientId, refreshData, extra],
  );

  const updateSymptomStatus = useCallback(
    async (id, status) => {
      try {
        await api.patch(`/api/visit/${patientId}/symptom/${id}`, { status });
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to update symptom status", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const addInvestigations = useCallback(
    async (items, opts = {}) => {
      try {
        const { data } = await api.patch(`/api/visit/${patientId}/investigations`, { items });
        if (!opts.skipRefresh) await refreshData();
        return { success: true, added: data?.added ?? 0 };
      } catch {
        if (!opts.silent) toast("Failed to save investigations", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const addReferral = useCallback(
    async (data) => {
      try {
        await api.post(`/api/visit/${patientId}/referral`, { ...data, ...extra });
        toast("Referral added", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to add referral", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const uploadDocument = useCallback(
    async (data) => {
      try {
        const { data: doc } = await api.post(`/api/visit/${patientId}/document`, data);
        toast("Document uploaded", "success");
        await refreshData();
        return { success: true, docId: doc?.id };
      } catch {
        toast("Failed to upload document", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const updateFollowUp = useCallback(
    async (data) => {
      try {
        await api.patch(`/api/visit/${patientId}/followup`, data);
        toast("Follow-up date updated", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to update follow-up date", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  const updateVitals = useCallback(
    async (vitalsData, latestVitals) => {
      try {
        const isToday = (dateStr) => {
          const d = new Date(dateStr);
          const now = new Date();
          return (
            d.getFullYear() === now.getFullYear() &&
            d.getMonth() === now.getMonth() &&
            d.getDate() === now.getDate()
          );
        };
        // App-logged rows have synthetic ids like "app:123" and live in
        // patient_vitals_log, not the doctor-side vitals table — never PATCH
        // them. Fall through to POST so the doctor's edit creates a fresh
        // clinic vitals row instead of 400ing.
        const isAppRow =
          typeof latestVitals?.id === "string" && latestVitals.id.startsWith("app:");
        const useExisting =
          !isAppRow &&
          latestVitals?.id &&
          latestVitals?.recorded_at &&
          isToday(latestVitals.recorded_at);
        if (useExisting) {
          await api.patch(`/api/visit/${patientId}/vitals/${latestVitals.id}`, vitalsData);
        } else {
          await api.post(`/api/visit/${patientId}/vitals`, vitalsData);
        }
        toast("Vitals updated", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to update vitals", "error");
        return { success: false };
      }
    },
    [patientId, refreshData],
  );

  return {
    addLab,
    addDiagnosis,
    updateDiagnosis,
    addSymptom,
    updateSymptomStatus,
    addMedication,
    editMedication,
    stopMedication,
    restartMedication,
    deleteMedication,
    addInvestigations,
    addReferral,
    uploadDocument,
    updateFollowUp,
    updateVitals,
  };
}
