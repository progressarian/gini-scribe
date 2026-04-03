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
    async (data) => {
      try {
        await api.post(`/api/visit/${patientId}/diagnosis`, data);
        toast("Diagnosis added", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to add diagnosis", "error");
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
    async (data) => {
      try {
        await api.post(`/api/visit/${patientId}/medication`, { ...data, ...extra });
        toast("Medication added", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to add medication", "error");
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
    async (id, data) => {
      try {
        await api.patch(`/api/visit/${patientId}/medication/${id}/stop`, data);
        toast("Medication stopped", "success");
        await refreshData();
        return { success: true };
      } catch {
        toast("Failed to stop medication", "error");
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
        await api.post(`/api/visit/${patientId}/document`, data);
        toast("Document uploaded", "success");
        await refreshData();
        return { success: true };
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

  return {
    addLab,
    addDiagnosis,
    updateDiagnosis,
    addMedication,
    editMedication,
    stopMedication,
    addReferral,
    uploadDocument,
    updateFollowUp,
  };
}
