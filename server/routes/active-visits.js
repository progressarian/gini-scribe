import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import {
  savePrescriptionForVisit,
  buildVisitPayloadFromDb,
} from "../services/prescriptionAutoSave.js";

const router = Router();

// Idempotent migrations
pool
  .query(`ALTER TABLE active_visits ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'scheduled'`)
  .catch(() => {});
pool
  .query(`ALTER TABLE active_visits ADD COLUMN IF NOT EXISTS step_data JSONB DEFAULT '{}'`)
  .catch(() => {});

// Get active visit for the logged-in doctor
// ?patient_id=X  → return the in-progress visit for that specific patient
// (no param)     → return the most recent in-progress visit (used for restore on page load)
router.get("/active-visit", async (req, res) => {
  try {
    const doctorId = req.doctor?.doctor_id;
    const doctorName = req.doctor?.doctor_name;
    const { patient_id } = req.query;
    if (!doctorId && !doctorName) return res.json(null);

    const select = `SELECT av.*, p.name AS patient_name, p.phone, p.file_no, p.age, p.sex,
            p.dob, p.abha_id, p.health_id, p.aadhaar, p.govt_id, p.govt_id_type, p.address
     FROM active_visits av
     LEFT JOIN patients p ON p.id = av.patient_id`;

    let rows;
    if (patient_id) {
      ({ rows } = await pool.query(
        `${select}
         WHERE (av.doctor_id = $1 OR av.doctor_name = $2)
           AND av.patient_id = $3 AND av.status = 'in-progress'
         ORDER BY av.started_at DESC LIMIT 1`,
        [doctorId || 0, doctorName || "", patient_id],
      ));
    } else {
      // Only restore visits started within the last 12 hours — older "in-progress"
      // rows are almost always abandoned sessions that were never closed, and
      // would otherwise auto-select a random old patient on page load.
      ({ rows } = await pool.query(
        `${select}
         WHERE (av.doctor_id = $1 OR av.doctor_name = $2)
           AND av.status = 'in-progress'
           AND av.started_at > NOW() - INTERVAL '12 hours'
         ORDER BY av.started_at DESC LIMIT 1`,
        [doctorId || 0, doctorName || ""],
      ));
    }

    res.json(rows[0] || null);
  } catch (e) {
    handleError(res, e, "Get active visit");
  }
});

// Get all active visits (with optional patient_id filter)
router.get("/active-visits", async (req, res) => {
  try {
    const doctorId = req.doctor?.doctor_id;
    const doctorName = req.doctor?.doctor_name;
    const { patient_id } = req.query;

    let query = `SELECT av.*, p.name AS patient_name, p.phone, p.file_no, p.age, p.sex
       FROM active_visits av
       LEFT JOIN patients p ON p.id = av.patient_id
       WHERE (av.doctor_id = $1 OR av.doctor_name = $2) AND av.status = 'in-progress'`;
    const params = [doctorId || 0, doctorName || ""];

    if (patient_id) {
      query += ` AND av.patient_id = $3`;
      params.push(patient_id);
    }
    query += ` ORDER BY av.started_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    handleError(res, e, "Get active visits");
  }
});

// Start a new active visit
// Allows multiple concurrent visits for different patients.
// Prevents duplicate in-progress visit for the same patient+doctor.
router.post("/active-visit", async (req, res) => {
  try {
    const { patient_id, appointment_id, visit_type, route, status } = req.body;
    const doctorId = req.doctor?.doctor_id || null;
    const doctorName = req.doctor?.doctor_name || "Unknown";

    // If a patient_id is given, check for existing in-progress visit for this patient+doctor
    if (patient_id) {
      const { rows: existing } = await pool.query(
        `SELECT * FROM active_visits
         WHERE patient_id = $1 AND (doctor_id = $2 OR doctor_name = $3) AND status = 'in-progress'
         LIMIT 1`,
        [patient_id, doctorId || 0, doctorName],
      );
      if (existing.length > 0) {
        // Already have an in-progress visit for this patient — return it
        return res.json(existing[0]);
      }
    }

    const { rows } = await pool.query(
      `INSERT INTO active_visits (doctor_id, doctor_name, patient_id, appointment_id, visit_type, status, route)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        doctorId,
        doctorName,
        patient_id || null,
        appointment_id || null,
        visit_type || "new",
        status || "in-progress",
        route || null,
      ],
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

// Update route and/or status for a specific active visit
// Targets by patient_id when provided, otherwise falls back to most recent
router.put("/active-visit", async (req, res) => {
  try {
    const { route, status, patient_id, step_data } = req.body;
    const doctorId = req.doctor?.doctor_id;
    const doctorName = req.doctor?.doctor_name;

    const sets = [];
    const params = [];
    let idx = 1;

    if (route !== undefined) {
      sets.push(`route = $${idx++}`);
      params.push(route);
    }
    if (status !== undefined) {
      sets.push(`status = $${idx++}`);
      params.push(status);
    }
    if (step_data !== undefined) {
      sets.push(`step_data = $${idx++}`);
      params.push(JSON.stringify(step_data));
    }

    if (sets.length === 0) return res.json(null);

    params.push(doctorId || 0, doctorName || "");
    let where = `(doctor_id = $${idx++} OR doctor_name = $${idx++})`;

    if (patient_id) {
      params.push(patient_id);
      where += ` AND patient_id = $${idx++}`;
    }

    // Only target in-progress visits
    where += ` AND status = 'in-progress'`;

    const { rows } = await pool.query(
      `UPDATE active_visits SET ${sets.join(", ")} WHERE ${where} RETURNING *`,
      params,
    );

    // Sync status to appointments table if status changed
    if (status && rows[0]?.appointment_id) {
      await pool.query(`UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2`, [
        status,
        rows[0].appointment_id,
      ]);
    }

    res.json(rows[0] || null);
  } catch (e) {
    handleError(res, e, "Update active visit");
  }
});

// Update status for a specific active visit by ID
router.patch("/active-visit/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) return res.status(400).json({ error: "status is required" });

    const validStatuses = ["scheduled", "in-progress", "completed", "cancelled", "no_show"];
    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }

    const { rows } = await pool.query(
      `UPDATE active_visits SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id],
    );

    if (!rows[0]) return res.status(404).json({ error: "Active visit not found" });

    // Sync status to appointments table
    if (rows[0].appointment_id) {
      await pool.query(`UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2`, [
        status,
        rows[0].appointment_id,
      ]);
    }

    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Update active visit status");
  }
});

// End an active visit
// ?patient_id=X    → end only that patient's visit
// ?markCompleted=1 → also mark the linked appointment as completed
router.delete("/active-visit", async (req, res) => {
  try {
    const doctorId = req.doctor?.doctor_id;
    const doctorName = req.doctor?.doctor_name;
    const { markCompleted, patient_id } = req.query;

    let query, params;
    if (patient_id) {
      // Delete the specific patient's visit for this doctor
      query = `DELETE FROM active_visits
               WHERE (doctor_id = $1 OR doctor_name = $2) AND patient_id = $3
               RETURNING *`;
      params = [doctorId || 0, doctorName || "", patient_id];
    } else {
      // Fallback: delete the most recent one only
      query = `DELETE FROM active_visits
               WHERE id = (
                 SELECT id FROM active_visits
                 WHERE (doctor_id = $1 OR doctor_name = $2) AND status = 'in-progress'
                 ORDER BY started_at DESC LIMIT 1
               ) RETURNING *`;
      params = [doctorId || 0, doctorName || ""];
    }

    const { rows: visits } = await pool.query(query, params);

    // If the visit was from an appointment and markCompleted is set, update appointment status
    if (visits[0]?.appointment_id && markCompleted === "1") {
      await pool.query(
        `UPDATE appointments SET status = 'completed', updated_at = NOW() WHERE id = $1`,
        [visits[0].appointment_id],
      );

      const pid = visits[0].patient_id;
      const apptId = visits[0].appointment_id;
      if (pid) {
        (async () => {
          const payload = await buildVisitPayloadFromDb(pid, { appointmentId: apptId });
          if (payload) {
            await savePrescriptionForVisit(pid, payload, {
              appointmentId: apptId,
              source: "visit",
              titlePrefix: "Prescription — Visit",
            });
          }
        })().catch((e) => console.warn("[active-visits/end] Rx auto-save failed:", e.message));
      }
    }

    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "End active visit");
  }
});

export default router;
