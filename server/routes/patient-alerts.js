import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/patient-alerts — list active alerts
router.get("/patient-alerts", async (req, res) => {
  try {
    const { alert_type, priority_only } = req.query;
    const conds = ["is_active=true"];
    const params = [];
    if (alert_type) {
      params.push(alert_type);
      conds.push(`alert_type=$${params.length}`);
    }
    if (priority_only === "true") conds.push("priority_patient=true");
    const r = await pool.query(
      `SELECT * FROM patient_special_alerts WHERE ${conds.join(" AND ")} ORDER BY priority_patient DESC, patient_name ASC`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Patient alerts list");
  }
});

// GET /api/patient-alerts/lookup?file_no=P_100070 — check alert for a patient
router.get("/patient-alerts/lookup", async (req, res) => {
  try {
    const { file_no, patient_id } = req.query;
    if (!file_no && !patient_id)
      return res.status(400).json({ error: "file_no or patient_id required" });
    const cond = file_no ? "file_no=$1" : "patient_id=$1";
    const val = file_no || patient_id;
    const r = await pool.query(
      `SELECT * FROM patient_special_alerts WHERE ${cond} AND is_active=true`,
      [val],
    );
    res.json({ has_alert: r.rows.length > 0, alerts: r.rows });
  } catch (e) {
    handleError(res, e, "Patient alert lookup");
  }
});

// POST /api/patient-alerts
router.post("/patient-alerts", async (req, res) => {
  try {
    const {
      file_no,
      patient_id,
      patient_name,
      alert_type = "scheduling",
      remarks,
      preferred_slots,
      additional_doctor,
      priority_patient = false,
      preferred_date,
      avoid_booking = false,
    } = req.body;
    if (!remarks) return res.status(400).json({ error: "remarks required" });

    const r = await pool.query(
      `INSERT INTO patient_special_alerts
       (file_no,patient_id,patient_name,alert_type,remarks,preferred_slots,
        additional_doctor,priority_patient,preferred_date,avoid_booking)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        file_no,
        patient_id,
        patient_name,
        alert_type,
        remarks,
        preferred_slots,
        additional_doctor,
        priority_patient,
        preferred_date,
        avoid_booking,
      ],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Patient alert create");
  }
});

// PATCH /api/patient-alerts/:id
router.patch("/patient-alerts/:id", async (req, res) => {
  try {
    const allowed = [
      "remarks",
      "preferred_slots",
      "additional_doctor",
      "priority_patient",
      "preferred_date",
      "avoid_booking",
      "alert_type",
      "is_active",
    ];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (k in req.body) {
        vals.push(req.body[k]);
        sets.push(`${k}=$${vals.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    sets.push(`updated_at=NOW()`);
    vals.push(req.params.id);
    const r = await pool.query(
      `UPDATE patient_special_alerts SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Patient alert update");
  }
});

// DELETE /api/patient-alerts/:id — soft delete
router.delete("/patient-alerts/:id", async (req, res) => {
  try {
    await pool.query(
      "UPDATE patient_special_alerts SET is_active=false, updated_at=NOW() WHERE id=$1",
      [req.params.id],
    );
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Patient alert delete");
  }
});

export default router;
