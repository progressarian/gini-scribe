import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");

export const authMiddleware = async (req, res, next) => {
  const token = req.headers["x-auth-token"];
  if (!token) return next();
  try {
    // Verify JWT signature + expiry
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check jti hasn't been revoked (logout)
    const session = await pool.query(
      "SELECT 1 FROM auth_sessions WHERE token=$1 AND expires_at > NOW()",
      [decoded.jti],
    );
    if (session.rows.length > 0) {
      req.doctor = decoded;
    }
  } catch {}
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
];

const PUBLIC_PREFIXES = [
  "/api/sync/debug/",
  "/api/sync/backfill/",
  "/api/admin/",
  // Patient app (no scribe JWT): care-team bootstrap + conversation ensure.
  // Requests are scoped to the patient_id in the URL path.
];

// Patterns that always bypass auth (tested with a regex match on req.path).
// Separate from PUBLIC_PREFIXES so we can match nested segments.
const PUBLIC_PATTERNS = [
  /^\/api\/patients\/[^/]+\/care-team$/,
  /^\/api\/patients\/[^/]+\/conversations\/ensure$/,
  // Patient-app chat attachment upload + sign-url. Scoped by patient_id
  // in the URL path, validated against conversation ownership server-side.
  /^\/api\/patients\/[^/]+\/conversations\/[^/]+\/chat-attachment$/,
  /^\/api\/patients\/[^/]+\/chat-attachments\/sign-url$/,
  // Patient app — list a patient's own appointments (past + upcoming) so
  // Genie's Care/Visit tab and home post-visit pill can render even when
  // the gini→supabase sync hasn't replicated the row yet. Scoped by
  // patient_id in the URL path.
  /^\/api\/patients\/[^/]+\/appointments$/,
  // Patient-app pre-visit symptom save. Public (no scribe JWT); scoped
  // by patient_id + appointment id, and the route re-checks that the
  // appointment actually belongs to that patient before writing.
  /^\/api\/patients\/[^/]+\/appointments\/[^/]+\/pre-visit-symptoms$/,
  // Patient-app pre-visit medication-compliance save. Same scoping/ownership
  // pattern as pre-visit symptoms above.
  /^\/api\/patients\/[^/]+\/appointments\/[^/]+\/pre-visit-compliance$/,
];

export const requireAuth = (req, res, next) => {
  if (!req.path.startsWith("/api/") || PUBLIC_PATHS.includes(req.path)) return next();
  if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (PUBLIC_PATTERNS.some((r) => r.test(req.path))) return next();
  if (!req.doctor) return res.status(401).json({ error: "Authentication required" });
  next();
};
