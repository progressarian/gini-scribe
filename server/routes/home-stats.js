import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { hasOwnPatientList } from "../../shared/permissions.js";

const router = Router();

const DOCTOR_MATCH = `(
  a.doctor_id = $2
  OR ($3 <> '' AND a.doctor_name ILIKE $3)
  OR ($4 <> '' AND a.doctor_name ILIKE $4)
)`;

router.get("/home-stats", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const doctorId = req.doctor?.doctor_id ?? null;

    const mine = hasOwnPatientList(req.doctor?.role) && !!doctorId;
    const where = `WHERE a.appointment_date = $1${mine ? ` AND ${DOCTOR_MATCH}` : ""}`;
    const params = mine
      ? [date, doctorId, req.doctor?.doctor_name || "", req.doctor?.short_name || ""]
      : [date];

    const r = await pool.query(
      `SELECT COUNT(*)::int                                                 AS total,
              COUNT(*) FILTER (WHERE a.status = 'completed')::int           AS seen,
              COUNT(*) FILTER (WHERE a.status = 'checkedin')::int           AS waiting,
              COUNT(*) FILTER (WHERE a.status = 'scheduled')::int           AS upcoming,
              COUNT(*) FILTER (WHERE a.status = 'no_show')::int             AS no_show,
              COUNT(*) FILTER (WHERE a.status = 'cancelled')::int           AS cancelled
         FROM appointments a ${where}`,
      params,
    );

    res.json({
      date,
      scope: mine ? "mine" : "all",
      doctor: mine ? req.doctor?.short_name || req.doctor?.doctor_name || null : null,
      stats: r.rows[0] || {},
    });
  } catch (e) {
    handleError(res, e, "Home stats");
  }
});

export default router;
