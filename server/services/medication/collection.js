import pool from "../../config/db.js";
export const COLLECTION_STATUSES = ["given", "not_given", "partial"];

export const today = () => new Date().toISOString().split("T")[0];

export async function appointmentFor(db, patientId, date) {
  const { rows } = await db.query(
    `SELECT id FROM appointments
      WHERE patient_id = $1 AND appointment_date = $2::date
      ORDER BY (LOWER(COALESCE(status, '')) = 'cancelled'), created_at DESC
      LIMIT 1`,
    [patientId, date],
  );
  return rows[0]?.id || null;
}

export async function markCollection(
  db,
  {
    medicationId,
    patientId,
    appointmentId = null,
    date,
    status,
    reason = null,
    qtyNote = null,
    markedBy = null,
  },
) {
  const { rows } = await db.query(
    `INSERT INTO medicine_collections
       (medication_id, patient_id, appointment_id, collected_date, status, reason, qty_note, marked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (medication_id, collected_date)
     DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason,
                   qty_note = EXCLUDED.qty_note, marked_by = EXCLUDED.marked_by,
                   updated_at = NOW()
     RETURNING *`,
    [medicationId, patientId, appointmentId, date, status, reason, qtyNote, markedBy],
  );
  return rows[0];
}

// Many lines for one patient, in the caller's transaction.
export async function markCollections(
  db,
  { patientId, appointmentId = null, date, items, markedBy = null },
) {
  const marked = [];
  for (const item of items) {
    marked.push(
      await markCollection(db, {
        medicationId: item.medication_id ?? item.medicationId,
        patientId,
        appointmentId,
        date,
        status: item.status,
        reason: item.reason || null,
        qtyNote: item.qty_note ?? item.qtyNote ?? null,
        markedBy,
      }),
    );
  }
  return marked;
}
export async function collectionsFor(patientId, date, db = pool) {
  const { rows } = await db.query(
    `SELECT medication_id, status, reason, qty_note, marked_by, marked_at
       FROM medicine_collections
      WHERE patient_id = $1 AND collected_date = $2::date`,
    [patientId, date],
  );
  return new Map(rows.map((r) => [r.medication_id, r]));
}
