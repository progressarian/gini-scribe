// Patient-side authentication — dual-DB.
//
//   • Hospital DB (`vuukipgdegewpwucdgxa`, scribe's pool)         → existing patients
//   • App-only DB (`purzqfmfycfowyxfaumc`, getGenieDb())          → app-self-onboarded patients
//
// On every endpoint we resolve the phone → {db, patient} (hospital wins),
// then mutate the correct DB. JWT carries `db` so /me knows which DB to
// query and middleware can hydrate req.patient accordingly.
//
// Flows are unchanged:
//   • First time:  check → send-otp → verify-otp → set-password   → JWT
//   • Returning:   check → login                                  → JWT
//   • Forgot:      send-otp(purpose='forgot') → verify-otp → set-password
//
// Collision (an app row + a hospital row with the same phone, app row not
// yet migrated): hospital wins; the app row is opportunistically marked
// migrated. If hospital row has no password yet, login returns
// `HOSPITAL_NEEDS_OTP` so the LoginScreen routes the user to OTP-set-password.

import { Router } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { sendOtpSms } from "../services/msg91.js";
import { getGenieDb, autoMigrateGeniePatient } from "../services/genieImport.js";

const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_PATIENT_EXPIRES_IN = "30d";
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;

const router = Router();

function normalisePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return `+${digits}`;
}

function phoneVariants(phone) {
  const digits = phone.replace(/\D/g, "");
  const last10 = digits.slice(-10);
  return Array.from(new Set([phone, digits, `+${digits}`, last10]));
}

function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// ── DB-routing helpers ──────────────────────────────────────────────────────

async function findHospitalPatient(phone) {
  // Scribe DB stores phones inconsistently — sometimes `+91…`, sometimes raw
  // 10 digits, sometimes `91…`, sometimes with spaces/dashes. Try an exact
  // match against the common variants first; if nothing hits, fall back to a
  // digit-only comparison so anything-with-the-same-digits still resolves.
  const variants = phoneVariants(phone);
  const last10 = phone.replace(/\D/g, "").slice(-10);

  const { rows } = await pool.query(
    `SELECT * FROM patients
       WHERE phone = ANY($1)
          OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
          OR right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $2
       LIMIT 1`,
    [variants, last10],
  );
  return rows[0] || null;
}

async function findAppPatient(phone) {
  const db = getGenieDb();
  if (!db) return null;

  // First try exact-variant match (the common case).
  // null = new self-registered patient (insertAppPatient doesn't set the field);
  // false = explicitly not migrated. Treat both as "not yet migrated".
  const { data, error } = await db
    .from("patients")
    .select("*")
    .in("phone", phoneVariants(phone))
    .or("migrated_to_gini.eq.false,migrated_to_gini.is.null")
    .limit(1);
  if (!error && data && data.length > 0) return data[0];

  // Fallback: any row whose digits end with the same last-10. Supabase has no
  // regex_replace helper, so we widen with `ilike` patterns covering the
  // common storage shapes.
  const last10 = phone.replace(/\D/g, "").slice(-10);
  if (!last10) return null;
  const { data: data2 } = await db
    .from("patients")
    .select("*")
    .or(`phone.ilike.%${last10},phone.ilike.+91${last10}`)
    .or("migrated_to_gini.eq.false,migrated_to_gini.is.null")
    .limit(1);
  return data2?.[0] || null;
}

/** Resolve the canonical patient for an incoming phone.
 *  Hospital wins; if BOTH match and the app row is not migrated yet, we
 *  opportunistically mark it migrated so future lookups skip it. */
async function resolvePatientByPhone(phone) {
  const hospital = await findHospitalPatient(phone);
  if (hospital) {
    // Collision: both DBs have a row for this phone. Fire full data migration
    // in background (non-blocking) — doConvert copies all app history into the
    // hospital DB and flips migrated_to_gini=true at the end.
    const app = await findAppPatient(phone);
    if (app) autoMigrateGeniePatient(app).catch(() => {});
    return { db: "hospital", patient: hospital };
  }
  const app = await findAppPatient(phone);
  if (app) return { db: "app", patient: app };
  return { db: null, patient: null };
}

async function listLinkedPatients(db, phone) {
  if (db === "hospital") {
    const last10 = phone.replace(/\D/g, "").slice(-10);
    const { rows } = await pool.query(
      `SELECT id, name, dob, sex, file_no, phone FROM patients
         WHERE phone = ANY($1)
            OR regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $2
            OR right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $2
         ORDER BY id`,
      [phoneVariants(phone), last10],
    );
    return rows;
  }
  const sb = getGenieDb();
  if (!sb) return [];
  const { data } = await sb
    .from("patients")
    .select("id, name, dob, sex, phone")
    .in("phone", phoneVariants(phone));
  return data || [];
}

// ── Per-DB write adapters ───────────────────────────────────────────────────

async function updateHospitalPatient(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = keys.map((k) => fields[k]);
  await pool.query(`UPDATE patients SET ${sets} WHERE id = $1`, [id, ...values]);
}

async function updateAppPatient(id, fields) {
  const db = getGenieDb();
  if (!db) throw new Error("App DB not configured");
  const { error } = await db.from("patients").update(fields).eq("id", id);
  if (error) throw new Error(`App DB update failed: ${error.message}`);
}

async function insertAppPatient(phone) {
  const db = getGenieDb();
  if (!db) throw new Error("App DB not configured");
  // App DB has NOT NULL on `name`; we don't know the patient's real name
  // until they type it on the set-password step. Use the phone as a stub
  // — set-password fills in the real name iff the user types one and the
  // stored name is still falsy.
  const { data, error } = await db
    .from("patients")
    .insert({ phone, name: phone, program_type: "gini_patient" })
    .select("*")
    .single();
  if (error) throw new Error(`App DB insert failed: ${error.message}`);
  return data;
}

async function writePatient(db, id, fields) {
  if (db === "hospital") return updateHospitalPatient(id, fields);
  return updateAppPatient(id, fields);
}

/** Apply password_hash (and any sibling fields you want propagated, e.g.
 *  force_password_reset) to every patients row sharing this phone, across
 *  BOTH the hospital and app DBs. We want a single password to unlock any
 *  of the records linked to a phone number, no matter which row was the
 *  canonical one at set-time. Errors are swallowed so a single failure on
 *  one DB doesn't block the primary write. */
export async function propagatePasswordToAllRows(phone, fields) {
  const variants = phoneVariants(phone);

  // Hospital DB
  try {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = keys.map((k) => fields[k]);
    await pool.query(`UPDATE patients SET ${sets} WHERE phone = ANY($1::text[])`, [
      variants,
      ...values,
    ]);
  } catch (e) {
    console.error("[propagatePassword] hospital update failed", e);
  }

  // App DB
  try {
    const sb = getGenieDb();
    if (sb) {
      await sb.from("patients").update(fields).in("phone", variants);
    }
  } catch (e) {
    console.error("[propagatePassword] app update failed", e);
  }
}

// ── JWT minting ─────────────────────────────────────────────────────────────

async function issueSession(db, patient) {
  const jti = crypto.randomBytes(16).toString("hex");
  const token = jwt.sign(
    {
      kind: "patient",
      db,
      patient_id: patient.id,
      phone: patient.phone,
      name: patient.name,
      jti,
    },
    JWT_SECRET,
    { expiresIn: JWT_PATIENT_EXPIRES_IN },
  );
  await pool.query(
    `INSERT INTO auth_sessions (kind, patient_db, patient_ref, token, expires_at)
     VALUES ('patient', $1, $2, $3, NOW() + INTERVAL '30 days')`,
    [db, String(patient.id), jti],
  );
  return token;
}

function stripSensitive(p) {
  if (!p) return p;
  const {
    password_hash,
    otp_code,
    otp_expires_at,
    otp_attempts,
    otp_last_sent_at,
    verification_token,
    verification_token_expires_at,
    ...rest
  } = p;
  return rest;
}

// ── POST /patient/auth/check ────────────────────────────────────────────────
router.post("/patient/auth/check", async (req, res) => {
  try {
    const phone = normalisePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "phone is required" });
    const { db, patient } = await resolvePatientByPhone(phone);
    // `has_name` lets the signup screen skip asking for a name when we
    // already have a real one on file. Stub names (the phone, set by
    // insertAppPatient) don't count.
    const hasRealName = !!patient?.name && patient.name !== patient.phone;
    res.json({
      exists: !!patient,
      has_password: !!patient?.password_hash,
      has_name: hasRealName,
      source: db, // 'hospital' | 'app' | null
    });
  } catch (e) {
    handleError(res, e, "Patient auth check");
  }
});

// ── POST /patient/auth/send-otp ─────────────────────────────────────────────
router.post("/patient/auth/send-otp", loginLimiter, async (req, res) => {
  try {
    const phone = normalisePhone(req.body?.phone);
    const purpose = req.body?.purpose === "forgot" ? "forgot" : "signup";
    if (!phone) return res.status(400).json({ error: "phone is required" });

    let { db, patient } = await resolvePatientByPhone(phone);

    if (purpose === "signup" && patient?.password_hash) {
      return res.status(409).json({
        error: "An account with this number already exists. Sign in with your password.",
        code: "ALREADY_REGISTERED",
      });
    }
    if (purpose === "forgot" && !patient) {
      return res.status(404).json({
        error: "No account found for this number.",
        code: "NO_ACCOUNT",
      });
    }

    // New signup with neither DB matching → create in app DB.
    // If the app DB isn't configured on this deployment, surface a clearer
    // "not registered" message instead of leaking the internal config error.
    if (!patient) {
      if (!getGenieDb()) {
        return res.status(404).json({
          error: "This phone number is not registered.",
          code: "NOT_REGISTERED",
        });
      }
      patient = await insertAppPatient(phone);
      db = "app";
    }

    if (
      patient.otp_last_sent_at &&
      Date.now() - new Date(patient.otp_last_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS
    ) {
      return res.status(429).json({
        error: "Please wait a minute before requesting another OTP.",
        code: "RESEND_COOLDOWN",
      });
    }

    const otp = generateOtp();
    const otpHash = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await writePatient(db, patient.id, {
      otp_code: otpHash,
      otp_expires_at: expiresAt,
      otp_attempts: 0,
      otp_last_sent_at: new Date(),
      verification_token: null,
      verification_token_expires_at: null,
    });

    await sendOtpSms(phone, otp);

    res.json({ ok: true, purpose, source: db });
  } catch (e) {
    handleError(res, e, "Send OTP");
  }
});

// ── POST /patient/auth/verify-otp ───────────────────────────────────────────
router.post("/patient/auth/verify-otp", loginLimiter, async (req, res) => {
  try {
    const phone = normalisePhone(req.body?.phone);
    const otp = String(req.body?.otp || "").trim();
    if (!phone || otp.length !== 6) return res.status(400).json({ error: "Invalid input" });

    const { db, patient } = await resolvePatientByPhone(phone);
    if (!patient?.otp_code || !patient.otp_expires_at) {
      return res.status(400).json({ error: "Request an OTP first." });
    }
    if (new Date(patient.otp_expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "OTP expired. Please request a new one." });
    }
    if ((patient.otp_attempts ?? 0) >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ error: "Too many attempts. Request a new OTP." });
    }

    const ok = await bcrypt.compare(otp, patient.otp_code);
    if (!ok) {
      await writePatient(db, patient.id, {
        otp_attempts: (patient.otp_attempts ?? 0) + 1,
      });
      return res.status(401).json({ error: "Incorrect OTP." });
    }

    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verExpires = new Date(Date.now() + VERIFICATION_TTL_MS);
    await writePatient(db, patient.id, {
      otp_code: null,
      otp_expires_at: null,
      otp_attempts: 0,
      verification_token: verificationToken,
      verification_token_expires_at: verExpires,
    });

    res.json({ verification_token: verificationToken, source: db });
  } catch (e) {
    handleError(res, e, "Verify OTP");
  }
});

// ── POST /patient/auth/set-password ─────────────────────────────────────────
router.post("/patient/auth/set-password", async (req, res) => {
  try {
    const phone = normalisePhone(req.body?.phone);
    const verificationToken = String(req.body?.verification_token || "").trim();
    const password = String(req.body?.password || "");
    const name = req.body?.name?.toString().trim();
    if (!phone || !verificationToken || password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const { db, patient } = await resolvePatientByPhone(phone);
    if (!patient || patient.verification_token !== verificationToken) {
      return res.status(401).json({ error: "Verification expired. Please request a new OTP." });
    }
    if (
      !patient.verification_token_expires_at ||
      new Date(patient.verification_token_expires_at).getTime() < Date.now()
    ) {
      return res.status(401).json({ error: "Verification expired. Please request a new OTP." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // Treat the phone-as-stub name (set by insertAppPatient) as "not yet
    // named" — let the user override it with their real name on signup.
    const shouldSetName = !!name && (!patient.name || patient.name === patient.phone);
    const fields = {
      password_hash: passwordHash,
      verification_token: null,
      verification_token_expires_at: null,
      // A user setting their own password (signup or forgot) clears any
      // staff-initiated force-reset flag.
      force_password_reset: false,
    };
    if (shouldSetName) fields.name = name;
    await writePatient(db, patient.id, fields);

    // Sync the password to every other row sharing this phone (across both
    // DBs) so the user can log in regardless of which record auth resolves
    // to next time.
    await propagatePasswordToAllRows(phone, {
      password_hash: passwordHash,
      force_password_reset: false,
    });

    // Re-read so we issue a session from the canonical row.
    const refreshed =
      db === "hospital" ? await findHospitalPatient(phone) : await findAppPatient(phone);
    const token = await issueSession(db, refreshed);
    const linkedPatients = await listLinkedPatients(db, phone);
    res.json({
      token,
      db,
      patient: stripSensitive(refreshed),
      linkedPatients,
      force_password_reset: !!refreshed.force_password_reset,
    });
  } catch (e) {
    handleError(res, e, "Set password");
  }
});

// ── POST /patient/auth/login ────────────────────────────────────────────────
router.post("/patient/auth/login", loginLimiter, async (req, res) => {
  try {
    const phone = normalisePhone(req.body?.phone);
    const password = String(req.body?.password || "");
    if (!phone || !password) return res.status(400).json({ error: "Invalid credentials" });

    const { db, patient } = await resolvePatientByPhone(phone);
    if (!patient) return res.status(401).json({ error: "Invalid credentials" });

    if (!patient.password_hash) {
      // Hospital row exists but no password yet → user must OTP-set it.
      if (db === "hospital") {
        return res.status(409).json({
          error: "Please verify your number to set a password.",
          code: "HOSPITAL_NEEDS_OTP",
        });
      }
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const ok = await bcrypt.compare(password, patient.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = await issueSession(db, patient);
    const linkedPatients = await listLinkedPatients(db, phone);
    res.json({
      token,
      db,
      patient: stripSensitive(patient),
      linkedPatients,
      force_password_reset: !!patient.force_password_reset,
    });
  } catch (e) {
    handleError(res, e, "Patient login");
  }
});

// ── POST /patient/auth/logout ───────────────────────────────────────────────
router.post("/patient/auth/logout", async (req, res) => {
  if (req.patient?.jti) {
    await pool.query("DELETE FROM auth_sessions WHERE token=$1", [req.patient.jti]).catch(() => {});
  }
  res.json({ ok: true });
});

// ── GET /patient/auth/me ────────────────────────────────────────────────────
router.get("/patient/auth/me", async (req, res) => {
  try {
    if (!req.patient?.id) return res.status(401).json({ error: "Not authenticated" });
    const db = req.patient.db || "hospital";

    let patient;
    if (db === "hospital") {
      const { rows } = await pool.query("SELECT * FROM patients WHERE id=$1", [req.patient.id]);
      patient = rows[0];
    } else {
      const sb = getGenieDb();
      if (!sb) return res.status(503).json({ error: "App DB not configured" });
      const { data } = await sb.from("patients").select("*").eq("id", req.patient.id).maybeSingle();
      patient = data;
    }
    if (!patient) return res.status(401).json({ error: "Not authenticated" });

    // If an app session's row got migrated since the JWT was minted, surface
    // that so the client can refresh against hospital next time.
    if (db === "app" && patient.migrated_to_gini) {
      return res.status(409).json({
        error: "Account migrated to hospital. Please sign in again.",
        code: "MIGRATED",
      });
    }

    const linkedPatients = await listLinkedPatients(db, patient.phone);
    res.json({
      db,
      patient: stripSensitive(patient),
      linkedPatients,
      force_password_reset: !!patient.force_password_reset,
    });
  } catch (e) {
    handleError(res, e, "Patient me");
  }
});

// ── POST /patient/auth/change-password ──────────────────────────────────────
// Authenticated. Patient supplies old + new password; old is verified, new
// is hashed and stored, force_password_reset flag is cleared. All other
// sessions for the patient are revoked (login from other devices stops
// working) — caller's own session stays valid.
router.post("/patient/auth/change-password", async (req, res) => {
  try {
    if (!req.patient?.id) return res.status(401).json({ error: "Not authenticated" });
    const oldPw = String(req.body?.old_password || "");
    const newPw = String(req.body?.new_password || "");
    if (newPw.length < 6) {
      return res.status(400).json({ error: "New password must be at least 6 characters." });
    }

    const db = req.patient.db || "hospital";
    let patient;
    if (db === "hospital") {
      const { rows } = await pool.query("SELECT * FROM patients WHERE id=$1", [req.patient.id]);
      patient = rows[0];
    } else {
      const sb = getGenieDb();
      if (!sb) return res.status(503).json({ error: "App DB not configured" });
      const { data } = await sb.from("patients").select("*").eq("id", req.patient.id).maybeSingle();
      patient = data;
    }
    if (!patient?.password_hash) return res.status(401).json({ error: "No password on file" });

    const ok = await bcrypt.compare(oldPw, patient.password_hash);
    if (!ok) {
      return res
        .status(401)
        .json({ error: "Current password is incorrect.", code: "WRONG_PASSWORD" });
    }

    const newHash = await bcrypt.hash(newPw, 10);
    await writePatient(db, patient.id, {
      password_hash: newHash,
      force_password_reset: false,
    });

    // Mirror the new password to every other row sharing this phone.
    await propagatePasswordToAllRows(patient.phone, {
      password_hash: newHash,
      force_password_reset: false,
    });

    // Revoke every OTHER session for this patient (keep caller's current jti).
    await pool
      .query(
        `DELETE FROM auth_sessions
         WHERE patient_db=$1 AND patient_ref=$2 AND token<>$3`,
        [db, String(patient.id), req.patient.jti],
      )
      .catch(() => {});

    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Change password");
  }
});

export default router;
