import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// Get current active visit for the logged-in doctor
router.get("/active-visit", async (req, res) => {
  try {
    const doctorId = req.doctor?.doctor_id;
    const doctorName = req.doctor?.doctor_name;
    if (!doctorId && !doctorName) return res.json(null);

    const { rows } = await pool.query(
      `SELECT av.*, p.name AS patient_name, p.phone, p.file_no, p.age, p.sex,
              p.dob, p.abha_id, p.health_id, p.aadhaar, p.govt_id, p.govt_id_type, p.address
       FROM active_visits av
       LEFT JOIN patients p ON p.id = av.patient_id
       WHERE av.doctor_id = $1 OR av.doctor_name = $2
       ORDER BY av.started_at DESC LIMIT 1`,
      [doctorId || 0, doctorName || ""],
    );
    res.json(rows[0] || null);
  } catch (e) {
    handleError(res, e, "Get active visit");
  }
});

// Start a new active visit
router.post("/active-visit", async (req, res) => {
  try {
    const { patient_id, appointment_id, visit_type, route } = req.body;
    const doctorId = req.doctor?.doctor_id || null;
    const doctorName = req.doctor?.doctor_name || "Unknown";

    // Clear any previous active visit for this doctor
    await pool.query(
      `DELETE FROM active_visits WHERE doctor_id = $1 OR doctor_name = $2`,
      [doctorId || 0, doctorName],
    );

    const { rows } = await pool.query(
      `INSERT INTO active_visits (doctor_id, doctor_name, patient_id, appointment_id, visit_type, route)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [doctorId, doctorName, patient_id || null, appointment_id || null, visit_type || "new", route || null],
    );

    // If starting from an appointment, mark it as in-progress
    if (appointment_id) {
      await pool.query(
        `UPDATE appointments SET status = 'in-progress', updated_at = NOW() WHERE id = $1`,
        [appointment_id],
      );
    }

    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Start active visit");
  }
});

// Update route for the active visit
router.put("/active-visit", async (req, res) => {
  try {
    const { route } = req.body;
    const doctorId = req.doctor?.doctor_id;
    const doctorName = req.doctor?.doctor_name;

    const { rows } = await pool.query(
      `UPDATE active_visits SET route = $1
       WHERE doctor_id = $2 OR doctor_name = $3 RETURNING *`,
      [route, doctorId || 0, doctorName || ""],
    );
    res.json(rows[0] || null);
  } catch (e) {
    handleError(res, e, "Update active visit");
  }
});

// End the active visit
router.delete("/active-visit", async (req, res) => {
  try {
    const doctorId = req.doctor?.doctor_id;
    const doctorName = req.doctor?.doctor_name;
    const { markCompleted } = req.query;

    // Get the active visit first to find appointment_id
    const { rows: visits } = await pool.query(
      `DELETE FROM active_visits WHERE doctor_id = $1 OR doctor_name = $2 RETURNING *`,
      [doctorId || 0, doctorName || ""],
    );

    // If the visit was from an appointment and markCompleted is set, update appointment status
    if (visits[0]?.appointment_id && markCompleted === "1") {
      await pool.query(
        `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [visits[0].appointment_id],
      );
    }

    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "End active visit");
  }
});

export default router;
