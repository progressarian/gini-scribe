import pool from "../config/db.js";
import { checkPatientBlocked, resolvePatientId } from "./patientBlockGuard.js";

// The walk-in booking record and the WhatsApp copy that goes with it.
//
// Lives here rather than in routes/walkins.js because reception's arrivals
// screen books walk-ins too, and a second booking path that skipped
// checkPatientBlocked would be a real safety regression — the blocklist exists
// because some patients must not be booked.

export function buildWalkinWhatsapp({ patient_name, walkin_date, time_slot, visit_type }) {
  const isNew = !visit_type || visit_type.toLowerCase().includes("new");
  const base =
    `Hello ${patient_name},\n\n` +
    `Greetings from Gini Health!\n\n` +
    `Your visit to Gini Health Mohali has been booked. ` +
    `Your reporting time at the reception is on ${walkin_date} between ${time_slot}; ` +
    `Consultation fee is Rs. 1500.\n` +
    (isNew
      ? `As you are visiting us for the first time, please do not have any commitments for the next 3 hours from the reporting time.\n\n`
      : `Please do not have any commitments for the next 2-3 hours.\n\n`) +
    `If you can not visit as per this reporting time due to any reason, kindly revert with *Not coming* to this message so that someone in need can be given this slot.\n\n` +
    `For any further queries:\nPlease call 0172 - 4120100/ 9056403020 or visit Gini Health, Sector 69, Mohali.\n` +
    `Find more about us at - www.ginihealth.com`;

  const additional = isNew
    ? null
    : `*Note:* You are advised to report 1 hour after your given reporting time in case:\n` +
      `1) There are no blood test prescribed;\n*OR*\n` +
      `2) You already have got test reports with you\n*OR*\n` +
      `3) Home collection from Ginihealth team has already taken`;

  return { whatsapp_message: base, additional_whatsapp_message: additional };
}

// Resolves identity, refuses a blocked patient, then writes the booking.
// Returns { patientId, booking } — the caller decides what to do with either.
// `guard` is the request context the blocklist needs to allow an admin override
// and to name whoever performed it in the block log.
export async function createWalkinBooking(fields, { force, role, actor } = {}, db = pool) {
  const {
    walkin_date,
    time_slot,
    file_no,
    patient_name,
    contact_number,
    visit_type = "New",
    agent_name,
    reason_for_booking,
    standard_instruction,
    last_visit_date,
    misc,
  } = fields;

  if (!walkin_date || !patient_name) {
    throw Object.assign(new Error("walkin_date and patient_name required"), { status: 400 });
  }

  // Walk-ins carry no patient_id, so resolve identity before checking the
  // blocklist. Composing the WhatsApp copy is skipped for a blocked patient
  // too — the booking is refused below unless an admin forces it.
  const patientId =
    fields.patient_id ?? (await resolvePatientId({ fileNo: file_no, phone: contact_number }, db));
  const blocked = await checkPatientBlocked({ patientId, force, role, actor }, db);
  if (blocked) return { patientId, blocked, booking: null };

  const { whatsapp_message, additional_whatsapp_message } = buildWalkinWhatsapp({
    patient_name,
    walkin_date,
    time_slot,
    visit_type,
  });

  const { rows } = await db.query(
    `INSERT INTO walkin_bookings
     (walkin_date,time_slot,file_no,patient_name,contact_number,visit_type,
      agent_name,reason_for_booking,standard_instruction,last_visit_date,misc,
      whatsapp_message,additional_whatsapp_message)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      walkin_date,
      time_slot,
      file_no,
      patient_name,
      contact_number,
      visit_type,
      agent_name,
      reason_for_booking,
      standard_instruction || visit_type,
      last_visit_date,
      misc,
      whatsapp_message,
      additional_whatsapp_message,
    ],
  );

  return { patientId, blocked: null, booking: rows[0] };
}
