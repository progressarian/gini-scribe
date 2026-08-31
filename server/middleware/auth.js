import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import {
  CAPABILITIES as CAP,
  hasAnyCapability,
  canViewAnalytics,
} from "../../shared/permissions.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");

export const authMiddleware = async (req, res, next) => {
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

const PUBLIC_PREFIXES = ["/api/sync/debug/", "/api/sync/backfill/"];

const PUBLIC_PATTERNS = [
  /^\/api\/patients\/[^/]+\/care-team$/,
  /^\/api\/patients\/[^/]+\/conversations\/ensure$/,
  /^\/api\/patients\/[^/]+\/conversations\/[^/]+\/chat-attachment$/,
  /^\/api\/patients\/[^/]+\/chat-attachments\/sign-url$/,
  /^\/api\/patients\/[^/]+\/appointments$/,
  /^\/api\/patients\/[^/]+\/appointments\/[^/]+\/pre-visit-symptoms$/,
  /^\/api\/patients\/[^/]+\/appointments\/[^/]+\/pre-visit-compliance$/,
  /^\/api\/patients\/[^/]+\/side-effects\/notify$/,
  // Patient flow tracking page — read-only, by opaque visit token, no login.
  // Plus the file-gated verify/assessment posts on the same public page.
  /^\/api\/flow\/track\/[^/]+$/,
  /^\/api\/flow\/track\/[^/]+\/(verify|assessment)$/,
];

const DOCTOR_ONLY_PREFIXES = [
  "/api/active-visits",
  "/api/consultations",
  "/api/clinical",
  "/api/extract",
  "/api/sync",
  "/api/opd",
  "/api/dashboard",
  "/api/analytics",
  "/api/alerts",
  "/api/reasoning",
  "/api/dose-change-requests",
  "/api/refills",
  "/api/flow",
];

const ROUTE_CAPABILITIES = [
  ["/api/home-stats", null],
  ["/api/reports", CAP.ANALYTICS],
  ["/api/analytics", CAP.ANALYTICS],
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
  ["/api/patient-blocks", CAP.ADMIN],
  ["/api/patient-block-status", CAP.PATIENT_READ],
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
  ["/api/appointments", [CAP.RECEPTION_OPS, CAP.OBT_OPS]],
  ["/api/appointment-slots", CAP.RECEPTION_OPS],
  ["/api/appointment-changes", [CAP.RECEPTION_OPS, CAP.OBT_OPS]],
  ["/api/ghm-appointments", [CAP.RECEPTION_OPS, CAP.OBT_OPS]],
  ["/api/ghm-patient-record", [CAP.RECEPTION_OPS, CAP.OBT_OPS]],
  ["/api/walkins", CAP.RECEPTION_OPS],
  ["/api/cancellations", CAP.RECEPTION_OPS],
  ["/api/station-tracking", CAP.RECEPTION_OPS],
  // Call logging on the GHM sheet — the part of it OBT actually works.
  ["/api/cc-calling", [CAP.RECEPTION_OPS, CAP.OBT_OPS]],
  ["/api/call-attempts", [CAP.RECEPTION_OPS, CAP.OBT_OPS]],
  ["/api/clinic-holidays", CAP.RECEPTION_OPS],
  ["/api/obt-status", CAP.OBT_OPS],
  ["/api/obt-dashboard", CAP.OBT_OPS],
  ["/api/diabetes-champions", CAP.RECEPTION_OPS],
  ["/api/patients", CAP.PATIENT_READ],
  ["/api/documents", CAP.PATIENT_CHART],
  ["/api/outcomes", CAP.PATIENT_CHART],
  ["/api/conversations", CAP.PATIENT_READ],
  ["/api/messages", CAP.PATIENT_READ],
  ["/api/companion", CAP.PATIENT_READ],
  ["/api/patient", CAP.PATIENT_READ],
  ["/api/push-tokens", CAP.PATIENT_READ],
  ["/api/extract", CAP.CLINICAL_WRITE],
  // Pharmacy counter worklist (docs/medicines-management/).
  ["/api/pharmacy", CAP.MED_COLLECTION],
  ["/api/doctors", CAP.RECEPTION_OPS],
  // Slot availability — drives the time-slot picker on both /find and /ghm.
  ["/api/availability", [CAP.RECEPTION_OPS, CAP.OBT_OPS]],
  ["/api/slot-catalog", CAP.RECEPTION_OPS],
  // App-install funnel, tracked per registering coordinator (registered_by_cc).
  ["/api/app-installs", CAP.RECEPTION_OPS],
  [
    "/api/flow",
    [
      CAP.FLOW_RECEPTION,
      CAP.FLOW_COORDINATOR,
      CAP.FLOW_FLOOR_VIEW,
      CAP.FLOW_STATION,
      CAP.FLOW_PHARMACY,
    ],
  ],
  ["/api/flow/checkin", CAP.FLOW_RECEPTION],
  // Today's booking list behind the check-in screen. Its own row (not the
  // any-of base) so station/pharmacy roles can't read the day's bookings.
  ["/api/flow/appointments", CAP.FLOW_RECEPTION],
  ["/api/flow/from-appointment", CAP.FLOW_RECEPTION],
  ["/api/flow/by-appointments", CAP.FLOW_RECEPTION],
  ["/api/flow/patient-appointment", CAP.FLOW_RECEPTION],
  ["/api/flow/patient-billing", CAP.FLOW_RECEPTION],
  ["/api/flow/queue", [CAP.FLOW_STATION, CAP.FLOW_PHARMACY, CAP.FLOW_COORDINATOR]],
  ["/api/flow/reports", CAP.FLOW_REPORTS],
  ["/api/flow/demo", CAP.ADMIN],
  // One-off backfill/repair endpoints. Was a PUBLIC_PREFIX (unauthenticated).
  ["/api/admin", CAP.ADMIN],
];

export const capabilityForPath = (path) => {
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
    if (requiredCap && !hasAnyCapability(req.doctor.role, requiredCap)) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }
    // Narrower than the capability above: the Population analytics surface is
    // restricted to one named admin (see canViewAnalytics). /api/reports,
    // /api/dashboard and /api/stats keep the plain CAP.ANALYTICS gate.
    if (
      (req.path === "/api/analytics" || req.path.startsWith("/api/analytics/")) &&
      !canViewAnalytics(req.doctor)
    ) {
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
// Accepts an array for an any-of gate, matching ROUTE_CAPABILITIES.
export const requireCapability = (capability) => (req, res, next) => {
  if (!req.doctor) return res.status(403).json({ error: "Doctor account required" });
  if (!hasAnyCapability(req.doctor.role, capability)) {
    return res.status(403).json({ error: "Insufficient permissions" });
  }
  next();
};
