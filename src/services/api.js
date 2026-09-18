import axios from "axios";

// API base URL — same origin in production
export const API_URL = import.meta.env.VITE_API_URL || window.location.origin;

// ── Centralized axios instance — auto-attaches auth token to every request ──
const api = axios.create({
  baseURL: API_URL,
  headers: { "Content-Type": "application/json" },
});

console.log("API_URL", API_URL);
// Request interceptor: attach JWT token from localStorage
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("gini_auth_token");
  if (token) config.headers["x-auth-token"] = token;
  return config;
});

// ── Silent access-token renewal ──────────────────────────────────────────
// Access tokens are short-lived (15 min); a refresh token exchanges for a
// new one without forcing the user back to /login. Two triggers:
//   1. Reactive — this 401 handler, below, for any request that lands after
//      the access token has already expired.
//   2. Proactive — a timer in authStore.js that refreshes ~60s before the
//      access token's own expiry, so most requests never see a 401 at all,
//      and so long-lived SSE connections (which re-read localStorage fresh
//      on every reconnect — see useGiniflowLive.js) always find a live
//      token waiting.
// authStore's refreshAccessToken() is itself single-flight (shared with the
// proactive timer that lives there), so this just has to reach it.
function doRefresh() {
  return import("../stores/authStore.js").then((m) => m.default.getState().refreshAccessToken());
}

// Blocked-patient refusal. A write against a blocked patient is rejected
// server-side with 409 { reason: "patient_blocked" }
// (server/middleware/blockWriteGuard.js). Surfacing it here means every write
// path reports it without each save handler having to check — the mirror of the
// one middleware that raises it.
//
// `detail` is already redacted by role on the server, so this never has to know
// who is allowed to see the reason.
const BLOCK_TOAST_WINDOW_MS = 6000;
let lastBlockToastAt = 0;

// Exported so the non-axios callers (OPD's apiFetch) report identically instead
// of reimplementing the rule.
export function notifyIfBlocked(body) {
  if (body?.reason !== "patient_blocked") return false;

  // A single save can fan out into several writes; one message per burst.
  const now = Date.now();
  if (now - lastBlockToastAt >= BLOCK_TOAST_WINDOW_MS) {
    lastBlockToastAt = now;
    import("../stores/uiStore.js").then((m) =>
      m.toast(body.detail || "This patient is blocked. Not saved.", "error", 6000),
    );
  }
  return true;
}

// Exported so authStore.js's proactive refresh timer can call it directly —
// see the note there for why a failed proactive refresh can't just swallow
// the error the way this file's own reactive 401 path used to.
export function forceLogout() {
  localStorage.removeItem("gini_auth_token");
  localStorage.removeItem("gini_refresh_token");
  // Lazy-import to avoid circular dependency
  import("../stores/authStore.js").then((m) => {
    m.default.getState().setCurrentDoctor(null);
    m.default.getState().setAuthToken("");
    m.default.getState().setRefreshToken("");
    m.default.getState().clearProactiveRefresh();
  });
  // Session expiry leaves the same residue as an explicit logout.
  import("../queries/client.js").then((m) => m.default.clear());
  import("../stores/patientStore.js").then((m) => m.default.getState().resetPatientContext());
  if (window.location.pathname !== "/login") {
    window.location.replace("/login");
  }
}

export function isRefreshRejected(e) {
  return e?.response?.status === 401 || e?.message === "No refresh token";
}

const REFRESH_PATHS = ["/api/auth/refresh", "/api/patient/auth/refresh"];

// Response interceptor: on 401, try one silent refresh before giving up.
api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 409) notifyIfBlocked(err.response.data);

    const config = err.config || {};
    const isRefreshCall = REFRESH_PATHS.some((p) => config.url?.includes(p));

    if (err.response?.status === 401 && !isRefreshCall && !config._retriedAfterRefresh) {
      const hasRefreshToken = !!localStorage.getItem("gini_refresh_token");
      if (hasRefreshToken) {
        try {
          await doRefresh();
          config._retriedAfterRefresh = true;
          return api.request(config);
        } catch (refreshErr) {
          if (!isRefreshRejected(refreshErr)) return Promise.reject(refreshErr);
        }
      }
      forceLogout();
    }
    return Promise.reject(err);
  },
);

export default api;

// ── JSON repair (for Claude responses) ──
function parseJsonResponse(text) {
  if (!text) return { data: null, error: "Empty response" };
  let clean = text
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  try {
    return { data: JSON.parse(clean), error: null };
  } catch {
    clean = clean.replace(/,\s*([}\]])/g, "$1").replace(/\n/g, " ");
    const balance = (s) => {
      const ob = (s.match(/{/g) || []).length,
        cb = (s.match(/}/g) || []).length;
      const oB = (s.match(/\[/g) || []).length,
        cB = (s.match(/\]/g) || []).length;
      for (let i = 0; i < oB - cB; i++) s += "]";
      for (let i = 0; i < ob - cb; i++) s += "}";
      return s;
    };
    try {
      return { data: JSON.parse(balance(clean)), error: null };
    } catch {
      for (let end = clean.length; end > 50; end -= 10) {
        try {
          return {
            data: JSON.parse(balance(clean.slice(0, end).replace(/,\s*$/, ""))),
            error: null,
          };
        } catch {}
      }
      return { data: null, error: "Parse failed. Try shorter input." };
    }
  }
}

// ── Claude API wrappers ──
export async function callClaude(prompt, content) {
  try {
    const { data: d } = await api.post("/api/ai/complete", {
      messages: [{ role: "user", content: `${prompt}\n\nINPUT:\n${content}` }],
      model: "sonnet",
      maxTokens: 8000,
    });
    if (d.error) return { data: null, error: d.error };
    return parseJsonResponse(d.text);
  } catch (e) {
    return { data: null, error: e.response?.data?.error || e.message };
  }
}

export async function callClaudeFast(prompt, content, maxTokens = 4000) {
  try {
    const { data: d } = await api.post("/api/ai/complete", {
      messages: [{ role: "user", content: `${prompt}\n\nINPUT:\n${content}` }],
      model: "haiku",
      maxTokens,
    });
    if (d.error) return { data: null, error: d.error };
    return parseJsonResponse(d.text);
  } catch (e) {
    return { data: null, error: e.response?.data?.error || e.message };
  }
}
