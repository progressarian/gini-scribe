import { Router } from "express";
import pool from "../config/db.js";
import { n, num } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { getCanonical } from "../utils/labCanonical.js";
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
    const { test_name, result, unit, flag, ref_range, test_date, consultation_id, source } =
      req.body;
      function parseIndianDate(date) {
  if (!date) return null;

  // Already ISO
  if (date.includes("-")) return date;

  const parts = date.split("/");

  if (parts.length === 3) {
    let [day, month, year] = parts;

    if (year.length === 2) year = "20" + year;

    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  return date;
}

    const numericResult = num(result);
    const resultText = numericResult === null && result ? String(result) : null;
    const r = await pool.query(
      `INSERT INTO lab_results (patient_id, consultation_id, test_name, canonical_name, result, result_text, unit, flag, ref_range, test_date, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        req.params.id,
        n(consultation_id),
        test_name,
        getCanonical(test_name),
        numericResult,
        resultText,
        n(unit),
        n(flag) || "N",
        n(ref_range),
       parseIndianDate(test_date) || new Date().toISOString().split("T")[0],

        (source || "lab").slice(0, 50),
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
