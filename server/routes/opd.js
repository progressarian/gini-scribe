import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// ── DB migration: ensure OPD columns exist ───────────────────────────────────
pool.query(`
  ALTER TABLE appointments
    ADD COLUMN IF NOT EXISTS prep_steps     JSONB DEFAULT '{"biomarkers":false,"compliance":false,"categorized":false,"assigned":false}'::jsonb,
    ADD COLUMN IF NOT EXISTS biomarkers     JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS compliance     JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS category       TEXT,
    ADD COLUMN IF NOT EXISTS coordinator_notes JSONB DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS opd_vitals     JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS is_walkin      BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS age            INTEGER,
    ADD COLUMN IF NOT EXISTS sex            TEXT,
    ADD COLUMN IF NOT EXISTS visit_count    INTEGER DEFAULT 1,
    ADD COLUMN IF NOT EXISTS last_visit_date DATE
`).then(() => console.log("✅ OPD columns ready")).catch(e => console.log("OPD migration:", e.message));

// ── GET /api/appointments — OPD list (flat array, by date) ───────────────────
// The existing appointments route returns paginated { data, page, total }.
// OPD needs a flat array. We keep this as a separate query scoped to OPD fields.
router.get("/opd/appointments", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const { rows } = await pool.query(
      `SELECT a.*,
              COALESCE(a.age, p.age)  AS age,
              COALESCE(a.sex, p.sex)  AS sex
         FROM appointments a
         LEFT JOIN patients p ON p.id = a.patient_id
        WHERE a.appointment_date = $1
        ORDER BY a.time_slot ASC NULLS LAST, a.created_at ASC`,
      [date]
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "OPD appointments list");
  }
});

// ── PATCH /api/appointments/:id — status / category / doctor ─────────────────
router.patch("/appointments/:id", async (req, res) => {
  try {
    const { status, category, doctor_name } = req.body;
    const { rows } = await pool.query(
      `UPDATE appointments
          SET status      = COALESCE($2, status),
              category    = COALESCE($3, category),
              doctor_name = COALESCE($4, doctor_name),
              updated_at  = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, status || null, category || null, doctor_name || null]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Appointment patch");
  }
});

// ── PATCH /api/appointments/:id/prep — toggle a prep step ────────────────────
router.patch("/appointments/:id/prep", async (req, res) => {
  try {
    const { step, value = true } = req.body;
    const { rows } = await pool.query(
      `UPDATE appointments
          SET prep_steps = prep_steps || jsonb_build_object($2::text, $3::boolean),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, step, value]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Prep step patch");
  }
});

// ── POST /api/appointments/:id/biomarkers ─────────────────────────────────────
router.post("/appointments/:id/biomarkers", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE appointments
          SET biomarkers = $2::jsonb,
              prep_steps = prep_steps || '{"biomarkers":true}'::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, JSON.stringify(req.body)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Biomarkers post");
  }
});

// ── POST /api/appointments/:id/compliance ─────────────────────────────────────
router.post("/appointments/:id/compliance", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE appointments
          SET compliance = $2::jsonb,
              prep_steps = prep_steps || '{"compliance":true}'::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, JSON.stringify(req.body)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Compliance post");
  }
});

// ── POST /api/appointments/:id/vitals ─────────────────────────────────────────
router.post("/appointments/:id/vitals", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE appointments
          SET opd_vitals = $2::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, JSON.stringify(req.body)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Vitals post");
  }
});

export default router;
