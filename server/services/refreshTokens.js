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

// Two rotation calls for the SAME token landing within this window of each
// other are treated as one legitimate client (two browser tabs, a proactive
// timer racing a reactive 401 retry, a dropped-then-retried request) rather
// than a stolen token being replayed — see lookupRefreshToken below.
const REUSE_GRACE_MS = 30 * 1000;

function hash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Mints a brand-new refresh token in a brand-new rotation family — call this
// on login, not on refresh (refresh uses rotate() to stay in the same family).
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

// Looks up a presented refresh token. Returns:
//   { ok: true, row }                    — valid, not expired, not revoked
//   { ok: true, row, graceReuse: true }   — already rotated, but within
//                                           REUSE_GRACE_MS of that rotation —
//                                           tolerated, see the note above
//   { ok: false, reason: "not_found" }
//   { ok: false, reason: "expired" }
//   { ok: false, reason: "reused", row }  — rotated out more than
//                                           REUSE_GRACE_MS ago and presented
//                                           again; caller must revoke the
//                                           whole family (a stolen token
//                                           being replayed looks exactly
//                                           like this)
export async function lookupRefreshToken(token) {
  const { rows } = await pool.query(`SELECT * FROM refresh_tokens WHERE token_hash=$1`, [
    hash(token),
  ]);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.revoked_at) {
    // Tolerate this only when it's the signature of a legitimate rotation
    // race — this row was revoked recently AND a live sibling already exists
    // in the same family (the token rotateRefreshToken minted at the moment
    // it revoked this one). A deliberate revocation (logout, family-kill on
    // real reuse) leaves no live sibling behind, so it stays a hard "reused"
    // immediately — the grace window must never soften an intentional
    // revocation into a 30-second free pass.
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

// Revokes every live refresh token for a patient identity, without needing
// the raw token in hand (e.g. server-initiated session upgrade/rotation,
// where only the access token's claims are available, not the refresh
// token the client is holding).
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

// Rotates a validated row: revoke it, mint + insert a new token in the same family.
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
