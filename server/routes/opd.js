import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";

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
    ADD COLUMN IF NOT EXISTS consultation_id INTEGER,
    ADD COLUMN IF NOT EXISTS checked_in_at  TIMESTAMPTZ;

  ALTER TABLE lab_results  ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
  ALTER TABLE vitals       ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS opd_medications JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS opd_diagnoses JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS opd_stopped_medications JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS healthray_investigations JSONB DEFAULT '[]'::jsonb;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS healthray_follow_up JSONB;
  ALTER TABLE appointments ADD COLUMN IF NOT EXISTS healthray_clinical_notes TEXT;
  ALTER TABLE medications  ADD COLUMN IF NOT EXISTS appointment_id INTEGER;
  ALTER TABLE medications  ADD COLUMN IF NOT EXISTS source TEXT;
`,
  )
  .then(() => {
    console.log("✅ OPD columns ready");
    // Backfill existing OPD consultations with prescription data from documents
    backfillOpdConsultations().catch((e) => console.log("OPD backfill:", e.message));
    // One-time patch: copy weight/waist/BP from opd_vitals into biomarkers for Labs tab
    pool
      .query(
        `
      UPDATE appointments
      SET biomarkers = biomarkers
        || CASE WHEN opd_vitals->>'weight' IS NOT NULL THEN jsonb_build_object('weight', (opd_vitals->>'weight')::numeric) ELSE '{}'::jsonb END
        || CASE WHEN opd_vitals->>'waist' IS NOT NULL THEN jsonb_build_object('waist', (opd_vitals->>'waist')::numeric) ELSE '{}'::jsonb END
        || CASE WHEN opd_vitals->>'bpSys' IS NOT NULL THEN jsonb_build_object('bpSys', (opd_vitals->>'bpSys')::numeric) ELSE '{}'::jsonb END
        || CASE WHEN opd_vitals->>'bpDia' IS NOT NULL THEN jsonb_build_object('bpDia', (opd_vitals->>'bpDia')::numeric) ELSE '{}'::jsonb END
      WHERE healthray_id IS NOT NULL
        AND opd_vitals != '{}'::jsonb
        AND (biomarkers->>'weight' IS NULL OR biomarkers->>'waist' IS NULL OR biomarkers->>'bpSys' IS NULL)
    `,
      )
      .then((r) => {
        if (r.rowCount > 0)
          console.log(`✅ Patched ${r.rowCount} appointments: vitals → biomarkers`);
      })
      .catch(() => {});
  })
  .catch((e) => console.log("OPD migration:", e.message));

async function backfillOpdConsultations() {
  // Find OPD consultations with empty con_transcript
  const { rows: emptyOpdVisits } = await pool.query(
    `SELECT c.id, c.patient_id, c.visit_date, c.con_name, c.mo_data, c.con_data
     FROM consultations c
     WHERE c.visit_type = 'OPD'
       AND (c.con_transcript IS NULL OR c.con_transcript = '')`,
  );
  if (!emptyOpdVisits.length) return;
  console.log(`🔄 Backfilling ${emptyOpdVisits.length} OPD consultations...`);

  for (const con of emptyOpdVisits) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Get prescription documents for this patient
      const { rows: rxDocs } = await client.query(
        `SELECT extracted_data FROM documents
         WHERE patient_id = $1 AND source = 'opd_upload' AND doc_type = 'prescription'
           AND extracted_data IS NOT NULL
         ORDER BY doc_date DESC NULLS LAST, created_at DESC`,
        [con.patient_id],
      );

      // Build transcript from prescription documents
      const transcriptParts = [];
      const allDiags = [];
      const allMeds = [];
      const allStopped = [];

      for (const doc of rxDocs) {
        const rx = doc.extracted_data || {};
        const parts = [];
        if (rx.diagnoses?.length) {
          parts.push(
            "DIAGNOSIS:\n" +
              rx.diagnoses.map((d) => `${d.label}${d.status ? ` (${d.status})` : ""}`).join("\n"),
          );
          for (const d of rx.diagnoses) {
            if (d.id) allDiags.push(d);
          }
        }
        if (rx.medications?.length) {
          parts.push(
            "TREATMENT:\n" +
              rx.medications
                .map(
                  (m) =>
                    `-${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.timing ? " " + m.timing : ""}`,
                )
                .join("\n"),
          );
          allMeds.push(...rx.medications);
        }
        if (rx.stopped_medications?.length) {
          parts.push(
            "STOPPED:\n" +
              rx.stopped_medications
                .map((m) => `-${m.name}${m.reason ? " (" + m.reason + ")" : ""}`)
                .join("\n"),
          );
          allStopped.push(...rx.stopped_medications);
        }
        if (rx.advice?.length) parts.push("ADVICE:\n" + rx.advice.join("\n"));
        if (rx.follow_up) parts.push("FOLLOW UP: " + rx.follow_up);
        if (rx.doctor_name)
          transcriptParts.push(
            `Rx by ${rx.doctor_name}${rx.visit_date ? " on " + rx.visit_date : ""}:`,
          );
        if (parts.length) transcriptParts.push(parts.join("\n\n"));
        transcriptParts.push("");
      }

      // Add biomarker/compliance notes from consultation data
      const conDataBio = (con.con_data || {}).biomarkers || {};
      const comp = (con.mo_data || {}).compliance || con.mo_data || {};
      const bioLabels = {
        hba1c: "HbA1c",
        fg: "FPG",
        bpSys: "BP Sys",
        ldl: "LDL",
        tg: "TG",
        uacr: "UACR",
        weight: "Weight",
        creatinine: "Creatinine",
        tsh: "TSH",
        hb: "Hb",
      };
      const bioLines = [];
      for (const [k, v] of Object.entries(conDataBio)) {
        if (v != null && v !== "" && bioLabels[k]) bioLines.push(`${bioLabels[k]}: ${v}`);
      }
      if (bioLines.length) transcriptParts.push("BIOMARKERS:\n" + bioLines.join("\n"));

      const conTranscript = transcriptParts.filter(Boolean).join("\n\n");
      if (!conTranscript && !allDiags.length && !allMeds.length) {
        await client.query("ROLLBACK");
        continue;
      }

      // Deduplicate diagnoses
      const diagMap = {};
      for (const d of allDiags) {
        if (d?.id) diagMap[d.id] = d;
      }
      const mergedDiags = Object.values(diagMap);

      // Update consultation with prescription data
      const moData = con.mo_data || {};
      moData.diagnoses = mergedDiags;
      moData.previous_medications = allMeds;
      moData.stopped_medications = allStopped;
      moData.chief_complaints = mergedDiags.map((d) => d.label);

      const conData = con.con_data || {};
      conData.medications_confirmed = allMeds;

      await client.query(
        `UPDATE consultations
         SET mo_data = $2::jsonb, con_data = $3::jsonb, con_transcript = $4
         WHERE id = $1`,
        [con.id, JSON.stringify(moData), JSON.stringify(conData), conTranscript || null],
      );

      // Insert diagnoses
      for (const d of mergedDiags) {
        if (!d?.id || !d?.label) continue;
        await client.query(
          `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
             SET label = EXCLUDED.label, status = EXCLUDED.status, consultation_id = EXCLUDED.consultation_id`,
          [con.patient_id, con.id, d.id, d.label, d.status || "Controlled"],
        );
      }

      // Link documents
      await client.query(
        `UPDATE documents SET consultation_id = $1
         WHERE patient_id = $2 AND source = 'opd_upload' AND consultation_id IS NULL`,
        [con.id, con.patient_id],
      );

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.log(`  Backfill err con ${con.id}:`, e.message);
    } finally {
      client.release();
    }
  }
  console.log("✅ OPD backfill complete");
}

// ── Lab test mapping: OPD biomarker keys → lab_results fields ────────────────
// canonical values match getCanonical() output (proper case) for consistency
const LAB_MAP = {
  hba1c: { test_name: "HbA1c", panel: "Diabetes", unit: "%", canonical: "HbA1c" },
  fg: { test_name: "Fasting Glucose", panel: "Diabetes", unit: "mg/dL", canonical: "FBS" },
  ldl: { test_name: "LDL", panel: "Lipid Profile", unit: "mg/dL", canonical: "LDL" },
  tg: {
    test_name: "Triglycerides",
    panel: "Lipid Profile",
    unit: "mg/dL",
    canonical: "Triglycerides",
  },
  uacr: { test_name: "UACR", panel: "Renal", unit: "mg/g", canonical: "UACR" },
  creatinine: { test_name: "Creatinine", panel: "Renal", unit: "mg/dL", canonical: "Creatinine" },
  tsh: { test_name: "TSH", panel: "Thyroid", unit: "mIU/L", canonical: "TSH" },
  hb: { test_name: "Hemoglobin", panel: "CBC", unit: "g/dL", canonical: "Haemoglobin" },
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
                (SELECT COUNT(*) FROM consultations c
                  WHERE c.patient_id = a.patient_id
                    AND a.patient_id IS NOT NULL)
                +
                (SELECT COUNT(*) FROM appointments a2
                  WHERE a2.patient_id = a.patient_id
                    AND a2.patient_id IS NOT NULL
                    AND a2.appointment_date <= a.appointment_date
                    AND COALESCE(a2.status, 'scheduled') NOT IN ('cancelled', 'no_show')),
                a.visit_count, 1
              )::INTEGER AS visit_count,
              (SELECT MAX(a3.appointment_date) FROM appointments a3
                WHERE a3.patient_id = a.patient_id
                  AND a3.patient_id IS NOT NULL
                  AND a3.appointment_date < a.appointment_date
              ) AS last_visit_date,
              COALESCE(
                NULLIF(a.healthray_diagnoses, '[]'::jsonb),
                (SELECT a4.healthray_diagnoses FROM appointments a4
                  WHERE a4.patient_id = a.patient_id
                    AND a4.patient_id IS NOT NULL
                    AND a4.healthray_diagnoses IS NOT NULL
                    AND jsonb_array_length(a4.healthray_diagnoses) > 0
                  ORDER BY a4.appointment_date DESC LIMIT 1)
              ) AS healthray_diagnoses
         FROM appointments a
         LEFT JOIN patients p ON p.id = a.patient_id
        WHERE a.appointment_date = $1
        ORDER BY a.time_slot DESC NULLS LAST, a.created_at DESC`,
      [date],
    );
    // Apply clinical sort to HealthRay diagnoses on each row
    for (const r of rows) {
      if (Array.isArray(r.healthray_diagnoses) && r.healthray_diagnoses.length > 0) {
        r.healthray_diagnoses = sortDiagnoses(r.healthray_diagnoses);
      }
    }
    res.json(rows);
  } catch (e) {
    handleError(res, e, "OPD appointments list");
  }
});

// ── GET /api/opd/patient-docs/:patientId — OPD-uploaded documents ────────────
router.get("/opd/patient-docs/:patientId", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, doc_type, title, file_name, doc_date, source, notes, storage_path, extracted_data, created_at
         FROM documents
        WHERE patient_id = $1 AND source IN ('opd_upload', 'healthray')
        ORDER BY created_at DESC`,
      [req.params.patientId],
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "OPD patient docs");
  }
});

// ── PATCH /api/appointments/:id/status — direct status update, no side effects ──
router.patch("/appointments/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid appointment ID" });
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "status is required" });

  const allowed = ["scheduled", "checkedin", "in_visit", "seen", "cancelled", "no_show"];
  if (!allowed.includes(status))
    return res.status(400).json({ error: `status must be one of: ${allowed.join(", ")}` });

  try {
    const { rows } = await pool.query(
      `UPDATE appointments SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Appointment not found" });
    res.json(rows[0]);
  } catch (e) {
    handleError(res, e, "Update appointment status");
  }
});

// ── POST /api/appointments/:id/resync-condata — patch con_data on existing consultation ──
router.post("/appointments/:id/resync-condata", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid appointment ID" });

  try {
    const { rows } = await pool.query(
      `SELECT consultation_id, healthray_investigations, healthray_follow_up, compliance
       FROM appointments WHERE id = $1`,
      [id],
    );
    if (!rows[0]) return res.status(404).json({ error: "Appointment not found" });

    const appt = rows[0];
    if (!appt.consultation_id)
      return res.status(400).json({ error: "No consultation linked — mark visit as seen first" });

    const inv = (appt.healthray_investigations || []).map((t) =>
      typeof t === "string"
        ? { name: t, urgency: "routine" }
        : { name: t.name || String(t), urgency: t.urgency || "routine" },
    );
    const followUp = appt.healthray_follow_up || null;
    const c = appt.compliance || {};
    const dietLifestyle = [c.diet, c.exercise, c.stress].filter(Boolean);

    // Merge into existing con_data (preserve other fields)
    await pool.query(
      `UPDATE consultations
       SET con_data = con_data ||
         jsonb_build_object(
           'investigations_to_order', $1::jsonb,
           'follow_up', $2::jsonb,
           'diet_lifestyle', $3::jsonb
         ),
         updated_at = NOW()
       WHERE id = $4`,
      [
        JSON.stringify(inv),
        followUp ? JSON.stringify(followUp) : "null",
        JSON.stringify(dietLifestyle),
        appt.consultation_id,
      ],
    );

    res.json({
      success: true,
      consultationId: appt.consultation_id,
      investigations: inv,
      followUp,
      dietLifestyle,
    });
  } catch (e) {
    handleError(res, e, "Resync con_data");
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
          SET status        = COALESCE($2, status),
              category      = COALESCE($3, category),
              doctor_name   = COALESCE($4, doctor_name),
              checked_in_at = CASE
                                WHEN $2 = 'checkedin' AND checked_in_at IS NULL THEN NOW()
                                ELSE checked_in_at
                              END,
              updated_at    = NOW()
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

      // Read current truth from tables (not stale JSONB on appointment)
      const liveMedsR = await client.query(
        `SELECT name, dose, frequency, timing, route, is_active FROM medications
         WHERE patient_id = $1 AND is_active = true ORDER BY created_at DESC`,
        [appt.patient_id],
      );
      const liveStoppedR = await client.query(
        `SELECT name, dose, stop_reason FROM medications
         WHERE patient_id = $1 AND is_active = false AND stopped_date >= CURRENT_DATE - INTERVAL '30 days'
         ORDER BY stopped_date DESC`,
        [appt.patient_id],
      );
      const liveDiagsR = await client.query(
        `SELECT diagnosis_id AS id, label, status FROM diagnoses
         WHERE patient_id = $1 AND is_active != false ORDER BY created_at DESC`,
        [appt.patient_id],
      );
      const opdMeds = liveMedsR.rows;
      const opdDiags = liveDiagsR.rows;
      const opdStopped = liveStoppedR.rows;

      // Build con_transcript from OPD prescription documents for "View Prescription"
      const rxDocs = await client.query(
        `SELECT extracted_data FROM documents
         WHERE patient_id = $1 AND source = 'opd_upload' AND doc_type = 'prescription'
           AND extracted_data IS NOT NULL
         ORDER BY doc_date DESC NULLS LAST, created_at DESC`,
        [appt.patient_id],
      );
      const transcriptParts = [];
      for (const doc of rxDocs.rows) {
        const rx = doc.extracted_data || {};
        const parts = [];
        if (rx.diagnoses?.length)
          parts.push(
            "DIAGNOSIS:\n" +
              rx.diagnoses.map((d) => `${d.label}${d.status ? ` (${d.status})` : ""}`).join("\n"),
          );
        if (rx.medications?.length) {
          parts.push(
            "TREATMENT:\n" +
              rx.medications
                .map(
                  (m) =>
                    `-${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.timing ? " " + m.timing : ""}`,
                )
                .join("\n"),
          );
        }
        if (rx.stopped_medications?.length)
          parts.push(
            "STOPPED:\n" +
              rx.stopped_medications
                .map((m) => `-${m.name}${m.reason ? " (" + m.reason + ")" : ""}`)
                .join("\n"),
          );
        if (rx.advice?.length) parts.push("ADVICE:\n" + rx.advice.join("\n"));
        if (rx.follow_up) parts.push("FOLLOW UP: " + rx.follow_up);
        if (rx.doctor_name)
          transcriptParts.push(
            `Rx by ${rx.doctor_name}${rx.visit_date ? " on " + rx.visit_date : ""}:`,
          );
        if (parts.length) transcriptParts.push(parts.join("\n\n"));
        transcriptParts.push(""); // blank line between prescriptions
      }
      // Add biomarker notes
      if (Object.keys(biomarkers).length > 0) {
        const bioLines = [];
        const bioLabels = {
          hba1c: "HbA1c",
          fg: "FPG",
          bpSys: "BP Sys",
          bpDia: "BP Dia",
          ldl: "LDL",
          tg: "TG",
          uacr: "UACR",
          weight: "Weight",
          waist: "Waist",
          creatinine: "Creatinine",
          tsh: "TSH",
          hb: "Hb",
        };
        for (const [k, v] of Object.entries(biomarkers)) {
          if (v != null && v !== "" && bioLabels[k]) bioLines.push(`${bioLabels[k]}: ${v}`);
        }
        if (bioLines.length) transcriptParts.push("BIOMARKERS:\n" + bioLines.join("\n"));
      }
      if (notes.length) transcriptParts.push("COMPLIANCE:\n" + notes.join("\n"));
      const conTranscript = transcriptParts.filter(Boolean).join("\n\n");

      const conRes = await client.query(
        `INSERT INTO consultations
           (patient_id, visit_date, visit_type, con_name, status, mo_data, con_data, con_transcript)
         VALUES ($1, $2, 'OPD', $3, 'completed', $4, $5, $6)
         RETURNING id`,
        [
          appt.patient_id,
          appt.appointment_date,
          appt.doctor_name || null,
          JSON.stringify({
            compliance,
            coordinator_notes: appt.coordinator_notes || [],
            category: appt.category,
            diagnoses: opdDiags,
            previous_medications: opdMeds,
            stopped_medications: opdStopped,
            chief_complaints: opdDiags.map((d) => d.label),
          }),
          JSON.stringify({
            biomarkers,
            opd_notes: notes.join("\n"),
            medications_confirmed: opdMeds,
            investigations_to_order: (() => {
              const inv = appt.healthray_investigations || [];
              return inv.map((t) =>
                typeof t === "string"
                  ? { name: t, urgency: "routine" }
                  : { name: t.name || t.test || String(t), urgency: t.urgency || "routine" },
              );
            })(),
            diet_lifestyle: (() => {
              const c = appt.compliance || {};
              const lines = [];
              if (c.diet) lines.push(c.diet);
              if (c.exercise) lines.push(c.exercise);
              if (c.stress) lines.push(c.stress);
              return lines;
            })(),
            follow_up: appt.healthray_follow_up || null,
          }),
          conTranscript || null,
        ],
      );
      const consultationId = conRes.rows[0].id;

      // ── Link all patient records to this consultation ──
      // Tables are the single source of truth — OPD prep AND visit page both write
      // directly to them, so we just link (don't re-insert from stale JSONB).

      // Link diagnoses that don't have a consultation yet
      await client.query(
        `UPDATE diagnoses SET consultation_id = $1
         WHERE patient_id = $2 AND (consultation_id IS NULL OR consultation_id = $1)`,
        [consultationId, appt.patient_id],
      );

      // Link lab_results, vitals, medications by appointment_id
      await client.query(`UPDATE lab_results SET consultation_id = $1 WHERE appointment_id = $2`, [
        consultationId,
        appt.id,
      ]);
      await client.query(`UPDATE vitals SET consultation_id = $1 WHERE appointment_id = $2`, [
        consultationId,
        appt.id,
      ]);
      await client.query(`UPDATE medications SET consultation_id = $1 WHERE appointment_id = $2`, [
        consultationId,
        appt.id,
      ]);
      // Also link medications that were edited during the visit (may not have appointment_id)
      await client.query(
        `UPDATE medications SET consultation_id = $1
         WHERE patient_id = $2 AND is_active = true AND consultation_id IS NULL`,
        [consultationId, appt.patient_id],
      );

      // Link OPD documents to this consultation
      await client.query(
        `UPDATE documents SET consultation_id = $1 WHERE patient_id = $2 AND source = 'opd_upload' AND consultation_id IS NULL`,
        [consultationId, appt.patient_id],
      );
      // Also link documents uploaded during the visit
      await client.query(
        `UPDATE documents SET consultation_id = $1
         WHERE patient_id = $2 AND consultation_id IS NULL AND created_at > $3`,
        [consultationId, appt.patient_id, appt.checked_in_at || appt.created_at],
      );

      // Store consultation_id on the appointment AND sync live table data back to JSONB
      // so OPD page always shows current state (not stale prep data)
      await client.query(
        `UPDATE appointments SET
           consultation_id = $1,
           opd_medications = $2::jsonb,
           opd_diagnoses = $3::jsonb,
           opd_stopped_medications = $4::jsonb
         WHERE id = $5`,
        [
          consultationId,
          JSON.stringify(opdMeds),
          JSON.stringify(opdDiags),
          JSON.stringify(opdStopped),
          appt.id,
        ],
      );
      appt.consultation_id = consultationId;
      appt.opd_medications = opdMeds;
      appt.opd_diagnoses = opdDiags;
      appt.opd_stopped_medications = opdStopped;
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { medications, diagnoses, stopped_medications, ...complianceData } = req.body;

    const { rows } = await client.query(
      `UPDATE appointments
          SET compliance = $2::jsonb,
              opd_medications = $3::jsonb,
              opd_diagnoses = $4::jsonb,
              opd_stopped_medications = $5::jsonb,
              prep_steps = prep_steps || '{"compliance":true}'::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        req.params.id,
        JSON.stringify(complianceData),
        JSON.stringify(medications || []),
        JSON.stringify(diagnoses || []),
        JSON.stringify(stopped_medications || []),
      ],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const appt = rows[0];

    // ── Sync extracted medicines to medications table if patient exists ──
    if (appt.patient_id) {
      // Remove previous OPD medication entries for this appointment
      await client.query(
        `DELETE FROM medications WHERE patient_id = $1 AND source = 'opd'
           AND appointment_id = $2`,
        [appt.patient_id, appt.id],
      );

      // Insert active medicines (upsert — update if same drug already active)
      for (const m of medications || []) {
        if (!m?.name) continue;
        await client.query(
          `INSERT INTO medications
             (patient_id, appointment_id, name, composition, dose, frequency, timing, route, is_new, is_active, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true, 'opd')
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
           DO UPDATE SET appointment_id = EXCLUDED.appointment_id,
             composition = COALESCE(EXCLUDED.composition, medications.composition),
             dose = COALESCE(EXCLUDED.dose, medications.dose),
             frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
             timing = COALESCE(EXCLUDED.timing, medications.timing),
             route = COALESCE(EXCLUDED.route, medications.route),
             source = EXCLUDED.source,
             updated_at = NOW()`,
          [
            appt.patient_id,
            appt.id,
            (m.name || "").slice(0, 200),
            (m.composition || "").slice(0, 200),
            (m.dose || "").slice(0, 100),
            (m.frequency || "").slice(0, 100),
            (m.timing || "").slice(0, 100),
            (m.route || "Oral").slice(0, 50),
          ],
        );
      }

      // Insert stopped/omitted medicines as inactive
      for (const m of stopped_medications || []) {
        if (!m?.name) continue;
        await client.query(
          `INSERT INTO medications
             (patient_id, appointment_id, name, dose, is_new, is_active, source)
           VALUES ($1, $2, $3, $4, false, false, 'opd')
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
           DO UPDATE SET appointment_id = EXCLUDED.appointment_id,
             dose = COALESCE(EXCLUDED.dose, medications.dose),
             source = EXCLUDED.source,
             updated_at = NOW()`,
          [appt.patient_id, appt.id, (m.name || "").slice(0, 200), (m.reason || "").slice(0, 100)],
        );
      }

      // ── Sync diagnoses to diagnoses table ──
      if (Array.isArray(diagnoses) && diagnoses.length > 0) {
        for (const d of diagnoses) {
          if (!d?.id || !d?.label) continue;
          await client.query(
            `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
               SET label = EXCLUDED.label,
                   status = EXCLUDED.status`,
            [appt.patient_id, d.id, d.label, d.status || "Controlled"],
          );
        }
      }
    }

    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Compliance post");
  } finally {
    client.release();
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

// ── POST /api/opd/backfill — manually trigger backfill of OPD consultations ──
router.post("/opd/backfill", async (req, res) => {
  try {
    await backfillOpdConsultations();
    res.json({ success: true });
  } catch (e) {
    console.error("OPD backfill error:", e);
    res.status(500).json({ error: e.message });
  }
});

export default router;
