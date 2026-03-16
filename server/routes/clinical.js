import { Router } from "express";
import pool from "../config/db.js";
import { n, num } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { labCreateSchema } from "../schemas/index.js";

const router = Router();

// Get vitals
router.get("/patients/:id/vitals", async (req, res) => {
  try {
    res.json(
      (
        await pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [
          req.params.id,
        ])
      ).rows,
    );
  } catch (e) {
    handleError(res, e, "Vitals");
  }
});

// Get labs
router.get("/patients/:id/labs", async (req, res) => {
  try {
    const { test } = req.query;
    const q = test
      ? `SELECT DISTINCT ON (test_name, test_date) * FROM lab_results WHERE patient_id=$1 AND test_name=$2 ORDER BY test_name, test_date, created_at DESC`
      : `SELECT DISTINCT ON (test_name, test_date) * FROM lab_results WHERE patient_id=$1 ORDER BY test_name, test_date DESC, created_at DESC`;
    const params = test ? [req.params.id, test] : [req.params.id];
    res.json((await pool.query(q, params)).rows);
  } catch (e) {
    handleError(res, e, "Labs");
  }
});

// Save individual lab result
router.post("/patients/:id/labs", validate(labCreateSchema), async (req, res) => {
  try {
    const { test_name, result, unit, flag, ref_range, test_date, consultation_id } = req.body;
    const r = await pool.query(
      `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, ref_range, test_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        req.params.id,
        n(consultation_id),
        test_name,
        result,
        n(unit),
        n(flag) || "N",
        n(ref_range),
        n(test_date) || new Date().toISOString().split("T")[0],
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "Lab save");
  }
});

// Get medications
router.get("/patients/:id/medications", async (req, res) => {
  try {
    const { active } = req.query;
    const where = active === "true" ? "AND is_active=TRUE" : "";
    res.json(
      (
        await pool.query(
          `SELECT DISTINCT ON (UPPER(name)) * FROM medications WHERE patient_id=$1 ${where} ORDER BY UPPER(name), created_at DESC`,
          [req.params.id],
        )
      ).rows,
    );
  } catch (e) {
    handleError(res, e, "Medications");
  }
});

export default router;
