// Patient blocklist guard — consulted by every path that creates a booking or
// opens a way back in for a blocked patient.
//
// Deliberately NOT part of bookingGuard.js: that module opens with
//   if (SCHEDULE_ENFORCEMENT === "off" ...) return null;
// and a blocklist must never be switchable off by an env var meant for
// doctor-availability enforcement.
//
// Design: docs/PATIENT_BLOCKLIST_PLAN.md §3.5
import pool from "../config/db.js";
import { hasCapability, CAPABILITIES } from "../../shared/permissions.js";
import { BLOCK_ACTIONS } from "../../shared/patientBlockReasons.js";
import { blockDetail } from "./patientBlockView.js";

const BLOCK_COLUMNS = `id, is_blocked, blocked_reason_code, blocked_note, blocked_at, blocked_by, blocked_by_id`;

// The raw patients row for a block check, or null when there is nothing to check.
export async function fetchBlockRow(patientId, client = pool) {
  if (!patientId) return null;
  const { rows } = await client.query(
    `SELECT ${BLOCK_COLUMNS} FROM patients WHERE id = $1 LIMIT 1`,
    [patientId],
  );
  return rows[0] || null;
}

// file_no first, then phone (including alt_phone) — the same resolution order
// ghm-appointments.js:1028 uses, so every guard resolves identity identically.
// Phone is non-unique by design, so a phone hit is a best-effort match only.
export async function resolvePatientId({ fileNo, phone }, client = pool) {
  if (fileNo) {
    const { rows } = await client.query("SELECT id FROM patients WHERE file_no=$1 LIMIT 1", [
      fileNo,
    ]);
    if (rows[0]) return rows[0].id;
  }
  if (phone) {
    const { rows } = await client.query(
      "SELECT id FROM patients WHERE phone=$1 OR $1 = ANY(alt_phone) LIMIT 1",
      [phone],
    );
    if (rows[0]) return rows[0].id;
  }
  return null;
}

export async function isPatientBlocked(patientId, client = pool) {
  const row = await fetchBlockRow(patientId, client);
  return !!row?.is_blocked;
}

export async function logBlockAction(
  { patientId, action, reasonCode = null, note = null, actorName = null, actorId = null },
  client = pool,
) {
  if (!patientId || !action) return;
  await client.query(
    `INSERT INTO patient_block_log (patient_id, action, reason_code, note, actor_name, actor_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [patientId, action, reasonCode, note, actorName, actorId],
  );
}

// For the unattended sync paths (HealthRay, Google Sheets, no-show backfill).
// They mirror external reality and must keep inserting — refusing would let our
// OPD list diverge from the hospital's real day, and the patient would walk in
// and be on no screen. So we record that it happened instead of blocking it.
// Fire-and-forget: a sync must never fail because of the blocklist.
// See docs/PATIENT_BLOCKLIST_PLAN.md §3.6.1
export function noteSyncedWhileBlocked(patientId, source) {
  if (!patientId) return;
  isPatientBlocked(patientId)
    .then((blocked) => {
      if (!blocked) return;
      return logBlockAction({
        patientId,
        action: BLOCK_ACTIONS.SYNCED_WHILE_BLOCKED,
        note: source || null,
        actorName: source || "sync",
      });
    })
    .catch(() => {});
}

// Returns null when the booking is allowed. Otherwise:
//   { blocked:true, row, detail }
// `detail` is already redacted for `role` — reception and OBT trigger most
// refusals and must not be handed the reason text.
//
// An admin passing force=true overrides, the same idiom as bookingGuard.js:33.
// The override is recorded, not silent.
export async function checkPatientBlocked({ patientId, force, role, actor }, client = pool) {
  const row = await fetchBlockRow(patientId, client);
  if (!row?.is_blocked) return null;

  if (force && hasCapability(role, CAPABILITIES.ADMIN)) {
    await logBlockAction(
      {
        patientId,
        action: BLOCK_ACTIONS.OVERRIDE_BOOKING,
        actorName: actor?.name || null,
        actorId: actor?.id || null,
      },
      client,
    ).catch(() => {});
    return null;
  }

  return { blocked: true, row, detail: blockDetail(row, role) };
}

// The 409 body every caller sends. One shape, so the UI handles it once.
export const blockedResponse = (guard) => ({
  error: "Patient is blocked",
  reason: "patient_blocked",
  detail: guard.detail,
});

// The actor shape used by the block log, matching claimant(req) in
// ghm-appointments.js so both logs name people the same way.
export const blockActor = (req) => ({
  id: req?.doctor?.doctor_id || null,
  name: req?.doctor?.short_name || req?.doctor?.doctor_name || null,
});
