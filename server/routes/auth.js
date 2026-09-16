import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import pool from "../config/db.js";
import { dbUrl, needsSsl } from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { loginSchema, refreshTokenSchema } from "../schemas/index.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { requireCapability } from "../middleware/auth.js";
import { CAPABILITIES } from "../../shared/permissions.js";
import {
  issueDoctorRefreshToken,
  lookupRefreshToken,
  revokeFamily,
  revokeToken,
  rotateRefreshToken,
  ttlToMs,
} from "../services/refreshTokens.js";

if (!process.env.JWT_SECRET) {
  throw new Error(
    "JWT_SECRET is not set — a random per-process secret would silently invalidate every session on restart",
  );
}
const JWT_SECRET = process.env.JWT_SECRET;
// Access tokens are short-lived; a refresh token (server/services/refreshTokens.js)
// silently renews them without forcing re-login. See docs/ACCESS_REFRESH_TOKEN_AUTH_PLAN.md.
const JWT_EXPIRES_IN = process.env.JWT_ACCESS_EXPIRES_IN || "15m";

const router = Router();

// Health check
router.get("/health", async (_, res) => {
  const info = {
    status: "ok",
    service: "gini-scribe-api",
    hasDbUrl: !!dbUrl,
    dbHost: dbUrl ? new URL(dbUrl).hostname : null,
    dbPort: dbUrl ? new URL(dbUrl).port : null,
    sslEnabled: needsSsl,
  };
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ ...info, db: "connected", time: r.rows[0].now });
  } catch (e) {
    res.json({ ...info, db: "error" });
  }
});

// HEIC conversion placeholder
router.post("/convert-heic", async (req, res) => {
  res.status(400).json({
    error:
      "HEIC not supported. Please change iPhone settings: Settings → Camera → Formats → Most Compatible",
  });
});

// Get all active doctors (for login screen)
router.get("/doctors", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, short_name, specialty, qualification, role, is_chief FROM doctors WHERE is_active=true ORDER BY role, name",
    );
    res.json(result.rows);
  } catch (e) {
    console.error("Doctors fetch error:", e.message);
    res.json([]);
  }
});

// Login with PIN (bcrypt) — rate limited: 5 failed attempts per 15 min per IP
router.post("/auth/login", loginLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { doctor_id, pin } = req.body;
    const doc = await pool.query("SELECT * FROM doctors WHERE id=$1 AND is_active=true", [
      doctor_id,
    ]);
    if (doc.rows.length === 0) return res.status(401).json({ error: "Invalid PIN" });

    const doctor = doc.rows[0];
    // Support both bcrypt hash and legacy plain-text pin
    let pinValid = false;
    if (doctor.pin && doctor.pin.startsWith("$2")) {
      pinValid = await bcrypt.compare(pin, doctor.pin);
    } else {
      pinValid = doctor.pin === pin;
    }
    if (!pinValid) return res.status(401).json({ error: "Invalid PIN" });

    const jti = crypto.randomBytes(16).toString("hex");

    const token = jwt.sign(
      {
        doctor_id: doctor.id,
        doctor_name: doctor.name,
        short_name: doctor.short_name,
        specialty: doctor.specialty,
        role: doctor.role,
        jti,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );

    // Store jti in auth_sessions for revocation support on logout. expires_at
    // matches the access token's own TTL — the JWT's exp claim is the real
    // gate, this just keeps the table from holding stale rows for longer
    // than the token they guard is even valid.
    await pool.query(
      "INSERT INTO auth_sessions (doctor_id, token, expires_at) VALUES ($1, $2, $3)",
      [doctor_id, jti, new Date(Date.now() + ttlToMs(JWT_EXPIRES_IN))],
    );

    const refresh_token = await issueDoctorRefreshToken(doctor_id, {
      userAgent: req.headers["user-agent"],
      ip: req.ip,
    });

    // Audit
    await pool.query(
      "INSERT INTO audit_log (doctor_id, action, details) VALUES ($1, 'login', $2)",
      [doctor_id, JSON.stringify({ ip: req.ip })],
    );

    // `token` kept alongside `access_token` for one deploy cycle so a tab
    // still open on the old client code doesn't break — see rollout plan.
    res.json({
      token,
      access_token: token,
      refresh_token,
      expires_in: Math.floor(ttlToMs(JWT_EXPIRES_IN) / 1000),
      doctor,
    });
  } catch (e) {
    handleError(res, e, "Login");
  }
});

// Refresh — exchange a still-valid refresh token for a new access+refresh
// pair. Rotates on every use; reusing an already-rotated token revokes the
// whole rotation family and forces a full re-login (signature of a stolen
// token in play). See docs/ACCESS_REFRESH_TOKEN_AUTH_PLAN.md §4b.
router.post("/auth/refresh", loginLimiter, validate(refreshTokenSchema), async (req, res) => {
  try {
    const { refresh_token } = req.body;
    const result = await lookupRefreshToken(refresh_token);

    if (!result.ok) {
      if (result.reason === "reused") {
        await revokeFamily(result.row.family_id);
        // A rotated-out token reused long after the fact (not the brief
        // legitimate-race grace window — see refreshTokens.js) is the
        // signature of a stolen refresh token. Killing the family stops it
        // minting any MORE access tokens, but doesn't touch one already
        // live — pull those too instead of leaving up to 15 minutes of
        // access on the table.
        await pool
          .query("DELETE FROM auth_sessions WHERE doctor_id=$1", [result.row.doctor_id])
          .catch(() => {});
      }
      return res
        .status(401)
        .json({ error: "Refresh token invalid or expired", code: "refresh_invalid" });
    }
    if (result.row.kind !== "doctor") {
      return res
        .status(401)
        .json({ error: "Refresh token invalid or expired", code: "refresh_invalid" });
    }

    const doc = await pool.query("SELECT * FROM doctors WHERE id=$1 AND is_active=true", [
      result.row.doctor_id,
    ]);
    if (doc.rows.length === 0) {
      await revokeFamily(result.row.family_id);
      return res.status(401).json({ error: "Account inactive", code: "refresh_invalid" });
    }
    const doctor = doc.rows[0];

    const jti = crypto.randomBytes(16).toString("hex");
    const access_token = jwt.sign(
      {
        doctor_id: doctor.id,
        doctor_name: doctor.name,
        short_name: doctor.short_name,
        specialty: doctor.specialty,
        role: doctor.role,
        jti,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );
    await pool.query(
      "INSERT INTO auth_sessions (doctor_id, token, expires_at) VALUES ($1, $2, $3)",
      [doctor.id, jti, new Date(Date.now() + ttlToMs(JWT_EXPIRES_IN))],
    );

    const new_refresh_token = await rotateRefreshToken(result.row);

    res.json({
      access_token,
      refresh_token: new_refresh_token,
      expires_in: Math.floor(ttlToMs(JWT_EXPIRES_IN) / 1000),
    });
  } catch (e) {
    handleError(res, e, "Refresh");
  }
});

// Logout — revoke the JWT by removing its jti from auth_sessions, and revoke
// the whole refresh-token family so a stolen refresh token dies with it too.
router.post("/auth/logout", async (req, res) => {
  if (req.doctor?.jti) {
    await pool.query("DELETE FROM auth_sessions WHERE token=$1", [req.doctor.jti]).catch(() => {});
  }
  if (req.body?.refresh_token) {
    const result = await lookupRefreshToken(req.body.refresh_token).catch(() => null);
    if (result?.row) await revokeFamily(result.row.family_id).catch(() => {});
    else await revokeToken(req.body.refresh_token).catch(() => {});
  }
  res.json({ ok: true });
});

// Check session — always fetch fresh doctor data from DB
router.get("/auth/me", async (req, res) => {
  if (!req.doctor) return res.json({ authenticated: false });
  try {
    const result = await pool.query(
      "SELECT id, name, short_name, specialty, qualification, role FROM doctors WHERE id=$1 AND is_active=true",
      [req.doctor.doctor_id],
    );
    if (result.rows.length === 0) return res.json({ authenticated: false });
    res.json({ authenticated: true, doctor: result.rows[0] });
  } catch (e) {
    handleError(res, e, "Session check");
  }
});

// Create a new doctor (with bcrypt-hashed PIN). Admin-only — note GET /doctors
// stays public (login dropdown) but this POST shares the path, so it's guarded
// per-route rather than via the prefix map.
router.post("/doctors", requireCapability(CAPABILITIES.ADMIN), async (req, res) => {
  try {
    const { name, short_name, specialty, role, pin, phone, license_no } = req.body;
    if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required" });

    const pinHash = await bcrypt.hash(pin, 10);
    const result = await pool.query(
      `INSERT INTO doctors (name, short_name, specialty, role, pin, phone, license_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, short_name, specialty, role`,
      [
        name,
        short_name || null,
        specialty || null,
        role || "mo",
        pinHash,
        phone || null,
        license_no || null,
      ],
    );
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Create doctor");
  }
});

// Update editable doctor fields — the chief designation and the qualification
// printed on the letterhead. Admin-only. Fields absent from the body are left
// alone, so the Chief toggle and the qualification box save independently.
router.patch("/doctors/:id", requireCapability(CAPABILITIES.ADMIN), async (req, res) => {
  try {
    const { is_chief, qualification } = req.body || {};
    const sets = [];
    const params = [req.params.id];

    if (is_chief !== undefined) {
      if (typeof is_chief !== "boolean") {
        return res.status(400).json({ error: "is_chief must be a boolean" });
      }
      params.push(is_chief);
      sets.push(`is_chief=$${params.length}`);
    }

    if (qualification !== undefined) {
      if (qualification !== null && typeof qualification !== "string") {
        return res.status(400).json({ error: "qualification must be a string" });
      }
      const q = String(qualification ?? "")
        .trim()
        .slice(0, 120);
      params.push(q || null);
      sets.push(`qualification=$${params.length}`);
    }

    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });

    const r = await pool.query(
      `UPDATE doctors SET ${sets.join(", ")} WHERE id=$1
        RETURNING id, name, short_name, is_chief, qualification`,
      params,
    );
    if (!r.rows.length) return res.status(404).json({ error: "Doctor not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Update doctor");
  }
});

export default router;
