import pool from "../config/db.js";
import { CAPABILITIES, hasCapability } from "../../shared/permissions.js";

const COLUMNS = `n.id, n.kind, n.severity, n.title, n.body, n.link, n.entity_type, n.entity_id,
  n.created_at, n.updated_at`;

export function capabilitiesOf(doctor) {
  return Object.values(CAPABILITIES).filter((c) => hasCapability(doctor, c));
}

export async function raiseNotification(db, input) {
  const params = [
    input.kind,
    input.severity ?? "info",
    input.capability ?? null,
    input.doctorId ?? null,
    input.title,
    input.body ?? null,
    input.link ?? null,
    input.entityType ?? null,
    input.entityId === undefined || input.entityId === null ? null : String(input.entityId),
    input.dedupeKey ?? null,
  ];
  if (!input.dedupeKey) {
    const { rows } = await db.query(
      `INSERT INTO notifications
         (kind, severity, capability, doctor_id, title, body, link, entity_type, entity_id, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      params,
    );
    return rows[0].id;
  }
  const { rows } = await db.query(
    `INSERT INTO notifications
       (kind, severity, capability, doctor_id, title, body, link, entity_type, entity_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) WHERE resolved_at IS NULL AND dedupe_key IS NOT NULL
     DO UPDATE SET severity = EXCLUDED.severity, title = EXCLUDED.title, body = EXCLUDED.body,
                   link = EXCLUDED.link, updated_at = NOW()
       WHERE notifications.title IS DISTINCT FROM EXCLUDED.title
          OR notifications.body IS DISTINCT FROM EXCLUDED.body
          OR notifications.severity IS DISTINCT FROM EXCLUDED.severity
          OR notifications.link IS DISTINCT FROM EXCLUDED.link
     RETURNING id`,
    params,
  );
  return rows[0]?.id ?? null;
}

export async function resolveNotifications(db, dedupeKeys) {
  const keys = Array.isArray(dedupeKeys) ? dedupeKeys : [dedupeKeys];
  if (!keys.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE notifications SET resolved_at = NOW()
      WHERE dedupe_key = ANY($1::text[]) AND resolved_at IS NULL`,
    [keys],
  );
  return rowCount;
}

export async function resolveNotificationsLike(db, prefix, keep = []) {
  const { rowCount } = await db.query(
    `UPDATE notifications SET resolved_at = NOW()
      WHERE resolved_at IS NULL AND dedupe_key LIKE $1 AND NOT (dedupe_key = ANY($2::text[]))`,
    [`${prefix}%`, keep],
  );
  return rowCount;
}

const AUDIENCE = `n.resolved_at IS NULL AND (n.doctor_id = $1 OR n.capability = ANY($2::text[]))`;

export async function listNotifications(doctor, { limit = 30, unread = false } = {}, db = pool) {
  const caps = capabilitiesOf(doctor);
  const { rows } = await db.query(
    `SELECT ${COLUMNS}, (r.read_at IS NOT NULL AND r.read_at >= n.updated_at) AS read
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.doctor_id = $1
      WHERE ${AUDIENCE}
        ${unread ? "AND (r.read_at IS NULL OR r.read_at < n.updated_at)" : ""}
      ORDER BY (n.severity = 'critical') DESC, n.updated_at DESC
      LIMIT $3`,
    [doctor.doctor_id, caps, limit],
  );
  const { rows: count } = await db.query(
    `SELECT count(*)::int AS unread
       FROM notifications n
       LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.doctor_id = $1
      WHERE ${AUDIENCE} AND (r.read_at IS NULL OR r.read_at < n.updated_at)`,
    [doctor.doctor_id, caps],
  );
  return { rows, unread: count[0].unread };
}

export async function markNotificationsRead(doctor, { ids, all = false }, db = pool) {
  const caps = capabilitiesOf(doctor);
  const { rowCount } = await db.query(
    `INSERT INTO notification_reads (notification_id, doctor_id, read_at)
     SELECT n.id, $1, NOW() FROM notifications n
      WHERE ${AUDIENCE} AND ($3::boolean OR n.id = ANY($4::bigint[]))
     ON CONFLICT (notification_id, doctor_id) DO UPDATE SET read_at = NOW()`,
    [doctor.doctor_id, caps, all, ids ?? []],
  );
  return { marked: rowCount };
}
