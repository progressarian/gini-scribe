import express from "express";
import cors from "cors";
import pg from "pg";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false
});

// Convert empty strings to null for Postgres
const n = v => (v === "" || v === undefined || v === null) ? null : v;
const num = v => { const x = parseFloat(v); return isNaN(x) ? null : x; };
const int = v => { const x = parseInt(v); return isNaN(x) ? null : x; };

// Health check
app.get("/", (_, res) => res.json({ status: "ok", service: "gini-scribe-api" }));

// ============ PATIENTS ============

// Search patients
app.get("/api/patients", async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    let result;
    if (q) {
      result = await pool.query(
        `SELECT * FROM v_patient_summary WHERE
         name ILIKE $1 OR phone LIKE $2 OR file_no ILIKE $1 OR abha_id LIKE $2 OR health_id LIKE $2
         ORDER BY last_visit DESC NULLS LAST LIMIT $3`,
        [`%${q}%`, `%${q}%`, limit]
      );
    } else {
      result = await pool.query("SELECT * FROM v_patient_summary ORDER BY last_visit DESC NULLS LAST LIMIT $1", [limit]);
    }
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single patient with full history
app.get("/api/patients/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const patient = await pool.query("SELECT * FROM patients WHERE id=$1", [id]);
    if (!patient.rows[0]) return res.status(404).json({ error: "Not found" });

    const [consultations, vitals, meds, labs, diagnoses, docs, goals] = await Promise.all([
      pool.query("SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at FROM consultations WHERE patient_id=$1 ORDER BY visit_date DESC", [id]),
      pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [id]),
      pool.query("SELECT * FROM medications WHERE patient_id=$1 ORDER BY is_active DESC, created_at DESC", [id]),
      pool.query("SELECT * FROM lab_results WHERE patient_id=$1 ORDER BY test_date DESC", [id]),
      pool.query("SELECT * FROM diagnoses WHERE patient_id=$1 ORDER BY is_active DESC, created_at DESC", [id]),
      pool.query("SELECT id, doc_type, title, file_name, doc_date, source, created_at FROM documents WHERE patient_id=$1 ORDER BY doc_date DESC", [id]),
      pool.query("SELECT * FROM goals WHERE patient_id=$1 ORDER BY status, created_at DESC", [id]),
    ]);

    res.json({
      ...patient.rows[0],
      consultations: consultations.rows,
      vitals: vitals.rows,
      medications: meds.rows,
      lab_results: labs.rows,
      diagnoses: diagnoses.rows,
      documents: docs.rows,
      goals: goals.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create or find patient (upsert by phone or file_no)
app.post("/api/patients", async (req, res) => {
  try {
    const p = req.body;
    // Try to find existing
    let existing = null;
    if (p.phone) existing = (await pool.query("SELECT id FROM patients WHERE phone=$1", [p.phone])).rows[0];
    if (!existing && p.file_no) existing = (await pool.query("SELECT id FROM patients WHERE file_no=$1", [p.file_no])).rows[0];
    if (!existing && p.abha_id) existing = (await pool.query("SELECT id FROM patients WHERE abha_id=$1", [p.abha_id])).rows[0];

    if (existing) {
      // Update existing
      const result = await pool.query(
        `UPDATE patients SET name=COALESCE($2,name), dob=COALESCE($3,dob), age=COALESCE($4,age),
         sex=COALESCE($5,sex), file_no=COALESCE($6,file_no), abha_id=COALESCE($7,abha_id),
         health_id=COALESCE($8,health_id), aadhaar=COALESCE($9,aadhaar),
         govt_id=COALESCE($10,govt_id), govt_id_type=COALESCE($11,govt_id_type),
         email=COALESCE($12,email), phone=COALESCE($13,phone)
         WHERE id=$1 RETURNING *`,
        [existing.id, n(p.name), n(p.dob)||null, int(p.age), n(p.sex), n(p.file_no), n(p.abha_id), n(p.health_id), n(p.aadhaar), n(p.govt_id), n(p.govt_id_type), n(p.email), n(p.phone)]
      );
      res.json({ ...result.rows[0], _isNew: false });
    } else {
      // Create new
      const result = await pool.query(
        `INSERT INTO patients (name, phone, dob, age, sex, file_no, abha_id, health_id, aadhaar, govt_id, govt_id_type, email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [n(p.name), n(p.phone), n(p.dob)||null, int(p.age), n(p.sex), n(p.file_no), n(p.abha_id), n(p.health_id), n(p.aadhaar), n(p.govt_id), n(p.govt_id_type), n(p.email)]
      );
      res.json({ ...result.rows[0], _isNew: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ CONSULTATIONS ============

// Save full consultation (creates patient if needed, saves everything)
app.post("/api/consultations", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { patient, vitals, moData, conData, moTranscript, conTranscript, quickTranscript, moName, conName, planEdits } = req.body;

    // 1. Upsert patient
    let patientId;
    let existing = null;
    if (n(patient.phone)) existing = (await client.query("SELECT id FROM patients WHERE phone=$1", [patient.phone])).rows[0];
    if (!existing && n(patient.fileNo)) existing = (await client.query("SELECT id FROM patients WHERE file_no=$1", [patient.fileNo])).rows[0];

    if (existing) {
      patientId = existing.id;
      await client.query(
        "UPDATE patients SET name=COALESCE($2,name), age=COALESCE($3,age), sex=COALESCE($4,sex), dob=COALESCE($5,dob), file_no=COALESCE($6,file_no), abha_id=COALESCE($7,abha_id), health_id=COALESCE($8,health_id), aadhaar=COALESCE($9,aadhaar), govt_id=COALESCE($10,govt_id), govt_id_type=COALESCE($11,govt_id_type) WHERE id=$1",
        [patientId, n(patient.name), int(patient.age), n(patient.sex), n(patient.dob)||null, n(patient.fileNo), n(patient.abhaId), n(patient.healthId), n(patient.aadhaar), n(patient.govtId), n(patient.govtIdType)]
      );
    } else {
      const r = await client.query(
        "INSERT INTO patients (name, phone, age, sex, dob, file_no, abha_id, health_id, aadhaar, govt_id, govt_id_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id",
        [n(patient.name), n(patient.phone), int(patient.age), n(patient.sex), n(patient.dob)||null, n(patient.fileNo), n(patient.abhaId), n(patient.healthId), n(patient.aadhaar), n(patient.govtId), n(patient.govtIdType)]
      );
      patientId = r.rows[0].id;
    }

    // 2. Create consultation
    const safeJson = v => { try { return JSON.stringify(v || null); } catch { return null; } };
    const con = await client.query(
      `INSERT INTO consultations (patient_id, mo_name, con_name, mo_transcript, con_transcript, quick_transcript, mo_data, con_data, plan_edits, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed') RETURNING id`,
      [patientId, n(moName), n(conName), n(moTranscript), n(conTranscript), n(quickTranscript), safeJson(moData), safeJson(conData), safeJson(planEdits)]
    );
    const consultationId = con.rows[0].id;

    // 3. Save vitals
    if (vitals && (num(vitals.bp_sys) || num(vitals.weight))) {
      await client.query(
        "INSERT INTO vitals (patient_id, consultation_id, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [patientId, consultationId, num(vitals.bp_sys), num(vitals.bp_dia), num(vitals.pulse), num(vitals.temp), num(vitals.spo2), num(vitals.weight), num(vitals.height), num(vitals.bmi)]
      );
    }

    // 4. Save diagnoses
    const diagnoses = moData?.diagnoses || [];
    for (const d of diagnoses) {
      await client.query(
        "INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [patientId, consultationId, d.id, d.label, d.status]
      );
    }

    // 5. Save medications (previous + confirmed)
    const prevMeds = moData?.previous_medications || [];
    for (const m of prevMeds) {
      await client.query(
        "INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, is_new, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,true)",
        [patientId, consultationId, m.name, m._matched || null, m.composition, m.dose, m.frequency, m.timing]
      );
    }
    const newMeds = conData?.medications_confirmed || [];
    for (const m of newMeds) {
      await client.query(
        "INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, route, for_diagnosis, is_new, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)",
        [patientId, consultationId, m.name, m._matched || null, m.composition, m.dose, m.frequency, m.timing, m.route, m.forDiagnosis || []]
      );
    }

    // 6. Save lab results
    const investigations = moData?.investigations || [];
    for (const inv of investigations) {
      if (num(inv.value) !== null) {
        await client.query(
          "INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, is_critical, ref_range, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scribe')",
          [patientId, consultationId, inv.test, num(inv.value), n(inv.unit), n(inv.flag), inv.critical || false, n(inv.ref)]
        );
      }
    }

    // 7. Save goals
    const goals = conData?.goals || [];
    for (const g of goals) {
      await client.query(
        "INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [patientId, consultationId, g.marker, g.current, g.target, g.timeline, g.priority]
      );
    }

    // 8. Save complications
    const complications = moData?.complications || [];
    for (const c of complications) {
      await client.query(
        "INSERT INTO complications (patient_id, consultation_id, name, status, detail, severity) VALUES ($1,$2,$3,$4,$5,$6)",
        [patientId, consultationId, c.name, c.status, c.detail, c.severity]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, patient_id: patientId, consultation_id: consultationId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Save error:", e.message, e.detail || "", e.where || "");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Get consultation detail
app.get("/api/consultations/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, p.name as patient_name, p.age, p.sex, p.phone, p.file_no
       FROM consultations c JOIN patients p ON p.id = c.patient_id WHERE c.id=$1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ VITALS HISTORY ============
app.get("/api/patients/:id/vitals", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [req.params.id]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ LAB TRENDS ============
app.get("/api/patients/:id/labs", async (req, res) => {
  try {
    const { test } = req.query;
    let result;
    if (test) {
      result = await pool.query("SELECT * FROM lab_results WHERE patient_id=$1 AND test_name=$2 ORDER BY test_date", [req.params.id, test]);
    } else {
      result = await pool.query("SELECT * FROM lab_results WHERE patient_id=$1 ORDER BY test_date DESC", [req.params.id]);
    }
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ MEDICATIONS ============
app.get("/api/patients/:id/medications", async (req, res) => {
  try {
    const { active } = req.query;
    const where = active === "true" ? "AND is_active=TRUE" : "";
    const result = await pool.query(`SELECT * FROM medications WHERE patient_id=$1 ${where} ORDER BY created_at DESC`, [req.params.id]);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ DOCUMENTS ============
app.post("/api/patients/:id/documents", async (req, res) => {
  try {
    const { doc_type, title, file_name, file_url, extracted_text, extracted_data, doc_date, source, notes, consultation_id } = req.body;
    const result = await pool.query(
      `INSERT INTO documents (patient_id, consultation_id, doc_type, title, file_name, file_url, extracted_text, extracted_data, doc_date, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, consultation_id, doc_type, title, file_name, file_url, extracted_text, JSON.stringify(extracted_data), doc_date, source, notes]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ OUTCOMES / ANALYTICS ============

// Patient outcome: biomarker trends
app.get("/api/patients/:id/outcomes", async (req, res) => {
  try {
    const id = req.params.id;
    const [hba1c, bp, weight, egfr] = await Promise.all([
      pool.query("SELECT result, test_date FROM lab_results WHERE patient_id=$1 AND test_name='HbA1c' ORDER BY test_date", [id]),
      pool.query("SELECT bp_sys, bp_dia, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND bp_sys IS NOT NULL ORDER BY recorded_at", [id]),
      pool.query("SELECT weight, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND weight IS NOT NULL ORDER BY recorded_at", [id]),
      pool.query("SELECT result, test_date FROM lab_results WHERE patient_id=$1 AND test_name='eGFR' ORDER BY test_date", [id]),
    ]);
    res.json({
      hba1c: hba1c.rows,
      bp: bp.rows,
      weight: weight.rows,
      egfr: egfr.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Doctor analytics: aggregate outcomes across patients
app.get("/api/analytics/outcomes", async (req, res) => {
  try {
    const { doctor, period = "6m" } = req.query;
    const interval = period === "1y" ? "1 year" : period === "3m" ? "3 months" : "6 months";

    // Patients with improving HbA1c
    const hba1c = await pool.query(`
      WITH ranked AS (
        SELECT patient_id, result, test_date,
          ROW_NUMBER() OVER (PARTITION BY patient_id ORDER BY test_date DESC) as rn,
          FIRST_VALUE(result) OVER (PARTITION BY patient_id ORDER BY test_date DESC) as latest,
          FIRST_VALUE(result) OVER (PARTITION BY patient_id ORDER BY test_date ASC) as earliest
        FROM lab_results WHERE test_name='HbA1c' AND test_date > NOW() - $1::interval
      )
      SELECT
        COUNT(DISTINCT patient_id) as total_patients,
        COUNT(DISTINCT CASE WHEN latest < earliest THEN patient_id END) as improved,
        COUNT(DISTINCT CASE WHEN latest <= 7.0 THEN patient_id END) as at_target,
        ROUND(AVG(latest)::numeric, 1) as avg_latest
      FROM ranked WHERE rn=1
    `, [interval]);

    res.json({ hba1c: hba1c.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ PREVIOUS CONSULTATION IMPORT ============
// For entering historical data
app.post("/api/patients/:id/history", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const patientId = req.params.id;
    const { visit_date, visit_type, doctor_name, vitals, diagnoses, medications, labs, notes } = req.body;

    // Create historical consultation
    const con = await client.query(
      "INSERT INTO consultations (patient_id, visit_date, visit_type, con_name, status) VALUES ($1,$2,$3,$4,'historical') RETURNING id",
      [patientId, visit_date, visit_type || "OPD", doctor_name]
    );
    const cid = con.rows[0].id;

    // Save vitals if provided
    if (vitals && Object.keys(vitals).length > 0) {
      await client.query(
        "INSERT INTO vitals (patient_id, consultation_id, recorded_at, bp_sys, bp_dia, pulse, weight, height, bmi) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [patientId, cid, visit_date, vitals.bp_sys, vitals.bp_dia, vitals.pulse, vitals.weight, vitals.height, vitals.bmi]
      );
    }

    // Save diagnoses
    for (const d of (diagnoses || [])) {
      await client.query(
        "INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status) VALUES ($1,$2,$3,$4,$5)",
        [patientId, cid, d.id, d.label, d.status]
      );
    }

    // Save medications
    for (const m of (medications || [])) {
      await client.query(
        "INSERT INTO medications (patient_id, consultation_id, name, composition, dose, frequency, timing, is_active, started_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [patientId, cid, m.name, m.composition, m.dose, m.frequency, m.timing, m.is_active !== false, m.started_date || visit_date]
      );
    }

    // Save labs
    for (const l of (labs || [])) {
      await client.query(
        "INSERT INTO lab_results (patient_id, consultation_id, test_date, test_name, result, unit, flag, ref_range, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')",
        [patientId, cid, visit_date, l.test_name, l.result, l.unit, l.flag, l.ref_range]
      );
    }

    await client.query("COMMIT");
    res.json({ success: true, consultation_id: cid });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Gini Scribe API running on port ${PORT}`));
