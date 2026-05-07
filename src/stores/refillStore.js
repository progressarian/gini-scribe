import { create } from "zustand";
import api from "../services/api.js";

// Patient-initiated medication refill requests, surfaced from the Genie app.
const useRefillStore = create((set, get) => ({
  requests: [],
  loading: false,
  patientHistory: [],
  patientHistoryLoading: false,
  updating: false,

  // Pending queue for the Home page section.
  fetchPending: async () => {
    set({ loading: true });
    try {
      const { data } = await api.get("/api/refill-requests?status=pending&limit=30");
      // Endpoint returns { rows, page, ... } — fall back to raw array for
      // backwards-compatibility with any older deployment.
      set({ requests: Array.isArray(data) ? data : data?.rows || [] });
    } catch {
      set({ requests: [] });
    }
    set({ loading: false });
  },

  // Filtered list for the dedicated Refills page. `filters` keys:
  //   status (pending|approved|fulfilled|rejected|all)
  //   patient_id (number/string)
  //   q (search across patient + medicine)
  //   from / to (ISO date strings)
  //   limit
  fetchAll: async (filters = {}) => {
    set({ loading: true });
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => {
        if (v !== undefined && v !== null && String(v).length > 0) {
          params.set(k, String(v));
        }
      });
      const qs = params.toString();
      const { data } = await api.get(`/api/refill-requests${qs ? `?${qs}` : ""}`);
      set({ requests: data || [] });
    } catch {
      set({ requests: [] });
    }
    set({ loading: false });
  },

  // Full order history for a single patient (all statuses).
  fetchForPatient: async (patientId) => {
    if (!patientId) return;
    set({ patientHistoryLoading: true });
    try {
      const { data } = await api.get(`/api/patients/${patientId}/refill-requests`);
      set({ patientHistory: data || [] });
    } catch {
      set({ patientHistory: [] });
    }
    set({ patientHistoryLoading: false });
  },

  clearPatientHistory: () => set({ patientHistory: [] }),

  updateStatus: async (id, status) => {
    if (!id || !status) return { error: "Missing fields" };
    set({ updating: true });
    try {
      await api.patch(`/api/refill-requests/${id}`, { status });
      // Optimistically drop from pending feed if no longer pending.
      const requests = get().requests.filter((r) => r.id !== id || status === "pending");
      set({ requests, updating: false });
      return { ok: true };
    } catch (e) {
      set({ updating: false });
      return { error: e.response?.data?.error || "Update failed" };
    }
  },
}));

export default useRefillStore;
