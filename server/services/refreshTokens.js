import crypto from "crypto";
import pool from "../config/db.js";

const DOCTOR_TTL = process.env.JWT_REFRESH_EXPIRES_IN_DOCTOR || "7d";
const PATIENT_TTL = process.env.JWT_REFRESH_EXPIRES_IN_PATIENT || "30d";

export function ttlToMs(ttl) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(ttl).trim());
  if (!m) return 7 * 24 * 60 * 60 * 1000;
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 }[m[2]];
  return n * unit;
}

const REUSE_GRACE_MS = 30 * 1000;

function hash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function issueDoctorRefreshToken(doctorId, meta = {}) {
  const token = crypto.randomBytes(48).toString("hex");
  const familyId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlToMs(DOCTOR_TTL));
  await pool.query(
    `INSERT INTO refresh_tokens (kind, doctor_id, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ('doctor', $1, $2, $3, $4, $5, $6)`,
    [doctorId, hash(token), familyId, expiresAt, meta.userAgent || null, meta.ip || null],
  );
  return token;
}

export async function issuePatientRefreshToken(db, patientRef, meta = {}) {
  const token = crypto.randomBytes(48).toString("hex");
  const familyId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlToMs(PATIENT_TTL));
  await pool.query(
    `INSERT INTO refresh_tokens (kind, patient_db, patient_ref, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ('patient', $1, $2, $3, $4, $5, $6, $7)`,
    [
      db,
      String(patientRef),
      hash(token),
      familyId,
      expiresAt,
      meta.userAgent || null,
      meta.ip || null,
    ],
  );
  return token;
}

export async function lookupRefreshToken(token) {
  const { rows } = await pool.query(`SELECT * FROM refresh_tokens WHERE token_hash=$1`, [
    hash(token),
  ]);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.revoked_at) {
    const withinGrace = Date.now() - row.revoked_at.getTime() <= REUSE_GRACE_MS;
    if (withinGrace) {
      const sibling = await pool.query(
        `SELECT 1 FROM refresh_tokens
          WHERE family_id=$1 AND id<>$2 AND revoked_at IS NULL AND expires_at > NOW()
          LIMIT 1`,
        [row.family_id, row.id],
      );
      if (sibling.rows.length) return { ok: true, row, graceReuse: true };
    }
    return { ok: false, reason: "reused", row };
  }
  if (row.expires_at.getTime() < Date.now()) return { ok: false, reason: "expired", row };
  return { ok: true, row };
}

export async function revokeFamily(familyId) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at=NOW() WHERE family_id=$1 AND revoked_at IS NULL`,
    [familyId],
  );
}

export async function revokePatientRefreshTokens(db, patientRef) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at=NOW()
     WHERE kind='patient' AND patient_db=$1 AND patient_ref=$2 AND revoked_at IS NULL`,
    [db, String(patientRef)],
  );
}

export async function revokeToken(token) {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL`,
    [hash(token)],
  );
}

export async function rotateRefreshToken(row) {
  const token = crypto.randomBytes(48).toString("hex");
  const kind = row.kind;
  const ttl = kind === "patient" ? PATIENT_TTL : DOCTOR_TTL;
  const expiresAt = new Date(Date.now() + ttlToMs(ttl));
  await pool.query(`UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1`, [row.id]);
  await pool.query(
    `INSERT INTO refresh_tokens (kind, doctor_id, patient_db, patient_ref, token_hash, family_id, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      kind,
      row.doctor_id,
      row.patient_db,
      row.patient_ref,
      hash(token),
      row.family_id,
      expiresAt,
      row.user_agent,
      row.ip,
    ],
  );
  return token;
}
