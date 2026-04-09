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

const PUBLIC_PREFIXES = ["/api/sync/debug/", "/api/sync/backfill/"];

export const requireAuth = (req, res, next) => {
  if (!req.path.startsWith("/api/") || PUBLIC_PATHS.includes(req.path)) return next();
  if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (!req.doctor) return res.status(401).json({ error: "Authentication required" });
  next();
};
