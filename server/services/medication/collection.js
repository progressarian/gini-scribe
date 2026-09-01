import pool from "../../config/db.js";

// The per-medicine dispensing record. ONE writer for `medicine_collections`,
// shared by the old counter page (`routes/medicineCollection.js`) and the Gini
// Flow pharmacy station — a second implementation of this upsert would be a
// second answer to "did the patient get their medicines".
//
// Deliberately journey-free: the old module's `stampRxJourney` stays with the
// route that needs it (16-PHARMACY-STATION-PLAN.md §11 q4). Gini Flow moves its
// own visit through `statusEngine`, and stamping `station_tracking` from here
// would reconnect the two floor systems.

export const COLLECTION_STATUSES = ["given", "not_given", "partial"];

export const today = () => new Date().toISOString().split("T")[0];

// Best-effort appointment for a patient on a date (`medications.appointment_id`
// is unreliable, so it is looked up here instead). A patient can hold several
// rows for one date — a lab-only registration beside a consultation, or a
// cancelled booking that was rebooked — so pick exactly one, and never a
// cancelled row.
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

// Upsert one line. Unique on (medication_id, collected_date), so marking the
// same medicine twice in a day corrects the mark rather than adding a second.
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

// Every mark made for one patient on one date, keyed by medication id — what
// the pharmacy card reads to know which rows are already handed over.
export async function collectionsFor(patientId, date, db = pool) {
  const { rows } = await db.query(
    `SELECT medication_id, status, reason, qty_note, marked_by, marked_at
       FROM medicine_collections
      WHERE patient_id = $1 AND collected_date = $2::date`,
    [patientId, date],
  );
  return new Map(rows.map((r) => [r.medication_id, r]));
}
