import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/obt-status?date=2026-06-02  — tomorrow's list with call status
router.get("/obt-status", async (req, res) => {
  try {
    const { date } = req.query;
    const d = date || new Date(Date.now() + 86400000).toISOString().split("T")[0];

    // Merge from appointments + existing obt_call_status rows
    const [apptR, obtR] = await Promise.all([
      pool.query(
        `SELECT a.id AS appointment_id, a.appointment_date, a.time_slot,
                a.file_no, a.patient_name, a.phone,
                p.sex AS gender, p.dob, p.address,
                a.visit_type, a.condition, a.chief_complaint,
                a.doctor_name
         FROM appointments a
         LEFT JOIN patients p ON p.file_no = a.file_no
         WHERE a.appointment_date=$1 AND a.status NOT IN ('cancelled','no_show')
         ORDER BY a.time_slot ASC NULLS LAST`,
        [d],
      ),
      pool.query("SELECT * FROM obt_call_status WHERE appointment_date=$1", [d]),
    ]);

    const statusMap = {};
    for (const row of obtR.rows) statusMap[row.appointment_id] = row;

    const merged = apptR.rows.map((a) => ({
      ...a,
      ...(statusMap[a.appointment_id] || {}),
      call_status: statusMap[a.appointment_id]?.call_status || "Pending",
      mo_assigned: statusMap[a.appointment_id]?.mo_assigned || null,
      suggested_blood_test: statusMap[a.appointment_id]?.suggested_blood_test || null,
      notes: statusMap[a.appointment_id]?.notes || null,
      obt_id: statusMap[a.appointment_id]?.id || null,
    }));

    res.json({ date: d, total: merged.length, data: merged });
  } catch (e) {
    handleError(res, e, "OBT status list");
  }
});

// POST /api/obt-status — create or upsert call status for an appointment
router.post("/obt-status", async (req, res) => {
  try {
    const {
      appointment_id,
      appointment_date,
      appointment_time,
      file_no,
      patient_name,
      gender,
      dob,
      mobile,
      address,
      visit_type,
      condition,
      chief_complaint,
      mo_assigned,
      call_status = "Pending",
      suggested_blood_test,
      notes,
    } = req.body;

    const r = await pool.query(
      `INSERT INTO obt_call_status
       (appointment_id,appointment_date,appointment_time,file_no,patient_name,
        gender,dob,mobile,address,visit_type,condition,chief_complaint,
        mo_assigned,call_status,suggested_blood_test,notes,call_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,CURRENT_DATE)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        appointment_id,
        appointment_date,
        appointment_time,
        file_no,
        patient_name,
        gender,
        dob,
        mobile,
        address,
        visit_type,
        condition,
        chief_complaint,
        mo_assigned,
        call_status,
        suggested_blood_test,
        notes,
      ],
    );
    res.status(201).json(r.rows[0] || { ok: true });
  } catch (e) {
    handleError(res, e, "OBT status create");
  }
});

// PATCH /api/obt-status/:id — update call status
router.patch("/obt-status/:id", async (req, res) => {
  try {
    const { call_status, mo_assigned, suggested_blood_test, notes } = req.body;
    const r = await pool.query(
      `UPDATE obt_call_status
       SET call_status=COALESCE($1,call_status),
           mo_assigned=COALESCE($2,mo_assigned),
           suggested_blood_test=COALESCE($3,suggested_blood_test),
           notes=COALESCE($4,notes),
           updated_at=NOW()
       WHERE id=$5 RETURNING *`,
      [call_status, mo_assigned, suggested_blood_test, notes, req.params.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "OBT status update");
  }
});

export default router;
