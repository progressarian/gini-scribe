import pool from "../../config/db.js";
import { httpError } from "./transaction.js";

export const REMOVED_DOCTOR = "doctor_removed";

export const removedText = (name, what) => `${name} was removed, so ${what}`;

export const refuseRemoved = (doctor, what) =>
  httpError(409, removedText(doctor.name, what), {
    code: REMOVED_DOCTOR,
    doctor_id: doctor.id,
  });

export async function removedDoctor(doctorId, db = pool) {
  if (!doctorId) return null;
  const { rows } = await db.query(
    `SELECT id, name FROM doctors WHERE id = $1 AND is_active IS FALSE`,
    [doctorId],
  );
  return rows[0] ?? null;
}

export async function removedDoctorOfItem(itemId, db = pool) {
  if (!itemId) return null;
  const { rows } = await db.query(
    `SELECT d.id, d.name, i.name AS item_name
       FROM service_items i JOIN doctors d ON d.id = i.doctor_id
      WHERE i.id = $1 AND d.is_active IS FALSE`,
    [itemId],
  );
  return rows[0] ?? null;
}

export async function refuseRemovedItem(itemId, what, db = pool) {
  const doctor = await removedDoctorOfItem(itemId, db);
  if (doctor) throw refuseRemoved(doctor, what(doctor.item_name));
}
