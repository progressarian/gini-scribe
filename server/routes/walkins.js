import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

function buildWalkinWhatsapp({ patient_name, walkin_date, time_slot, visit_type }) {
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

// GET /api/walkins?date=2026-06-02
router.get("/walkins", async (req, res) => {
  try {
    const { date } = req.query;
    const d = date || new Date().toISOString().split("T")[0];
    const r = await pool.query(
      "SELECT * FROM walkin_bookings WHERE walkin_date=$1 ORDER BY time_slot ASC, created_at ASC",
      [d],
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Walk-ins list");
  }
});

// POST /api/walkins
router.post("/walkins", async (req, res) => {
  try {
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
    } = req.body;
    if (!walkin_date || !patient_name)
      return res.status(400).json({ error: "walkin_date and patient_name required" });

    const { whatsapp_message, additional_whatsapp_message } = buildWalkinWhatsapp({
      patient_name,
      walkin_date,
      time_slot,
      visit_type,
    });

    const r = await pool.query(
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
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Walk-in create");
  }
});

// DELETE /api/walkins/:id
router.delete("/walkins/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM walkin_bookings WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Walk-in delete");
  }
});

export default router;
