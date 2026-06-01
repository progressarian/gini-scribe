import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/diabetes-champions
router.get("/diabetes-champions", async (req, res) => {
  try {
    const { tagged_fb, page = 1, limit = 50 } = req.query;
    const off = (Math.max(1, +page) - 1) * Math.min(100, +limit);
    const conds = [];
    const params = [];
    if (tagged_fb !== undefined) {
      params.push(tagged_fb === "true");
      conds.push(`tagged_on_fb=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [cntR, datR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM diabetes_champions ${where}`, params),
      pool.query(
        `SELECT * FROM diabetes_champions ${where}
         ORDER BY creation_date DESC NULLS LAST, created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Math.min(100, +limit), off],
      ),
    ]);
    res.json({ data: datR.rows, total: cntR.rows[0]?.total || 0, page: +page, limit: +limit });
  } catch (e) {
    handleError(res, e, "Diabetes champions list");
  }
});

// POST /api/diabetes-champions
router.post("/diabetes-champions", async (req, res) => {
  try {
    const {
      creation_date,
      file_no,
      patient_id,
      patient_name,
      mobile,
      email,
      outcome,
      tagged_on_fb = false,
      comments,
    } = req.body;
    if (!patient_name) return res.status(400).json({ error: "patient_name required" });
    const r = await pool.query(
      `INSERT INTO diabetes_champions
       (creation_date,file_no,patient_id,patient_name,mobile,email,outcome,tagged_on_fb,comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        creation_date,
        file_no,
        patient_id,
        patient_name,
        mobile,
        email,
        outcome,
        tagged_on_fb,
        comments,
      ],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Diabetes champion create");
  }
});

// PATCH /api/diabetes-champions/:id
router.patch("/diabetes-champions/:id", async (req, res) => {
  try {
    const allowed = ["outcome", "tagged_on_fb", "comments", "mobile", "email", "creation_date"];
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
      `UPDATE diabetes_champions SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Diabetes champion update");
  }
});

// DELETE /api/diabetes-champions/:id
router.delete("/diabetes-champions/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM diabetes_champions WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    handleError(res, e, "Diabetes champion delete");
  }
});

export default router;
