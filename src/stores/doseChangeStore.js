import { create } from "zustand";
import api from "../services/api.js";

// Patient-initiated medication dose-change requests, surfaced from the Genie
// app. Mirrors refillStore.js but each request is a single medication (no
// items array) and the doctor can edit the final dose at decision time.
const useDoseChangeStore = create((set, get) => ({
  requests: [],
  loading: false,
  patientHistory: [],
  patientHistoryLoading: false,
  updating: false,

  fetchPending: async () => {
    set({ loading: true });
    try {
      const { data } = await api.get("/api/dose-change-requests?status=pending&limit=30");
      set({ requests: Array.isArray(data) ? data : data?.rows || [] });
    } catch {
      set({ requests: [] });
    }
    set({ loading: false });
  },

  fetchForPatient: async (patientId) => {
    if (!patientId) return;
    set({ patientHistoryLoading: true });
    try {
      const { data } = await api.get(`/api/patients/${patientId}/dose-change-requests`);
      set({ patientHistory: data || [] });
    } catch {
      set({ patientHistory: [] });
    }
    set({ patientHistoryLoading: false });
  },

  clearPatientHistory: () => set({ patientHistory: [] }),

  // payload: { status, final_dose?, doctor_note?, reject_reason?, doctor_id? }
  decide: async (id, payload) => {
    if (!id || !payload?.status) return { error: "Missing fields" };
    set({ updating: true });
    try {
      const { data } = await api.patch(`/api/dose-change-requests/${id}`, payload);
      const requests = get().requests.filter((r) => r.id !== id);
      const patientHistory = get().patientHistory.map((r) => (r.id === id ? data : r));
      set({ requests, patientHistory, updating: false });
      return { ok: true, data };
    } catch (e) {
      set({ updating: false });
      return { error: e.response?.data?.error || "Update failed" };
    }
  },

  // Doctor-initiated request from the patient profile.
  createForPatient: async (payload) => {
    try {
      const { data } = await api.post("/api/dose-change-requests", payload);
      const patientHistory = [data, ...get().patientHistory];
      set({ patientHistory });
      return { ok: true, data };
    } catch (e) {
      return { error: e.response?.data?.error || "Create failed" };
    }
  },
}));

export default useDoseChangeStore;
