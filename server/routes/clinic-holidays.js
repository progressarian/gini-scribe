import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/clinic-holidays?year=2026&month=6
router.get("/clinic-holidays", async (req, res) => {
  try {
    const { year, month, from_date, to_date } = req.query;
    const params = [];
    const conds = [];

    if (year && month) {
      params.push(`${year}-${String(month).padStart(2, "0")}-01`);
      params.push(`${year}-${String(month).padStart(2, "0")}-31`);
      conds.push(`holiday_date BETWEEN $${params.length - 1} AND $${params.length}`);
    } else if (from_date && to_date) {
      params.push(from_date);
      params.push(to_date);
      conds.push(`holiday_date BETWEEN $1 AND $2`);
    }

    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const r = await pool.query(
      `SELECT * FROM clinic_holidays ${where} ORDER BY holiday_date ASC`,
      params,
    );
    res.json(r.rows);
  } catch (e) {
    handleError(res, e, "Holidays list");
  }
});

// GET /api/clinic-holidays/check?date=2026-06-15 — is this date a holiday?
router.get("/clinic-holidays/check", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: "date required" });
    const r = await pool.query("SELECT * FROM clinic_holidays WHERE holiday_date=$1", [date]);
    res.json({ is_holiday: r.rows.length > 0, holiday: r.rows[0] || null });
  } catch (e) {
    handleError(res, e, "Holiday check");
  }
});

// POST /api/clinic-holidays
router.post("/clinic-holidays", async (req, res) => {
  try {
    const { holiday_date, remarks, created_by } = req.body;
    if (!holiday_date) return res.status(400).json({ error: "holiday_date required" });
    const r = await pool.query(
      `INSERT INTO clinic_holidays (holiday_date, remarks, created_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (holiday_date) DO UPDATE SET remarks=EXCLUDED.remarks
       RETURNING *`,
      [holiday_date, remarks, created_by || req.doctor?.name],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Holiday create");
  }
});

// DELETE /api/clinic-holidays/:id
router.delete("/clinic-holidays/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM clinic_holidays WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Holiday delete");
  }
});

export default router;
