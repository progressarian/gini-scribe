import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/cancellations
router.get("/cancellations", async (req, res) => {
  try {
    const { from_date, to_date, cancel_type, doctor, page = 1, limit = 50 } = req.query;
    const off = (Math.max(1, +page) - 1) * Math.min(100, +limit);
    const params = [];
    const conds = [];

    if (from_date) {
      params.push(from_date);
      conds.push(`appointment_date>=$${params.length}`);
    }
    if (to_date) {
      params.push(to_date);
      conds.push(`appointment_date<=$${params.length}`);
    }
    if (cancel_type) {
      params.push(cancel_type);
      conds.push(`cancel_type=$${params.length}`);
    }
    if (doctor) {
      params.push(`%${doctor}%`);
      conds.push(`doctor_name ILIKE $${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [cntR, datR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM appointment_cancellations ${where}`, params),
      pool.query(
        `SELECT * FROM appointment_cancellations ${where}
         ORDER BY appointment_date DESC, created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Math.min(100, +limit), off],
      ),
    ]);
    res.json({ data: datR.rows, total: cntR.rows[0]?.total || 0, page: +page, limit: +limit });
  } catch (e) {
    handleError(res, e, "Cancellations list");
  }
});

// POST /api/cancellations
router.post("/cancellations", async (req, res) => {
  try {
    const fields = [
      "original_appointment_id",
      "cancel_type",
      "reason",
      "appointment_date",
      "appointment_time",
      "file_no",
      "patient_name",
      "mobile",
      "address",
      "doctor_name",
      "condition",
      "booking_date",
      "appointment_type",
      "visit_type",
      "visit_number",
      "booked_by",
      "comments",
      "outcome",
      "requested_by_cc",
      "cc_remark_date",
      "rescheduled_to_date",
      "rescheduled_to_time",
      "whatsapp_message",
      "week_num",
      "month_num",
    ];
    const vals = fields.map((f) => req.body[f] ?? null);
    const cols = fields.join(",");
    const phs = fields.map((_, i) => `$${i + 1}`).join(",");

    // Also update the original appointment status if id provided
    if (req.body.original_appointment_id) {
      const newStatus = req.body.cancel_type === "No Show" ? "no_show" : "cancelled";
      await pool.query("UPDATE appointments SET status=$1, show_no_show=$2 WHERE id=$3", [
        newStatus,
        req.body.cancel_type,
        req.body.original_appointment_id,
      ]);
    }

    const r = await pool.query(
      `INSERT INTO appointment_cancellations (${cols}) VALUES (${phs}) RETURNING *`,
      vals,
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Cancellation create");
  }
});

// GET /api/cancellations/:id
router.get("/cancellations/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM appointment_cancellations WHERE id=$1", [
      req.params.id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Cancellation get");
  }
});

export default router;
