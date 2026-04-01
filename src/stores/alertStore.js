import { create } from "zustand";
import api from "../services/api.js";

const useAlertStore = create((set, get) => ({
  alerts: [],
  alertsLoading: false,
  patientAlerts: [],
  patientAlertsLoading: false,
  sendingAlert: false,

  // Fetch all alerts from mobile (for Home page)
  fetchAlerts: async () => {
    set({ alertsLoading: true });
    try {
      const { data } = await api.get("/api/alerts/from-genie");
      set({ alerts: data || [] });
    } catch {
      set({ alerts: [] });
    }
    set({ alertsLoading: false });
  },

  // Fetch alerts for a specific patient (for FU-Load page)
  fetchPatientAlerts: async (patientId) => {
    if (!patientId) return;
    set({ patientAlertsLoading: true });
    try {
      const { data } = await api.get(`/api/patients/${patientId}/alerts`);
      set({ patientAlerts: data || [] });
    } catch {
      set({ patientAlerts: [] });
    }
    set({ patientAlertsLoading: false });
  },

  clearPatientAlerts: () => set({ patientAlerts: [] }),

  // Send alert from doctor to patient's mobile app
  sendAlert: async (patientId, title, message, alertType = "doctor_note") => {
    if (!patientId || !title || !message) return { error: "Missing required fields" };
    set({ sendingAlert: true });
    try {
      const { data } = await api.post(`/api/patients/${patientId}/alerts`, {
        alert_type: alertType,
        title,
        message,
      });
      set({ sendingAlert: false });
      return data;
    } catch (e) {
      set({ sendingAlert: false });
      return { error: e.response?.data?.error || "Failed to send alert" };
    }
  },
}));

export default useAlertStore;
