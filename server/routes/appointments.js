import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { appointmentCreateSchema, appointmentUpdateSchema } from "../schemas/index.js";

const require = createRequire(import.meta.url);
const { syncAppointmentToGenie, syncCareTeamToGenie } = require("../genie-sync.cjs");

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
        `SELECT a.*, COALESCE(p.id, a.patient_id) AS patient_id, p.age, p.sex
         FROM appointments a
         LEFT JOIN patients p
           ON (a.file_no IS NOT NULL AND p.file_no = a.file_no)
           OR (a.file_no IS NULL AND p.id = a.patient_id)
         ${where}${orderBy} LIMIT $${countIdx} OFFSET $${countIdx + 1}`,
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

// Create appointment — auto-matches patient by file_no/phone if patient_id not provided
router.post("/appointments", validate(appointmentCreateSchema), async (req, res) => {
  try {
    let {
      patient_id,
      patient_name,
      file_no,
      phone,
      doctor_name,
      appointment_date,
      time_slot,
      visit_type,
      notes,
      category,
      is_walkin,
    } = req.body;

    // Auto-match or auto-create patient if patient_id not provided
    if (!patient_id && patient_name) {
      if (file_no) {
        const match = await pool.query(`SELECT id FROM patients WHERE file_no = $1 LIMIT 1`, [
          file_no,
        ]);
        if (match.rows[0]) {
          patient_id = match.rows[0].id;
        }
      }

      // No existing patient found — create one with auto-generated file_no
      if (!patient_id) {
        let autoFileNo = file_no || null;
        if (!autoFileNo) {
          const seq = await pool.query(
            `SELECT COALESCE(MAX(CAST(SUBSTRING(file_no FROM 'GNI-([0-9]+)') AS INTEGER)), 0) + 1 AS next
             FROM patients WHERE file_no ~ '^GNI-[0-9]+$'`,
          );
          autoFileNo = `GNI-${String(seq.rows[0].next).padStart(5, "0")}`;
        }
        try {
          const newPt = await pool.query(
            `INSERT INTO patients (name, phone, file_no)
             VALUES ($1, $2, $3) RETURNING id, file_no`,
            [patient_name, phone || null, autoFileNo],
          );
          patient_id = newPt.rows[0].id;
          file_no = newPt.rows[0].file_no;
        } catch (dupErr) {
          const existing = await pool.query(
            `SELECT id, file_no FROM patients WHERE file_no = $1 LIMIT 1`,
            [autoFileNo],
          );
          if (existing.rows[0]) {
            patient_id = existing.rows[0].id;
            file_no = existing.rows[0].file_no;
          }
        }
      }
    }

    const apptDate = appointment_date || new Date().toISOString().split("T")[0];
    const apptSlot = time_slot || null;
    const apptDoctor = doctor_name || null;
    // Walk-in inserts always start scheduled — must match the index predicate
    // so the ON CONFLICT arbiter is found.
    const apptStatus = "scheduled";
    // ON CONFLICT DO NOTHING against idx_appt_patient_day_slot_doc_status —
    // a double-click or concurrent insert with the same (file_no, date, slot,
    // doctor, status) returns the existing row instead of creating a duplicate.
    // Different time_slot OR different doctor OR different status still creates
    // a new row — that lets a cancelled stub + real visit coexist, and a
    // patient seeing two doctors back-to-back is allowed.
    let { rows } = await pool.query(
      `INSERT INTO appointments (patient_id, patient_name, file_no, phone, doctor_name, appointment_date, time_slot, visit_type, notes, category, is_walkin, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (file_no, appointment_date, time_slot, doctor_name, status)
         WHERE file_no IS NOT NULL AND appointment_date IS NOT NULL
           AND time_slot IS NOT NULL AND doctor_name IS NOT NULL
           AND status IS NOT NULL
         DO NOTHING
       RETURNING *`,
      [
        patient_id || null,
        patient_name,
        file_no || null,
        phone || null,
        apptDoctor,
        apptDate,
        apptSlot,
        visit_type || "OPD",
        notes || null,
        category || null,
        is_walkin || false,
        apptStatus,
      ],
    );
    if (!rows[0] && file_no && apptDate && apptSlot && apptDoctor) {
      const existing = await pool.query(
        `SELECT * FROM appointments
          WHERE file_no = $1 AND appointment_date = $2 AND time_slot = $3
            AND doctor_name = $4 AND status = $5
          LIMIT 1`,
        [file_no, apptDate, apptSlot, apptDoctor, apptStatus],
      );
      rows = existing.rows;
    }
    if (rows[0]?.patient_id) {
      syncAppointmentToGenie(rows[0].patient_id, pool).catch((e) =>
        console.warn("[Appt] Appointment push skipped:", e.message),
      );
      if (rows[0].doctor_name) {
        syncCareTeamToGenie(rows[0].patient_id, pool).catch((e) =>
          console.warn("[Appt] Care team push skipped:", e.message),
        );
      }
    }
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Appointment create");
  }
});

// Get single appointment
router.get("/appointments/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, COALESCE(p.id, a.patient_id) AS patient_id
       FROM appointments a
       LEFT JOIN patients p
         ON (a.file_no IS NOT NULL AND p.file_no = a.file_no)
         OR (a.file_no IS NULL AND p.id = a.patient_id)
       WHERE a.id=$1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Appointment get");
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
    if (rows[0].patient_id) {
      syncAppointmentToGenie(rows[0].patient_id, pool).catch((e) =>
        console.warn("[Appt] Appointment push skipped:", e.message),
      );
      if (doctor_name) {
        syncCareTeamToGenie(rows[0].patient_id, pool).catch((e) =>
          console.warn("[Appt] Care team push skipped:", e.message),
        );
      }
    }
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
