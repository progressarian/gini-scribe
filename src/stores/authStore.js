import { create } from "zustand";
import api, { forceLogout } from "../services/api.js";
import queryClient from "../queries/client.js";
import { normalizeRole } from "../../shared/permissions.js";

// Return a shallow copy of the doctor with its role normalized to a canonical
// lowercase value (fixes the mis-cased "MO" and any legacy aliases), so all
// downstream role/capability checks behave consistently.
const withNormalizedRole = (doctor) =>
  doctor ? { ...doctor, role: normalizeRole(doctor.role) } : doctor;

// Decodes a JWT's `exp` claim (seconds since epoch) without verifying the
// signature — the server is the only thing that needs to trust this token;
// the client just needs to know when to proactively renew it.
function decodeExpMs(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Module-scoped, not store state — timer ids and an in-flight promise aren't
// UI state and shouldn't trigger re-renders or get persisted.
let refreshTimer = null;
function scheduleProactiveRefresh(accessToken, refresh) {
  if (refreshTimer) clearTimeout(refreshTimer);
  const expMs = decodeExpMs(accessToken);
  if (!expMs) return;
  // Refresh ~60s before expiry so most requests never race a 401, and so
  // long-lived SSE connections (which re-read localStorage on reconnect)
  // always find a live token.
  const delay = Math.max(expMs - Date.now() - 60_000, 5_000);
  refreshTimer = setTimeout(() => {
    // Unlike the reactive 401 path (api.js), nothing else is waiting on this
    // call — there's no in-flight request whose failure would otherwise
    // surface a 401 and trigger forceLogout. Without this, a user idle on a
    // page with no API traffic when both tokens finally die would just sit
    // there — never redirected to /login until their next click happened to
    // fire a request. So a failed proactive refresh has to force the logout
    // itself instead of swallowing the error.
    refresh().catch(() => forceLogout());
  }, delay);
}

// Single-flight guard for refreshAccessToken — both the proactive timer above
// and api.js's reactive 401 handler call the same store action, and without
// this they can fire two concurrent /api/auth/refresh calls for the same
// refresh token (e.g. the timer fires right as a request 401s). The server
// tolerates that (a short grace window on reuse — server/services/refreshTokens.js),
// but there is no reason to make two round-trips when one will do.
let inFlightRefresh = null;

const useAuthStore = create((set, get) => ({
  // ── state ──
  authToken: localStorage.getItem("gini_auth_token") || "",
  refreshToken: localStorage.getItem("gini_refresh_token") || "",
  currentDoctor: null,
  authReady: false,
  doctorsList: [],
  doctorsLoading: false,
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
  setRefreshToken: (val) => set({ refreshToken: val }),
  // Stops the pending proactive-refresh timer without touching any other
  // state — used by api.js's forceLogout() so a 401-triggered logout doesn't
  // leave an orphaned timer that fires later against an already-cleared
  // session (harmless — refreshAccessToken() just rejects with no token to
  // use — but pointless).
  clearProactiveRefresh: () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
  },
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
    scheduleProactiveRefresh(authToken, get().refreshAccessToken);
    try {
      const { data } = await api.get("/api/auth/me");
      if (data.authenticated && data.doctor) {
        const doctor = withNormalizedRole(data.doctor);
        set({ currentDoctor: doctor, authReady: true });
        // Auto-set names based on role
        if (doctor.role === "mo") set({ moName: doctor.short_name });
        else set({ conName: doctor.short_name });
      } else {
        // Server responded but says the token isn't valid — clear it
        get().clearProactiveRefresh();
        set({ authToken: "", refreshToken: "", currentDoctor: null, authReady: true });
        localStorage.removeItem("gini_auth_token");
        localStorage.removeItem("gini_refresh_token");
      }
    } catch (e) {
      if (e.response?.status === 401) {
        // Token genuinely rejected by the server — clear it
        get().clearProactiveRefresh();
        set({ authToken: "", refreshToken: "", currentDoctor: null, authReady: true });
        localStorage.removeItem("gini_auth_token");
        localStorage.removeItem("gini_refresh_token");
      } else {
        // Network/server error (timeout, deploy restart, offline) — the token
        // may still be valid, so keep it in localStorage for the next retry
        // instead of forcing a re-login.
        set({ authReady: true });
      }
    }
  },

  // ── refreshAccessToken: exchange the refresh token for a new access token ──
  // Called reactively (api.js's 401 handler) and proactively (the timer set
  // by scheduleProactiveRefresh, on login/init/every prior refresh). Throws
  // on failure so callers can fall back to a full logout. Single-flight —
  // concurrent callers share one in-flight request (see inFlightRefresh above).
  refreshAccessToken: () => {
    if (inFlightRefresh) return inFlightRefresh;
    const { refreshToken } = get();
    if (!refreshToken) return Promise.reject(new Error("No refresh token"));
    inFlightRefresh = api
      .post("/api/auth/refresh", { refresh_token: refreshToken })
      .then(({ data }) => {
        set({ authToken: data.access_token, refreshToken: data.refresh_token });
        localStorage.setItem("gini_auth_token", data.access_token);
        localStorage.setItem("gini_refresh_token", data.refresh_token);
        scheduleProactiveRefresh(data.access_token, get().refreshAccessToken);
        return data.access_token;
      })
      .finally(() => {
        inFlightRefresh = null;
      });
    return inFlightRefresh;
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
        const doctor = withNormalizedRole(data.doctor);
        set({
          authToken: data.token,
          refreshToken: data.refresh_token || "",
          currentDoctor: doctor,
          keySet: true,
          dgKey: "server",
        });
        localStorage.setItem("gini_auth_token", data.token);
        if (data.refresh_token) localStorage.setItem("gini_refresh_token", data.refresh_token);
        scheduleProactiveRefresh(data.token, get().refreshAccessToken);
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
    if (refreshTimer) clearTimeout(refreshTimer);
    const { authToken, refreshToken } = get();
    // api.js's request interceptor reads the access token from localStorage,
    // but only inside a promise callback — it runs AFTER this function's
    // synchronous code finishes, which is after localStorage is already
    // cleared below. Left to the interceptor, the logout request would go
    // out with no x-auth-token header at all: req.doctor never gets
    // populated server-side, and the auth_sessions row for the CURRENT
    // access token is never deleted — it stays usable until its own 15-min
    // TTL lapses, defeating "logout is instant" (see the plan doc §2a).
    // Passing the header explicitly here, while it's still in hand, avoids
    // that race; the interceptor only ever *adds* a header when localStorage
    // still has one, so this doesn't get clobbered.
    api
      .post(
        "/api/auth/logout",
        { refresh_token: refreshToken },
        authToken ? { headers: { "x-auth-token": authToken } } : undefined,
      )
      .catch(() => {});
    set({ authToken: "", refreshToken: "", currentDoctor: null, doctorsList: [] });
    localStorage.removeItem("gini_auth_token");
    localStorage.removeItem("gini_refresh_token");
    sessionStorage.removeItem("gini_active_patient");
    // The app never reloads between sessions, so cached queries (gcTime 30min)
    // and the in-memory patient context would otherwise survive into the next
    // person's session on this browser. Lazy import mirrors api.js — importing
    // patientStore statically would close a cycle through clinicalStore.
    queryClient.clear();
    import("./patientStore.js").then((m) => m.default.getState().resetPatientContext());
  },

  // ── init: fetch doctors list ──
  fetchDoctorsList: async (toast) => {
    set({ doctorsLoading: true });
    try {
      const { data: list } = await api.get("/api/doctors");
      set({ doctorsList: list });
    } catch {
      if (toast) toast("Failed to load doctors list", "warn");
    } finally {
      set({ doctorsLoading: false });
    }
  },
}));

export default useAuthStore;
