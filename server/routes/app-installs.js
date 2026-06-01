import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// GET /api/app-installs
router.get("/app-installs", async (req, res) => {
  try {
    const { installed, cc, page = 1, limit = 50 } = req.query;
    const off = (Math.max(1, +page) - 1) * Math.min(100, +limit);
    const conds = [];
    const params = [];
    if (installed !== undefined) {
      params.push(installed === "true");
      conds.push(`app_installed=$${params.length}`);
    }
    if (cc) {
      params.push(cc);
      conds.push(`registered_by_cc=$${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const [cntR, datR] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS total FROM app_install_tracking ${where}`, params),
      pool.query(
        `SELECT * FROM app_install_tracking ${where}
         ORDER BY updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, Math.min(100, +limit), off],
      ),
    ]);
    res.json({ data: datR.rows, total: cntR.rows[0]?.total || 0, page: +page, limit: +limit });
  } catch (e) {
    handleError(res, e, "App installs list");
  }
});

// POST /api/app-installs — upsert by file_no
router.post("/app-installs", async (req, res) => {
  try {
    const {
      patient_id,
      file_no,
      patient_name,
      app_installed,
      profile_created,
      install_date,
      registered_by_cc,
      notes,
    } = req.body;
    const r = await pool.query(
      `INSERT INTO app_install_tracking
       (patient_id,file_no,patient_name,app_installed,profile_created,install_date,registered_by_cc,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (file_no) DO UPDATE SET
         app_installed=EXCLUDED.app_installed,
         profile_created=EXCLUDED.profile_created,
         install_date=COALESCE(EXCLUDED.install_date, app_install_tracking.install_date),
         registered_by_cc=COALESCE(EXCLUDED.registered_by_cc, app_install_tracking.registered_by_cc),
         notes=COALESCE(EXCLUDED.notes, app_install_tracking.notes),
         updated_at=NOW()
       RETURNING *`,
      [
        patient_id,
        file_no,
        patient_name,
        app_installed || false,
        profile_created || false,
        install_date,
        registered_by_cc,
        notes,
      ],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "App install upsert");
  }
});

// PATCH /api/app-installs/:id
router.patch("/app-installs/:id", async (req, res) => {
  try {
    const { app_installed, profile_created, install_date, registered_by_cc, notes } = req.body;
    const r = await pool.query(
      `UPDATE app_install_tracking
       SET app_installed=COALESCE($1,app_installed),
           profile_created=COALESCE($2,profile_created),
           install_date=COALESCE($3,install_date),
           registered_by_cc=COALESCE($4,registered_by_cc),
           notes=COALESCE($5,notes),
           updated_at=NOW()
       WHERE id=$6 RETURNING *`,
      [app_installed, profile_created, install_date, registered_by_cc, notes, req.params.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (e) {
    handleError(res, e, "App install update");
  }
});

export default router;
