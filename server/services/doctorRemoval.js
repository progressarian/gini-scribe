import pool from "../config/db.js";
import { DONE_OR_INPROGRESS } from "./availability.js";
import { indiaToday } from "./billing/categoryResolver.js";
import { setItemActive } from "./billing/serviceItems.js";
import { httpError, inTransaction } from "./billing/transaction.js";

const REASON_MAX = 500;

function cleanDoctorId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw httpError(400, "Choose a valid doctor");
  return id;
}

function cleanReason(value) {
  const reason = typeof value === "string" ? value.trim() : "";
  if (!reason) throw httpError(400, "Give a reason for deleting this doctor");
  if (reason.length > REASON_MAX) {
    throw httpError(400, `The reason can be at most ${REASON_MAX} characters`);
  }
  return reason;
}

const shape = (row) => ({
  id: row.id,
  name: row.name,
  short_name: row.short_name,
  role: row.role,
  specialty: row.specialty,
  is_active: row.is_active !== false,
  removed_at: row.removed_at,
  removed_by: row.removed_by,
  removed_by_name: row.removed_by_name ?? null,
  removed_reason: row.removed_reason,
});

async function lockDoctor(client, id) {
  const { rows } = await client.query(
    `SELECT id, name, short_name, role, specialty, is_active, removed_at, removed_by,
            removed_reason
       FROM doctors WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows.length) throw httpError(404, "That doctor doesn't exist");
  return rows[0];
}

async function stillBooked(db, doctor) {
  const names = [doctor.name, doctor.short_name].filter(Boolean);
  const [appointments, drafts] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS count FROM appointments a
        WHERE (a.doctor_id = $1 OR a.doctor_name = ANY($2::text[]))
          AND a.appointment_date >= $3::date
          AND LOWER(COALESCE(a.status, '')) <> ALL($4::text[])`,
      [doctor.id, names, indiaToday(), DONE_OR_INPROGRESS],
    ),
    db.query(
      `SELECT count(DISTINCT b.id)::int AS count
         FROM bills b
         JOIN bill_lines l ON l.bill_id = b.id AND l.is_live
         JOIN service_items i ON i.id = l.service_item_id
        WHERE b.status = 'draft' AND b.bill_type = 'invoice' AND i.kind = 'consultation'
          AND COALESCE(i.doctor_id, l.doctor_id) = $1`,
      [doctor.id],
    ),
  ]);
  return {
    future_appointments: appointments.rows[0].count,
    open_drafts: drafts.rows[0].count,
  };
}

async function audit(client, actorId, action, doctorId, details) {
  await client.query(
    `INSERT INTO audit_log (doctor_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, 'doctor', $3, $4)`,
    [actorId, action, doctorId, JSON.stringify(details)],
  );
}

export async function removalPreview(doctorId, db = pool) {
  const id = cleanDoctorId(doctorId);
  const { rows } = await db.query(
    `SELECT id, name, short_name, role, specialty, is_active, removed_at, removed_by,
            removed_reason
       FROM doctors WHERE id = $1`,
    [id],
  );
  if (!rows.length) throw httpError(404, "That doctor doesn't exist");
  return { doctor: shape(rows[0]), ...(await stillBooked(db, rows[0])) };
}

export async function listRemovedDoctors(db = pool) {
  const { rows } = await db.query(
    `SELECT d.id, d.name, d.short_name, d.role, d.specialty, d.is_active, d.removed_at,
            d.removed_by, d.removed_reason, u.name AS removed_by_name
       FROM doctors d LEFT JOIN doctors u ON u.id = d.removed_by
      WHERE d.is_active IS FALSE
      ORDER BY d.removed_at DESC NULLS LAST, lower(d.name), d.id`,
  );
  return rows.map(shape);
}

export async function removeDoctor(doctorId, input, ctx, db = pool) {
  const id = cleanDoctorId(doctorId);
  if (id === ctx?.actorId) throw httpError(409, "You can't delete your own account");
  const reason = cleanReason(input?.reason);
  return inTransaction(async (client) => {
    const before = await lockDoctor(client, id);
    const already = before.is_active === false && before.removed_at !== null;
    const { rows } = already
      ? { rows: [before] }
      : await client.query(
          `UPDATE doctors
              SET is_active = FALSE, removed_at = NOW(), removed_by = $2, removed_reason = $3
            WHERE id = $1
            RETURNING id, name, short_name, role, specialty, is_active, removed_at, removed_by,
                      removed_reason`,
          [id, ctx?.actorId ?? null, reason],
        );
    const { rows: items } = await client.query(
      `SELECT id FROM service_items WHERE doctor_id = $1 AND is_active ORDER BY id`,
      [id],
    );
    for (const item of items) await setItemActive(item.id, false, ctx, client);
    const sessions = await client.query(`DELETE FROM auth_sessions WHERE doctor_id = $1`, [id]);
    const tokens = await client.query(
      `UPDATE refresh_tokens SET revoked_at = NOW()
        WHERE kind = 'doctor' AND doctor_id = $1 AND revoked_at IS NULL`,
      [id],
    );
    const result = {
      already_removed: already,
      items_deactivated: items.map((item) => item.id),
      sessions_revoked: sessions.rowCount,
      refresh_tokens_revoked: tokens.rowCount,
    };
    if (!already)
      await audit(client, ctx?.actorId ?? null, "remove_doctor", id, { reason, ...result });
    return { doctor: shape(rows[0]), ...result, ...(await stillBooked(client, rows[0])) };
  }, db);
}

export async function restoreDoctor(doctorId, ctx, db = pool) {
  const id = cleanDoctorId(doctorId);
  return inTransaction(async (client) => {
    const before = await lockDoctor(client, id);
    if (before.is_active !== false) return { doctor: shape(before), already_active: true };
    const { rows } = await client.query(
      `UPDATE doctors
          SET is_active = TRUE, removed_at = NULL, removed_by = NULL, removed_reason = NULL
        WHERE id = $1
        RETURNING id, name, short_name, role, specialty, is_active, removed_at, removed_by,
                  removed_reason`,
      [id],
    );
    await audit(client, ctx?.actorId ?? null, "restore_doctor", id, {
      removed_at: before.removed_at,
      removed_by: before.removed_by,
      removed_reason: before.removed_reason,
    });
    return { doctor: shape(rows[0]), already_active: false };
  }, db);
}
