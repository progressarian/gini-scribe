import { create } from "zustand";
import api from "../services/api.js";

const useAuthStore = create((set, get) => ({
  // ── state ──
  authToken: localStorage.getItem("gini_auth_token") || "",
  currentDoctor: null,
  authReady: false,
  doctorsList: [],
  loginPin: "",
  loginDoctorId: "",
  loginError: "",
  loginLoading: false,
  keySet: true,
  dgKey: "server",
  whisperKey: "",
  moName: "Dr. Beant",
  conName: "Dr. Bhansali",

  // ── simple setters ──
  setLoginPin: (val) => set({ loginPin: val }),
  setLoginDoctorId: (val) => set({ loginDoctorId: val }),
  setLoginError: (val) => set({ loginError: val }),
  setLoginLoading: (val) => set({ loginLoading: val }),
  setAuthToken: (val) => set({ authToken: val }),
  setCurrentDoctor: (val) => set({ currentDoctor: val }),
  setDoctorsList: (val) => set({ doctorsList: val }),
  setKeySet: (val) => set({ keySet: val }),
  setDgKey: (val) => set({ dgKey: val }),
  setWhisperKey: (val) => set({ whisperKey: val }),
  setMoName: (val) => set({ moName: val }),
  setConName: (val) => set({ conName: val }),

  // ── auth headers helper (kept for external consumers) ──
  authHeaders: (extra = {}) => {
    const { authToken } = get();
    return {
      "Content-Type": "application/json",
      ...(authToken ? { "x-auth-token": authToken } : {}),
      ...extra,
    };
  },

  // ── initAuth: called once on app load — fetches doctor from DB via token ──
  initAuth: async () => {
    const { authToken } = get();
    if (!authToken) {
      set({ authReady: true });
      return;
    }
    try {
      const { data } = await api.get("/api/auth/me");
      if (data.authenticated && data.doctor) {
        const doctor = data.doctor;
        set({ currentDoctor: doctor, authReady: true });
        // Auto-set names based on role
        if (doctor.role === "mo") set({ moName: doctor.short_name });
        else set({ conName: doctor.short_name });
      } else {
        // Token invalid or expired — clear it
        set({ authToken: "", currentDoctor: null, authReady: true });
        localStorage.removeItem("gini_auth_token");
      }
    } catch {
      // Network error — clear auth state
      set({ authToken: "", currentDoctor: null, authReady: true });
      localStorage.removeItem("gini_auth_token");
    }
  },

  // ── login handler ── returns doctor object on success, null on failure
  handleLogin: async () => {
    const { loginDoctorId, loginPin } = get();
    if (!loginDoctorId || !loginPin) {
      set({ loginError: "Select doctor and enter PIN" });
      return null;
    }
    set({ loginLoading: true, loginError: "" });
    try {
      const { data } = await api.post("/api/auth/login", {
        doctor_id: parseInt(loginDoctorId),
        pin: loginPin,
      });
      if (data.token) {
        const doctor = data.doctor;
        set({
          authToken: data.token,
          currentDoctor: doctor,
          keySet: true,
          dgKey: "server",
        });
        localStorage.setItem("gini_auth_token", data.token);
        // Auto-set names based on role
        if (doctor.role === "mo") set({ moName: doctor.short_name });
        else set({ conName: doctor.short_name });
        set({ loginLoading: false, loginPin: "" });
        return doctor; // caller handles navigation
      } else {
        set({ loginError: data.error || "Login failed" });
      }
    } catch (e) {
      set({ loginError: e.response?.data?.error || "Connection error" });
    }
    set({ loginLoading: false, loginPin: "" });
    return null;
  },

  // ── logout handler ──
  handleLogout: () => {
    api.post("/api/auth/logout").catch(() => {});
    set({ authToken: "", currentDoctor: null });
    localStorage.removeItem("gini_auth_token");
    sessionStorage.removeItem("gini_active_patient");
  },

  // ── init: fetch doctors list ──
  fetchDoctorsList: async (toast) => {
    try {
      const { data: list } = await api.get("/api/doctors");
      set({ doctorsList: list });
    } catch {
      if (toast) toast("Failed to load doctors list", "warn");
    }
  },
}));

export default useAuthStore;
