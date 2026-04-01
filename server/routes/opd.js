import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";

const router = Router();

// ── DB migration: ensure OPD columns exist ───────────────────────────────────
pool
  .query(
    `
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
    ADD COLUMN IF NOT EXISTS last_visit_date DATE,
    ADD COLUMN IF NOT EXISTS consultation_id INTEGER;

  ALTER TABLE lab_results  ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
  ALTER TABLE vitals       ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
`,
  )
  .then(() => console.log("✅ OPD columns ready"))
  .catch((e) => console.log("OPD migration:", e.message));

// ── Lab test mapping: OPD biomarker keys → lab_results fields ────────────────
const LAB_MAP = {
  hba1c: { test_name: "HbA1c", panel: "Diabetes", unit: "%", canonical: "hba1c" },
  fg: {
    test_name: "Fasting Glucose",
    panel: "Diabetes",
    unit: "mg/dL",
    canonical: "fasting_glucose",
  },
  ldl: { test_name: "LDL", panel: "Lipid Profile", unit: "mg/dL", canonical: "ldl" },
  tg: {
    test_name: "Triglycerides",
    panel: "Lipid Profile",
    unit: "mg/dL",
    canonical: "triglycerides",
  },
  uacr: { test_name: "UACR", panel: "Renal", unit: "mg/g", canonical: "uacr" },
  creatinine: { test_name: "Creatinine", panel: "Renal", unit: "mg/dL", canonical: "creatinine" },
  tsh: { test_name: "TSH", panel: "Thyroid", unit: "mIU/L", canonical: "tsh" },
  hb: { test_name: "Hemoglobin", panel: "CBC", unit: "g/dL", canonical: "hemoglobin" },
};

const num = (v) => {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

// ── GET /api/opd/appointments — OPD list (flat array, by date) ───────────────
router.get("/opd/appointments", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];
    const { rows } = await pool.query(
      `SELECT a.*,
              COALESCE(a.age, EXTRACT(YEAR FROM AGE(p.dob))::INTEGER, p.age) AS age,
              COALESCE(a.sex, p.sex) AS sex,
              COALESCE(
                (SELECT COUNT(*) FROM appointments a2
                  WHERE a2.patient_id = a.patient_id
                    AND a2.patient_id IS NOT NULL
                    AND a2.appointment_date <= a.appointment_date),
                a.visit_count, 1
              )::INTEGER AS visit_count,
              (SELECT MAX(a3.appointment_date) FROM appointments a3
                WHERE a3.patient_id = a.patient_id
                  AND a3.patient_id IS NOT NULL
                  AND a3.appointment_date < a.appointment_date
              ) AS last_visit_date
         FROM appointments a
         LEFT JOIN patients p ON p.id = a.patient_id
        WHERE a.appointment_date = $1
        ORDER BY a.time_slot DESC NULLS LAST, a.created_at DESC`,
      [date],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "OPD appointments list");
  }
});

// ── GET /api/opd/patient-docs/:patientId — OPD-uploaded documents ────────────
router.get("/opd/patient-docs/:patientId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, doc_type, title, file_name, doc_date, source, notes, storage_path, created_at
         FROM documents
        WHERE patient_id = $1 AND source = 'opd_upload'
        ORDER BY created_at DESC`,
      [req.params.patientId],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "OPD patient docs");
  }
});

// ── PATCH /api/appointments/:id — status / category / doctor ─────────────────
// When status → "seen", creates a consultation and links all OPD data
router.patch("/appointments/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const { status, category, doctor_name } = req.body;
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE appointments
          SET status      = COALESCE($2, status),
              category    = COALESCE($3, category),
              doctor_name = COALESCE($4, doctor_name),
              updated_at  = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, status || null, category || null, doctor_name || null],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const appt = rows[0];

    // ── When marked "seen" → create consultation & link records ──
    if (status === "seen" && appt.patient_id && !appt.consultation_id) {
      const compliance = appt.compliance || {};
      const biomarkers = appt.biomarkers || {};
      const notes = [];
      if (compliance.diet) notes.push(`Diet: ${compliance.diet}`);
      if (compliance.exercise) notes.push(`Exercise: ${compliance.exercise}`);
      if (compliance.stress) notes.push(`Stress: ${compliance.stress}`);
      if (compliance.medPct != null) notes.push(`Med adherence: ${compliance.medPct}%`);
      if (compliance.missed) notes.push(`Missed: ${compliance.missed}`);
      if (compliance.notes) notes.push(`Notes: ${compliance.notes}`);

      const conRes = await client.query(
        `INSERT INTO consultations
           (patient_id, visit_date, visit_type, con_name, status, mo_data, con_data)
         VALUES ($1, $2, 'OPD', $3, 'completed', $4, $5)
         RETURNING id`,
        [
          appt.patient_id,
          appt.appointment_date,
          appt.doctor_name || null,
          JSON.stringify({
            compliance,
            coordinator_notes: appt.coordinator_notes || [],
            category: appt.category,
          }),
          JSON.stringify({
            biomarkers,
            opd_notes: notes.join("\n"),
          }),
        ],
      );
      const consultationId = conRes.rows[0].id;

      // Link lab_results and vitals to this consultation
      await client.query(`UPDATE lab_results SET consultation_id = $1 WHERE appointment_id = $2`, [
        consultationId,
        appt.id,
      ]);
      await client.query(`UPDATE vitals SET consultation_id = $1 WHERE appointment_id = $2`, [
        consultationId,
        appt.id,
      ]);

      // Store consultation_id on the appointment
      await client.query(`UPDATE appointments SET consultation_id = $1 WHERE id = $2`, [
        consultationId,
        appt.id,
      ]);
      appt.consultation_id = consultationId;
    }

    await client.query("COMMIT");
    res.json(appt);
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Appointment patch");
  } finally {
    client.release();
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
      [req.params.id, step, value],
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Prep step patch");
  }
});

// ── POST /api/appointments/:id/biomarkers ─────────────────────────────────────
// Saves to appointments.biomarkers AND syncs lab values to lab_results table
router.post("/appointments/:id/biomarkers", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE appointments
          SET biomarkers = $2::jsonb,
              prep_steps = prep_steps || '{"biomarkers":true}'::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, JSON.stringify(req.body)],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const appt = rows[0];

    // ── Sync to lab_results if patient exists ──
    if (appt.patient_id) {
      // Remove previous OPD lab entries for this appointment (handles re-save)
      await client.query(`DELETE FROM lab_results WHERE appointment_id = $1`, [appt.id]);

      const testDate = appt.appointment_date || new Date().toISOString().split("T")[0];

      for (const [key, meta] of Object.entries(LAB_MAP)) {
        const val = num(req.body[key]);
        if (val === null) continue;
        await client.query(
          `INSERT INTO lab_results
             (patient_id, appointment_id, test_date, panel_name, test_name, canonical_name, result, unit, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'opd')`,
          [
            appt.patient_id,
            appt.id,
            testDate,
            meta.panel,
            meta.test_name,
            meta.canonical,
            val,
            meta.unit,
          ],
        );
      }
    }

    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Biomarkers post");
  } finally {
    client.release();
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
      [req.params.id, JSON.stringify(req.body)],
    );
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Compliance post");
  }
});

// ── POST /api/appointments/:id/vitals ─────────────────────────────────────────
// Saves to appointments.opd_vitals AND syncs to vitals table
router.post("/appointments/:id/vitals", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `UPDATE appointments
          SET opd_vitals = $2::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [req.params.id, JSON.stringify(req.body)],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const appt = rows[0];
    const v = req.body;

    // ── Sync to vitals table if patient exists ──
    if (appt.patient_id && (num(v.bpSys) || num(v.weight))) {
      // Remove previous OPD vitals for this appointment (handles re-save)
      await client.query(`DELETE FROM vitals WHERE appointment_id = $1`, [appt.id]);

      await client.query(
        `INSERT INTO vitals
           (patient_id, appointment_id, recorded_at, bp_sys, bp_dia, pulse, spo2, weight, height, bmi, waist, body_fat, muscle_mass, rbs, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          appt.patient_id,
          appt.id,
          appt.appointment_date || new Date(),
          num(v.bpSys),
          num(v.bpDia),
          null, // pulse — not in OPD vitals form
          num(v.spo2),
          num(v.weight),
          num(v.height),
          num(v.bmi),
          num(v.waist),
          num(v.bodyFat),
          num(v.muscleMass),
          num(v.spotSugar),
          "OPD vitals",
        ],
      );
    }

    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Vitals post");
  } finally {
    client.release();
  }
});

export default router;
