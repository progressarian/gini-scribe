import { createHash } from "node:crypto";
import pool from "../../config/db.js";
import { columnReady } from "../slots/readiness.js";

export const NOTES_READ_STATUSES = ["read", "skipped_date_mismatch", "empty", "failed"];
export const RX_NOTES_FALLBACK_MIN = 10;

const markerReady = columnReady("appointments", "notes_read_status");

export const notesHash = (text) =>
  createHash("md5")
    .update(String(text ?? ""), "utf8")
    .digest("hex");

export const NOTES_READ_SQL = (a) => `(
  (to_jsonb(${a})->>'notes_read_status' = 'read'
   AND to_jsonb(${a})->>'notes_read_hash' = md5(COALESCE(${a}.healthray_clinical_notes, '')))
  OR (to_jsonb(${a})->>'notes_read_status' IS NULL
      AND ${a}.opd_backfilled_at IS NOT NULL
      AND ${a}.appointment_date <= COALESCE(
        (SELECT (kv.value #>> '{}')::date FROM app_kv kv WHERE kv.key = 'rx_notes_gate_since'),
        DATE '9999-12-31'))
)`;

export async function markNotesReadHash(appointmentId, status, hash, db = pool) {
  if (!appointmentId || !hash || !NOTES_READ_STATUSES.includes(status)) return;
  if (!(await markerReady())) return;
  await db.query(
    `UPDATE appointments
        SET notes_read_status = $2, notes_read_hash = $3, notes_read_at = NOW()
      WHERE id = $1`,
    [appointmentId, status, hash],
  );
}

export const markNotesRead = (appointmentId, status, text, db = pool) =>
  markNotesReadHash(appointmentId, status, notesHash(text), db);

export async function notesReadFor(appointmentId, db = pool) {
  if (!appointmentId) return false;
  const { rows } = await db.query(
    `SELECT ${NOTES_READ_SQL("a")} AS ready FROM appointments a WHERE a.id = $1`,
    [appointmentId],
  );
  return Boolean(rows[0]?.ready);
}

const UNREADABLE = ["skipped_date_mismatch", "empty", "failed"];

export const RX_NOTES_WAIT_JOIN = (v) => `
  LEFT JOIN LATERAL (
    SELECT hd.id AS hr_rx_id,
           (SELECT min(df.created_at) FROM documents df
             WHERE df.patient_id = ${v}.patient_id AND df.doc_type = 'prescription'
               AND df.source = 'healthray' AND df.doc_date = ${v}.visit_date) AS hr_rx_at,
           ha.notes_ready, ha.notes_status
      FROM (
        SELECT d.id FROM documents d
         WHERE d.patient_id = ${v}.patient_id AND d.doc_type = 'prescription'
           AND d.source = 'healthray' AND d.doc_date = ${v}.visit_date
           AND (d.file_url IS NOT NULL OR d.storage_path IS NOT NULL)
         ORDER BY d.created_at DESC, d.id DESC LIMIT 1
      ) hd
      LEFT JOIN LATERAL (
        SELECT ${NOTES_READ_SQL("na")} AS notes_ready,
               to_jsonb(na)->>'notes_read_status' AS notes_status
          FROM appointments na
         WHERE na.patient_id = ${v}.patient_id AND na.appointment_date = ${v}.visit_date
           AND na.healthray_id IS NOT NULL
         ORDER BY (na.id = ${v}.appointment_id) DESC, na.id DESC
         LIMIT 1
      ) ha ON TRUE
  ) nw ON TRUE`;

export const RX_NOTES_WAITING_SQL = (rxSource) => `(
  nw.hr_rx_id IS NOT NULL AND NOT COALESCE(nw.notes_ready, FALSE)
  AND COALESCE(${rxSource}, '') <> 'healthray'
)`;

export const RX_NOTES_WAIT_COLUMNS = (rxSource) =>
  `${RX_NOTES_WAITING_SQL(rxSource)} AS notes_waiting, nw.hr_rx_id, nw.hr_rx_at, nw.notes_status`;

export function notesWaitOf(row, now = new Date()) {
  if (!row?.notes_waiting) return null;
  const since = row.hr_rx_at ? new Date(row.hr_rx_at) : null;
  const unreadable = UNREADABLE.includes(row.notes_status);
  const fallback =
    unreadable || (since !== null && now - since >= RX_NOTES_FALLBACK_MIN * 60 * 1000);
  return {
    since: since ? since.toISOString() : null,
    unreadable,
    healthrayRxId: fallback && row.hr_rx_id ? Number(row.hr_rx_id) : null,
  };
}

export function healthrayFallback(row, now = new Date()) {
  const wait = notesWaitOf(row, now);
  return wait?.healthrayRxId
    ? { ...row, document_id: wait.healthrayRxId, doc_source: "healthray" }
    : null;
}

export function refuseWhileNotesWaiting(row) {
  if (!row?.notes_waiting) return;
  throw Object.assign(
    new Error(
      UNREADABLE.includes(row.notes_status)
        ? "Today's HealthRay notes couldn't be read — use the HealthRay prescription"
        : "Waiting for today's HealthRay notes — the prescription isn't ready yet",
    ),
    { status: 409, reason: "notes_waiting" },
  );
}

export async function rxNotesWaitRow(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT ${RX_NOTES_WAIT_COLUMNS("NULL")}
       FROM giniflow_visits v
       ${RX_NOTES_WAIT_JOIN("v")}
      WHERE v.id = $1`,
    [visitId],
  );
  return rows[0] ?? null;
}
