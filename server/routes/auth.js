import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../config/db.js";
import { dbUrl, needsSsl } from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { loginSchema } from "../schemas/index.js";

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";

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
      "SELECT id, name, short_name, specialty, role FROM doctors WHERE is_active=true ORDER BY role, name",
    );
    res.json(result.rows);
  } catch (e) {
    console.error("Doctors fetch error:", e.message);
    res.json([]);
  }
});

// Login with PIN
router.post("/auth/login", validate(loginSchema), async (req, res) => {
  try {
    const { doctor_id, pin } = req.body;
    const doc = await pool.query(
      "SELECT * FROM doctors WHERE id=$1 AND pin=$2 AND is_active=true",
      [doctor_id, pin],
    );
    if (doc.rows.length === 0) return res.status(401).json({ error: "Invalid PIN" });

    const doctor = doc.rows[0];
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

    // Store jti in auth_sessions for revocation support on logout
    await pool.query("INSERT INTO auth_sessions (doctor_id, token) VALUES ($1, $2)", [
      doctor_id,
      jti,
    ]);

    // Audit
    await pool.query(
      "INSERT INTO audit_log (doctor_id, action, details) VALUES ($1, 'login', $2)",
      [doctor_id, JSON.stringify({ ip: req.ip })],
    );

    res.json({ token, doctor });
  } catch (e) {
    handleError(res, e, "Login");
  }
});

// Logout — revoke the JWT by removing its jti from auth_sessions
router.post("/auth/logout", async (req, res) => {
  if (req.doctor?.jti) {
    await pool.query("DELETE FROM auth_sessions WHERE token=$1", [req.doctor.jti]).catch(() => {});
  }
  res.json({ ok: true });
});

// Check session — always fetch fresh doctor data from DB
router.get("/auth/me", async (req, res) => {
  if (!req.doctor) return res.json({ authenticated: false });
  try {
    const result = await pool.query(
      "SELECT id, name, short_name, specialty, role FROM doctors WHERE id=$1 AND is_active=true",
      [req.doctor.doctor_id],
    );
    if (result.rows.length === 0) return res.json({ authenticated: false });
    res.json({ authenticated: true, doctor: result.rows[0] });
  } catch (e) {
    handleError(res, e, "Session check");
  }
});

export default router;
