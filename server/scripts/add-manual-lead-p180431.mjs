// One-off: get Vikas Puri (P_180431) into Scribe for OBT to call.
//
// HealthRay has no appointment for this patient on any date — confirmed by
// querying Dr. Simranpreet Kaur's live appointment list directly (15/16/17
// Sep, all empty). The only source is the prescription PDF the user supplied
// from their 16 Jun 2026 visit, which recommends but never booked a 16 Sep
// follow-up. Since there is nothing in HealthRay to sync, this creates the
// patient + a dateless LEAD row the same way `services/ghmLead.js` already
// does for exactly this situation (a patient OBT needs to call who has no
// appointment yet) — not a fabricated booking.
//
// Usage: node scripts/add-manual-lead-p180431.mjs
import "../loadEnv.js";
import pool from "../config/db.js";
import { createLead } from "../services/ghmLead.js";

const FILE_NO = "P_180431";
const NAME = "Vikas Puri";
const PHONE = "7807936212";
const AGE = 41;
const SEX = "Male";
const PREFERRED_DOCTOR = "Dr. Simranpreet Kaur";
const PREFERRED_DATE = "2026-09-16"; // the date the prescription itself suggested

async function main() {
  const existing = await pool.query(`SELECT id FROM patients WHERE file_no = $1`, [FILE_NO]);
  let patientId = existing.rows[0]?.id;

  if (patientId) {
    console.log(`Patient already exists: id=${patientId}`);
  } else {
    const created = await pool.query(
      `INSERT INTO patients (name, phone, file_no, age, sex)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [NAME, PHONE, FILE_NO, AGE, SEX],
    );
    patientId = created.rows[0].id;
    console.log(`Created patient: id=${patientId} file_no=${FILE_NO}`);
  }

  const leadId = await createLead(patientId);
  console.log(`Lead row: id=${leadId}`);

  await pool.query(
    `UPDATE appointments
        SET preferred_doctor = COALESCE(preferred_doctor, $2),
            preferred_date = COALESCE(preferred_date, $3),
            call_notes = COALESCE(call_notes, $4)
      WHERE id = $1`,
    [
      leadId,
      PREFERRED_DOCTOR,
      PREFERRED_DATE,
      "From 16 Jun 2026 prescription — doctor's own advice was a 16 Sep follow-up; never booked in HealthRay. Call to confirm and book.",
    ],
  );

  const row = await pool.query(
    `SELECT id, patient_name, file_no, phone, status, booking_source,
            preferred_doctor, preferred_date, call_notes
       FROM appointments WHERE id = $1`,
    [leadId],
  );
  console.log("Lead row:", row.rows[0]);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
