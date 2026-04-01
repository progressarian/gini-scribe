import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { appointmentCreateSchema, appointmentUpdateSchema } from "../schemas/index.js";

const router = Router();

// List appointments (paginated)
router.get("/appointments", async (req, res) => {
  try {
    const { date, doctor, status } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const d = date || new Date().toISOString().split("T")[0];

    let where = `WHERE a.appointment_date = $1`;
    const params = [d];
    if (doctor) {
      params.push(`%${doctor}%`);
      where += ` AND (a.doctor_name ILIKE $${params.length} OR a.doctor_name IN (SELECT short_name FROM doctors WHERE name ILIKE $${params.length}))`;
    }
    if (status) {
      params.push(status);
      where += ` AND a.status = $${params.length}`;
    }
    const orderBy = ` ORDER BY a.time_slot ASC NULLS LAST, a.created_at ASC`;

    const countIdx = params.length + 1;
    const [countResult, dataResult] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM appointments a ${where}`, params),
      pool.query(
        `SELECT a.*, p.age, p.sex FROM appointments a LEFT JOIN patients p ON p.id = a.patient_id ${where}${orderBy} LIMIT $${countIdx} OFFSET $${countIdx + 1}`,
        [...params, limit, offset],
      ),
    ]);

    const total = countResult.rows[0]?.total || 0;
    res.json({
      data: dataResult.rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (e) {
    handleError(res, e, "Appointments list");
  }
});

// Create appointment
router.post("/appointments", validate(appointmentCreateSchema), async (req, res) => {
  try {
    const {
      patient_id,
      patient_name,
      file_no,
      phone,
      doctor_name,
      appointment_date,
      time_slot,
      visit_type,
      notes,
    } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, phone, doctor_name, appointment_date, time_slot, visit_type, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        patient_id || null,
        patient_name,
        file_no || null,
        phone || null,
        doctor_name,
        appointment_date || new Date().toISOString().split("T")[0],
        time_slot || null,
        visit_type || "OPD",
        notes || null,
      ],
    );
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Appointment create");
  }
});

// Update appointment
router.put("/appointments/:id", validate(appointmentUpdateSchema), async (req, res) => {
  try {
    const { doctor_name, appointment_date, time_slot, visit_type, status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE appointments SET doctor_name=COALESCE($2,doctor_name), appointment_date=COALESCE($3,appointment_date),
       time_slot=COALESCE($4,time_slot), visit_type=COALESCE($5,visit_type), status=COALESCE($6,status),
       notes=COALESCE($7,notes), updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, doctor_name, appointment_date, time_slot, visit_type, status, notes],
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Appointment update");
  }
});

// Delete appointment
router.delete("/appointments/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM appointments WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Appointment delete");
  }
});

export default router;
