import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// Slot → reporting time mapping (from Slotsday sheet)
const REPORTING_MAP = {
  "9:30 AM to 10 AM": "11:30 AM to 12 PM",
  "10 AM to 11 AM": "12 PM to 1 PM",
  "11 AM to 12 PM": "1 PM to 2 PM",
  "12 PM to 1 PM": "2 PM to 3 PM",
  "1 PM to 2 PM": "3 PM to 4 PM",
  "2 PM to 2:30 PM": "4 PM to 4:30 PM",
  "2:30 PM to 3 PM": "4:30 PM to 5 PM",
  "3 PM to 3:30 PM": "4:30 PM to 5 PM",
  "3:30 PM to 4 PM": "5 PM to 5:30 PM",
};

const FEES = {
  "Dr. Anil Bhansali": 1500,
  "Dr Beant Kaur": 1000,
  "Dr Simran": 1000,
  "Dr Saniya": 1000,
};

function buildWhatsappMessage({
  patient_name,
  doctor_name,
  appointment_date,
  time_slot,
  visit_type,
}) {
  const reporting = REPORTING_MAP[time_slot] || time_slot;
  const dateStr = appointment_date;
  const isNew = !visit_type || visit_type.toLowerCase().includes("new");
  const fee = FEES[doctor_name] || 1500;
  const feeLines = Object.entries(FEES)
    .map(([d, f]) => `${d}: Rs ${f}`)
    .join("; ");

  const base =
    `Hello ${patient_name},\n\n` +
    `Greetings from Gini Health!\n\n` +
    `Your visit to Gini Hospital Mohali has been booked in the department of Endocrinology. ` +
    `Your *reporting time* at the reception is on ${dateStr} between ${reporting}; \n` +
    `*Consultation Fee:* \n${feeLines};\n` +
    `*Follow up within 3 days is free*\n\n` +
    `Please do not have any commitments for the next 2-3 hours from the reporting time.\n\n` +
    `If you cannot visit as per this reporting time due to any reason, kindly revert with *Not coming* to this message so that someone in need can be given this slot.\n\n` +
    `Now you can avail benefit of *SUNDAY OPD* across few specialty available now at Gini Hospital Mohali.\n\n` +
    `For any further queries:\nPlease call 0172 - 4120100/ 9056403020 or visit Gini Health, Sector 69, Mohali.\n` +
    `Find more about us at - www.ginihealth.com`;

  const additional = isNew
    ? null
    : `*Note:* You are advised to report 1 hour after your given reporting time in case:\n` +
      `1) There are no blood test prescribed;\n*OR*\n` +
      `2) You already have got test reports with you\n*OR*\n` +
      `3) Home collection from Ginihealth team has already taken`;

  return { whatsapp_message: base, additional_whatsapp_msg: additional };
}

// GET /api/ghm-appointments/doctors — distinct doctor names with counts
router.get("/ghm-appointments/doctors", async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT doctor_name, COUNT(*)::int AS cnt
       FROM appointments
       WHERE doctor_name IS NOT NULL AND doctor_name NOT IN ('N/A','Dr. Hospital Admin')
       GROUP BY doctor_name
       ORDER BY cnt DESC`,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "GHM doctors list");
  }
});

// GET /api/ghm-appointments — list by date + optional doctor
router.get("/ghm-appointments", async (req, res) => {
  try {
    const { date, doctor, status, page = 1, limit = 50 } = req.query;
    const d = date || new Date().toISOString().split("T")[0];
    const offset = (Math.max(1, +page) - 1) * Math.min(100, +limit);

    const params = [d];
    let where = `WHERE a.appointment_date = $1`;
    if (doctor) {
      params.push(`%${doctor}%`);
      where += ` AND a.doctor_name ILIKE $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }

    const [countR, dataR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM appointments a ${where}`, params),
      pool.query(
        `SELECT a.id, a.appointment_date, a.time_slot, a.reporting_time_slot,
                a.doctor_name, a.patient_name, a.file_no, a.phone,
                a.visit_type, a.appointment_type, a.booking_source,
                a.booked_by_name, a.booking_date, a.condition, a.chief_complaint,
                a.insurance_taken, a.how_did_you_know, a.referred_by_doctor_name,
                a.earlier_slot_given, a.show_no_show, a.status,
                a.requested_by_cc, a.cc_remark_date, a.misc_notes,
                a.reports_uploaded, a.will_get_test_at_gini,
                a.whatsapp_message, a.additional_whatsapp_msg,
                a.notes, a.is_walkin, a.age, a.sex,
                a.call_status, a.call_made_by, a.call_date,
                a.call_notes, a.call_reschedule_date,
                p.address, p.email,
                -- Auto follow-up: next booked appointment for this patient after today
                (SELECT nxt.appointment_date
                 FROM appointments nxt
                 WHERE nxt.file_no = a.file_no
                   AND nxt.file_no IS NOT NULL
                   AND nxt.appointment_date > $1
                   AND nxt.status NOT IN ('cancelled','no_show')
                 ORDER BY nxt.appointment_date ASC
                 LIMIT 1
                ) AS follow_up_date,
                (SELECT nxt.time_slot
                 FROM appointments nxt
                 WHERE nxt.file_no = a.file_no
                   AND nxt.file_no IS NOT NULL
                   AND nxt.appointment_date > $1
                   AND nxt.status NOT IN ('cancelled','no_show')
                 ORDER BY nxt.appointment_date ASC
                 LIMIT 1
                ) AS follow_up_time
         FROM appointments a
         LEFT JOIN patients p ON p.file_no = a.file_no
         ${where}
         ORDER BY a.time_slot ASC NULLS LAST, a.created_at ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Math.min(100, +limit), offset],
      ),
    ]);

    res.json({
      data: dataR.rows,
      total: countR.rows[0]?.total || 0,
      page: +page,
      limit: +limit,
    });
  } catch (e) {
    handleError(res, e, "GHM appointments list");
  }
});

// POST /api/ghm-appointments — create with full GHM fields + auto WhatsApp
router.post("/ghm-appointments", async (req, res) => {
  try {
    const {
      patient_name,
      file_no,
      phone,
      doctor_name,
      appointment_date,
      time_slot,
      visit_type = "New",
      appointment_type = "Physical",
      booking_source = "OBT",
      booked_by_name,
      booking_date,
      insurance_taken,
      how_did_you_know,
      referred_by_doctor_name,
      earlier_slot_given = false,
      condition,
      chief_complaint,
      misc_notes,
      reports_uploaded = false,
      will_get_test_at_gini,
      requested_by_cc,
      cc_remark_date,
      notes,
      is_walkin = false,
    } = req.body;

    if (!patient_name || !appointment_date || !doctor_name)
      return res
        .status(400)
        .json({ error: "patient_name, appointment_date, doctor_name required" });

    // Resolve patient_id from file_no
    let patient_id = null;
    if (file_no) {
      const pr = await pool.query("SELECT id FROM patients WHERE file_no=$1 LIMIT 1", [file_no]);
      patient_id = pr.rows[0]?.id || null;
    }

    // Auto-generate reporting slot and WhatsApp message
    const reporting_time_slot = REPORTING_MAP[time_slot] || time_slot;
    const { whatsapp_message, additional_whatsapp_msg } = buildWhatsappMessage({
      patient_name,
      doctor_name,
      appointment_date,
      time_slot,
      visit_type,
    });

    const r = await pool.query(
      `INSERT INTO appointments (
        patient_id, patient_name, file_no, phone, doctor_name,
        appointment_date, time_slot, reporting_time_slot,
        visit_type, appointment_type, booking_source,
        booked_by_name, booking_date, insurance_taken,
        how_did_you_know, referred_by_doctor_name,
        earlier_slot_given, condition, chief_complaint,
        misc_notes, reports_uploaded, will_get_test_at_gini,
        requested_by_cc, cc_remark_date, notes, is_walkin,
        whatsapp_message, additional_whatsapp_msg, status
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,'scheduled'
      ) RETURNING *`,
      [
        patient_id,
        patient_name,
        file_no,
        phone,
        doctor_name,
        appointment_date,
        time_slot,
        reporting_time_slot,
        visit_type,
        appointment_type,
        booking_source,
        booked_by_name,
        booking_date || appointment_date,
        insurance_taken,
        how_did_you_know,
        referred_by_doctor_name,
        earlier_slot_given,
        condition,
        chief_complaint,
        misc_notes,
        reports_uploaded,
        will_get_test_at_gini,
        requested_by_cc,
        cc_remark_date,
        notes,
        is_walkin,
        whatsapp_message,
        additional_whatsapp_msg,
      ],
    );

    // Increment slot booked_count
    if (time_slot && doctor_name) {
      await pool.query(
        `UPDATE appointment_slots
         SET booked_count = booked_count + 1
         WHERE doctor_name=$1 AND slot_date=$2 AND time_slot=$3`,
        [doctor_name, appointment_date, time_slot],
      );
    }

    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "GHM appointment create");
  }
});

// PATCH /api/ghm-appointments/:id — update GHM fields
router.patch("/ghm-appointments/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = [
      "time_slot",
      "reporting_time_slot",
      "doctor_name",
      "appointment_date",
      "visit_type",
      "appointment_type",
      "booking_source",
      "booked_by_name",
      "booking_date",
      "insurance_taken",
      "how_did_you_know",
      "referred_by_doctor_name",
      "earlier_slot_given",
      "condition",
      "chief_complaint",
      "misc_notes",
      "reports_uploaded",
      "will_get_test_at_gini",
      "requested_by_cc",
      "cc_remark_date",
      "show_no_show",
      "status",
      "notes",
      "call_status",
      "call_made_by",
      "call_date",
      "call_notes",
      "call_reschedule_date",
    ];
    const sets = [];
    const vals = [];
    for (const key of allowed) {
      if (key in req.body) {
        vals.push(req.body[key]);
        sets.push(`${key}=$${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    vals.push(id);
    const r = await pool.query(
      `UPDATE appointments SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "GHM appointment update");
  }
});

// GET /api/ghm-appointments/whatsapp-preview — preview generated message
router.get("/ghm-appointments/whatsapp-preview", (req, res) => {
  const { patient_name, doctor_name, appointment_date, time_slot, visit_type } = req.query;
  if (!patient_name || !doctor_name || !appointment_date || !time_slot)
    return res
      .status(400)
      .json({ error: "patient_name, doctor_name, appointment_date, time_slot required" });
  const msgs = buildWhatsappMessage({
    patient_name,
    doctor_name,
    appointment_date,
    time_slot,
    visit_type,
  });
  res.json({ ...msgs, reporting_time_slot: REPORTING_MAP[time_slot] || time_slot });
});

export default router;
