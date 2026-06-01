import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/station-tracking?date=2026-06-02&doctor=...
router.get("/station-tracking", async (req, res) => {
  try {
    const { date, doctor } = req.query;
    const d = date || new Date().toISOString().split("T")[0];
    const params = [d];
    let where = "WHERE st.visit_date=$1";
    if (doctor) {
      params.push(doctor);
      where += ` AND st.doctor_name=$${params.length}`;
    }

    const r = await pool.query(
      `SELECT st.*,
              a.patient_name, a.file_no, a.phone, a.time_slot,
              a.visit_type, a.condition, a.status AS appt_status
       FROM station_tracking st
       LEFT JOIN appointments a ON a.id = st.appointment_id
       ${where}
       ORDER BY a.time_slot ASC NULLS LAST, st.created_at ASC`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Station tracking list");
  }
});

// GET /api/station-tracking/:id
router.get("/station-tracking/:id", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT st.*, a.patient_name, a.file_no, a.time_slot, a.doctor_name
       FROM station_tracking st
       LEFT JOIN appointments a ON a.id=st.appointment_id
       WHERE st.id=$1`,
      [req.params.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Station tracking get");
  }
});

// GET /api/station-tracking/by-appointment/:appt_id
router.get("/station-tracking/by-appointment/:appt_id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM station_tracking WHERE appointment_id=$1", [
      req.params.appt_id,
    ]);
    res.json(r.rows[0] || null);
  } catch (e) {
    handleError(res, e, "Station tracking by appointment");
  }
});

// POST /api/station-tracking — create record for a visit
router.post("/station-tracking", async (req, res) => {
  try {
    const {
      appointment_id,
      patient_id,
      visit_date,
      doctor_name,
      cc_name,
      ghm_checkin_time,
      patient_greet_time,
    } = req.body;
    if (!appointment_id) return res.status(400).json({ error: "appointment_id required" });

    // Upsert — one row per appointment
    const r = await pool.query(
      `INSERT INTO station_tracking (appointment_id, patient_id, visit_date, doctor_name, cc_name, ghm_checkin_time, patient_greet_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (appointment_id)
       DO UPDATE SET ghm_checkin_time=COALESCE(EXCLUDED.ghm_checkin_time, station_tracking.ghm_checkin_time),
                     patient_greet_time=COALESCE(EXCLUDED.patient_greet_time, station_tracking.patient_greet_time),
                     updated_at=NOW()
       RETURNING *`,
      [
        appointment_id,
        patient_id,
        visit_date,
        doctor_name,
        cc_name,
        ghm_checkin_time,
        patient_greet_time,
      ],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    // If no unique constraint, just insert
    if (e.code === "42P10" || e.code === "42703") {
      try {
        const { appointment_id, patient_id, visit_date, doctor_name, cc_name } = req.body;
        const r2 = await pool.query(
          `INSERT INTO station_tracking (appointment_id, patient_id, visit_date, doctor_name, cc_name)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [appointment_id, patient_id, visit_date, doctor_name, cc_name],
        );
        return res.status(201).json(r2.rows[0]);
      } catch (e2) {
        return handleError(res, e2, "Station tracking create fallback");
      }
    }
    handleError(res, e, "Station tracking create");
  }
});

// PATCH /api/station-tracking/:id — update any station check-in/out
router.patch("/station-tracking/:id", async (req, res) => {
  try {
    const allowed = [
      "ghm_checkin_time",
      "patient_greet_time",
      "last_updated_status",
      "last_updated_time",
      "vitals_planned",
      "vitals_checkin",
      "vitals_checkout",
      "rx_planned",
      "rx_checkin",
      "rx_checkout",
      "rx_explained_by",
      "dm_planned",
      "dm_checkin",
      "dm_checkout",
      "ce_planned",
      "ce_checkin",
      "ce_checkout",
      "counsel_planned",
      "counsel_checkin",
      "counsel_checkout",
      "journey_time_mins",
      "reasons_for_waiting",
      "followup_appt_booked",
      "followup_appt_no_reason",
      "followup_appt_date",
      "followup_appt_time",
      "followup_appt_with",
      "enrolled_in_programs",
      "weight_loss_medicine",
      "followup_consult_other",
      "to_be_seen_by_bhansali",
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
      `UPDATE station_tracking SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Station tracking update");
  }
});

// PATCH /api/station-tracking/checkin — quick station check-in by appointment_id
router.patch("/station-tracking/checkin", async (req, res) => {
  try {
    const { appointment_id, station, action = "checkin" } = req.body;
    // station: 'vitals','rx','dm','ce','counsel'
    // action: 'checkin' | 'checkout'
    const col = `${station}_${action}`;
    const allowed = [
      "vitals_checkin",
      "vitals_checkout",
      "rx_checkin",
      "rx_checkout",
      "dm_checkin",
      "dm_checkout",
      "ce_checkin",
      "ce_checkout",
      "counsel_checkin",
      "counsel_checkout",
    ];
    if (!allowed.includes(col))
      return res.status(400).json({ error: `Invalid station/action: ${col}` });

    const r = await pool.query(
      `UPDATE station_tracking SET ${col}=NOW(), updated_at=NOW()
       WHERE appointment_id=$1 RETURNING *`,
      [appointment_id],
    );
    if (!r.rows.length)
      return res.status(404).json({ error: "Tracking record not found for appointment" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Station check-in");
  }
});

export default router;
