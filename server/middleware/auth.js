import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { CAPABILITIES as CAP, hasCapability } from "../../shared/permissions.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");

// Verifies the scribe-issued JWT (doctor OR patient). The `kind` claim
// in the payload distinguishes them; both flavours have a `jti` that lives
// in auth_sessions until logout/expiry.
export const authMiddleware = async (req, res, next) => {
  // Accept the JWT from any of:
  //   • x-auth-token header (default for app/web client `post()` calls)
  //   • Authorization: Bearer <token> (used by fetch() for binary endpoints
  //     like /api/documents/:id/stream where setting custom headers is fine)
  //   • ?token=<token> query string (so the URL handed to <Image> or an
  //     in-app browser is self-authenticating without needing headers)
  const authHeader = req.headers["authorization"] || req.headers["Authorization"];
  const bearerMatch = typeof authHeader === "string" && /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token =
    req.headers["x-auth-token"] ||
    (bearerMatch && bearerMatch[1]) ||
    (typeof req.query?.token === "string" ? req.query.token : null);
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const session = await pool.query(
      "SELECT 1 FROM auth_sessions WHERE token=$1 AND expires_at > NOW()",
      [decoded.jti],
    );
    if (session.rows.length === 0) return next();

    if (decoded.kind === "patient") {
      req.patient = {
        id: decoded.patient_id, // integer (hospital) or uuid string (app)
        db: decoded.db || "hospital", // 'hospital' | 'app' — legacy tokens default
        phone: decoded.phone,
        name: decoded.name,
        jti: decoded.jti,
      };
    } else {
      req.doctor = decoded;
    }
  } catch {
    // invalid or expired token — leave req.{doctor,patient} unset
  }
  next();
};

const PUBLIC_PATHS = [
  "/api/health",
  "/api/doctors",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/me",
  "/api/convert-heic",
  "/api/sync/healthray/full",
  "/api/sync/healthray/today",
  // Patient auth — all of these are pre-auth by design.
  "/api/patient/auth/check",
  "/api/patient/auth/send-otp",
  "/api/patient/auth/verify-otp",
  "/api/patient/auth/set-password",
  "/api/patient/auth/login",
];

const PUBLIC_PREFIXES = ["/api/sync/debug/", "/api/sync/backfill/", "/api/admin/"];

const PUBLIC_PATTERNS = [
  /^\/api\/patients\/[^/]+\/care-team$/,
  /^\/api\/patients\/[^/]+\/conversations\/ensure$/,
  /^\/api\/patients\/[^/]+\/conversations\/[^/]+\/chat-attachment$/,
  /^\/api\/patients\/[^/]+\/chat-attachments\/sign-url$/,
  /^\/api\/patients\/[^/]+\/appointments$/,
  /^\/api\/patients\/[^/]+\/appointments\/[^/]+\/pre-visit-symptoms$/,
  /^\/api\/patients\/[^/]+\/appointments\/[^/]+\/pre-visit-compliance$/,
  /^\/api\/patients\/[^/]+\/side-effects\/notify$/,
];

// Paths under these prefixes must be a doctor — patients are rejected even
// with a valid session. Audit list: clinical workflows, doctor admin,
// sync/import paths that touch other patients' data.
const DOCTOR_ONLY_PREFIXES = [
  "/api/active-visits",
  "/api/consultations",
  "/api/clinical",
  "/api/extract",
  "/api/sync",
  "/api/opd",
  "/api/dashboard",
  "/api/alerts",
  "/api/reasoning",
  "/api/dose-change-requests",
  "/api/refills",
];

// Role-based capability gating. Maps an API path-prefix to the capability a
// doctor must hold to use it. Checked with LONGEST-prefix match, so a nested
// path like /api/patients/:id/refill-requests resolves to /api/patients
// (PATIENT_READ) while the top-level /api/refill-requests resolves to REFILLS.
//
// NOTE: prefixes are the ACTUAL API segments (verified against route files) —
// these differ from the frontend nav paths (e.g. refills page → /api/refill-
// requests). Patient JWTs are unaffected (they use the PUBLIC_PATTERNS
// allowlist); this only gates doctor sessions. While the master switch in
// shared/permissions.js is on, hasCapability() returns true for everyone, so
// these mappings are inert until you flip it off and tune the matrix.
const ROUTE_CAPABILITIES = [
  ["/api/reports", CAP.ANALYTICS],
  ["/api/dashboard", CAP.ANALYTICS],
  ["/api/stats", CAP.ANALYTICS],
  ["/api/consultations", CAP.CLINICAL_WRITE],
  ["/api/clinical", CAP.CLINICAL_WRITE],
  ["/api/reasoning", CAP.CLINICAL_WRITE],
  ["/api/summary", CAP.CLINICAL_WRITE],
  ["/api/post-visit-summary", CAP.CLINICAL_WRITE],
  ["/api/visit", CAP.CLINICAL_WRITE],
  ["/api/active-visit", CAP.CLINICAL_WRITE],
  ["/api/active-visits", CAP.CLINICAL_WRITE],
  ["/api/alerts", CAP.CLINICAL_WRITE],
  ["/api/patient-alerts", CAP.CLINICAL_WRITE],
  ["/api/rx-feedback", CAP.CLINICAL_WRITE],
  ["/api/ai", CAP.AI_TOOLS],
  ["/api/genie-chats", CAP.AI_TOOLS],
  ["/api/genie-patients", CAP.AI_TOOLS],
  ["/api/app-patients", CAP.AI_TOOLS],
  ["/api/refill-requests", CAP.REFILLS],
  ["/api/dose-change-requests", CAP.DOSE_REVIEWS],
  ["/api/lab-requests", CAP.LAB_REQUESTS],
  ["/api/side-effects", CAP.SIDE_EFFECTS],
  ["/api/opd", CAP.RECEPTION_OPS],
  ["/api/appointments", CAP.RECEPTION_OPS],
  ["/api/appointment-slots", CAP.RECEPTION_OPS],
  ["/api/appointment-changes", CAP.RECEPTION_OPS],
  ["/api/ghm-appointments", CAP.RECEPTION_OPS],
  ["/api/walkins", CAP.RECEPTION_OPS],
  ["/api/cancellations", CAP.RECEPTION_OPS],
  ["/api/station-tracking", CAP.RECEPTION_OPS],
  ["/api/cc-calling", CAP.RECEPTION_OPS],
  ["/api/call-attempts", CAP.RECEPTION_OPS],
  ["/api/clinic-holidays", CAP.RECEPTION_OPS],
  ["/api/obt-status", CAP.RECEPTION_OPS],
  ["/api/diabetes-champions", CAP.RECEPTION_OPS],
  ["/api/patients", CAP.PATIENT_READ],
  ["/api/documents", CAP.PATIENT_READ],
  ["/api/outcomes", CAP.PATIENT_READ],
  ["/api/conversations", CAP.PATIENT_READ],
  ["/api/messages", CAP.PATIENT_READ],
];

// Longest-prefix match → required capability (or null if the path isn't mapped).
const capabilityForPath = (path) => {
  let best = null;
  let bestLen = -1;
  for (const [prefix, cap] of ROUTE_CAPABILITIES) {
    if (path === prefix || path.startsWith(prefix + "/")) {
      if (prefix.length > bestLen) {
        best = cap;
        bestLen = prefix.length;
      }
    }
  }
  return best;
};

// Accept either a doctor or patient session for any protected route, unless
// the path falls under DOCTOR_ONLY_PREFIXES. Doctor sessions are additionally
// gated by the ROUTE_CAPABILITIES map (role-based access control).
export const requireAuth = (req, res, next) => {
  if (!req.path.startsWith("/api/") || PUBLIC_PATHS.includes(req.path)) return next();
  if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (PUBLIC_PATTERNS.some((r) => r.test(req.path))) return next();

  const isDoctorOnly = DOCTOR_ONLY_PREFIXES.some((p) => req.path.startsWith(p));
  if (isDoctorOnly && !req.doctor) {
    return res.status(403).json({ error: "Doctor account required" });
  }

  if (!req.doctor && !req.patient) {
    return res.status(401).json({ error: "Authentication required" });
  }

  // Role-based capability check — applies only to doctor sessions.
  if (req.doctor) {
    const requiredCap = capabilityForPath(req.path);
    if (requiredCap && !hasCapability(req.doctor.role, requiredCap)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
  }

  return next();
};

// Per-route guard for endpoints that must NOT accept a patient JWT
// (clinical workflows, doctor admin, sync). Use as middleware on a router:
//   router.post("/active-visits", requireDoctor, handler)
export const requireDoctor = (req, res, next) => {
  if (!req.doctor) return res.status(403).json({ error: "Doctor account required" });
  next();
};

// Per-route capability guard, for endpoints the prefix map can't cover (e.g.
// a path that's in PUBLIC_PATHS for one method but privileged for another, like
// POST /api/doctors). Use as middleware on a router:
//   router.post("/doctors", requireCapability(CAPABILITIES.ADMIN), handler)
// Honors the master switch in shared/permissions.js (open while it's on).
export const requireCapability = (capability) => (req, res, next) => {
  if (!req.doctor) return res.status(403).json({ error: "Doctor account required" });
  if (!hasCapability(req.doctor.role, capability)) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  next();
};
