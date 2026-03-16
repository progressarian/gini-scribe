import axios from "axios";

// API base URL — same origin in production
export const API_URL = import.meta.env.VITE_API_URL || window.location.origin;

// ── Centralized axios instance — auto-attaches auth token to every request ──
const api = axios.create({
  baseURL: API_URL,
  headers: { "Content-Type": "application/json" },
});

// Request interceptor: attach JWT token from localStorage
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("gini_auth_token");
  if (token) config.headers["x-auth-token"] = token;
  return config;
});

// Response interceptor: on 401 clear auth and redirect to login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem("gini_auth_token");
      // Lazy-import to avoid circular dependency
      import("../stores/authStore.js").then((m) => {
        m.default.getState().setCurrentDoctor(null);
        m.default.getState().setAuthToken("");
      });
      if (window.location.pathname !== "/login") {
        window.location.replace("/login");
      }
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
