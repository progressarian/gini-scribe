import express from "express";
import cors from "cors";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const dbUrl = process.env.DATABASE_URL || "";
const isInternal = dbUrl.includes(".railway.internal");
const needsSsl = !!dbUrl && !isInternal;

// Append sslmode if not already in URL
const finalDbUrl = (needsSsl && !dbUrl.includes("sslmode")) ? dbUrl + "?sslmode=require" : dbUrl;

const pool = new pg.Pool({
  connectionString: finalDbUrl || undefined,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

console.log("📦 DB:", !!dbUrl, "internal:", isInternal, "ssl:", needsSsl);

const n = v => (v === "" || v === undefined || v === null) ? null : v;
const num = v => { const x = parseFloat(v); return isNaN(x) ? null : x; };
const int = v => { const x = parseInt(v); return isNaN(x) ? null : x; };
const safeJson = v => { try { return v ? JSON.stringify(v) : null; } catch { return null; } };

app.get("/api/health", async (_, res) => {
  const info = {
    status: "ok",
    service: "gini-scribe-api",
    hasDbUrl: !!dbUrl,
    dbHost: dbUrl ? new URL(dbUrl).hostname : null,
    dbPort: dbUrl ? new URL(dbUrl).port : null,
    sslEnabled: needsSsl,
  };
  try {
    const r = await pool.query("SELECT NOW()");
    res.json({ ...info, db: "connected", time: r.rows[0].now });
  } catch (e) {
    res.json({ ...info, db: "error", error: e.message, code: e.code });
  }
});

// ============ PATIENTS ============

app.get("/api/patients", async (req, res) => {
  try {
    const { q, limit = 20 } = req.query;
    let result;
    const baseQ = `SELECT p.*, 
      (SELECT COUNT(*) FROM consultations c WHERE c.patient_id=p.id) as visit_count,
      (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) as last_visit,
      (SELECT COUNT(*) FROM diagnoses d WHERE d.patient_id=p.id AND d.is_active=true) as active_diagnoses
      FROM patients p`;
    if (q) {
      result = await pool.query(
        `${baseQ} WHERE p.name ILIKE $1 OR p.phone LIKE $2 OR p.file_no ILIKE $1
         ORDER BY (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) DESC NULLS LAST LIMIT $3`,
        [`%${q}%`, `%${q}%`, limit]
      );
    } else {
      result = await pool.query(
        `${baseQ} ORDER BY (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) DESC NULLS LAST LIMIT $1`, [limit]
      );
    }
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single patient — DEDUPLICATED
app.get("/api/patients/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const patient = await pool.query("SELECT * FROM patients WHERE id=$1", [id]);
    if (!patient.rows[0]) return res.status(404).json({ error: "Not found" });

    const [consultations, vitals, meds, labs, diagnoses, docs, goals] = await Promise.all([
      pool.query("SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at FROM consultations WHERE patient_id=$1 ORDER BY visit_date DESC", [id]),
      pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [id]),
      // Deduplicate meds: latest entry per med name
      pool.query(`SELECT DISTINCT ON (UPPER(name)) * FROM medications
        WHERE patient_id=$1 ORDER BY UPPER(name), created_at DESC`, [id]),
      // Deduplicate labs: distinct by test+date
      pool.query(`SELECT DISTINCT ON (test_name, test_date) * FROM lab_results
        WHERE patient_id=$1 ORDER BY test_name, test_date DESC, created_at DESC`, [id]),
      // Deduplicate diagnoses: latest status per diagnosis_id
      pool.query(`SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
        WHERE patient_id=$1 ORDER BY diagnosis_id, created_at DESC`, [id]),
      pool.query("SELECT id, doc_type, title, file_name, doc_date, source, created_at FROM documents WHERE patient_id=$1 ORDER BY doc_date DESC", [id]),
      pool.query("SELECT * FROM goals WHERE patient_id=$1 ORDER BY status, created_at DESC", [id]),
    ]);

    // Deduplicate consultations by visit_date+status
    const seenVisits = new Set();
    const uniqueConsultations = consultations.rows.filter(c => {
      const key = `${c.visit_date}|${c.status}`;
      if (seenVisits.has(key)) return false;
      seenVisits.add(key);
      return true;
    });

    res.json({
      ...patient.rows[0],
      consultations: uniqueConsultations,
      vitals: vitals.rows,
      medications: meds.rows,
      lab_results: labs.rows,
      diagnoses: diagnoses.rows,
      documents: docs.rows,
      goals: goals.rows,
    });
  } catch (e) { console.error("Patient detail error:", e.message); res.status(500).json({ error: e.message }); }
});

app.post("/api/patients", async (req, res) => {
  try {
    const p = req.body;
    let existing = null;
    if (n(p.phone)) existing = (await pool.query("SELECT id FROM patients WHERE phone=$1", [p.phone])).rows[0];
    if (!existing && n(p.file_no)) existing = (await pool.query("SELECT id FROM patients WHERE file_no=$1", [p.file_no])).rows[0];
    if (!existing && n(p.abha_id)) existing = (await pool.query("SELECT id FROM patients WHERE abha_id=$1", [p.abha_id])).rows[0];

    if (existing) {
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

app.post("/api/consultations", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { patient, vitals, moData, conData, moTranscript, conTranscript, quickTranscript, moName, conName, planEdits } = req.body;

    let patientId, existing = null;
    if (n(patient.phone)) existing = (await client.query("SELECT id FROM patients WHERE phone=$1", [patient.phone])).rows[0];
    if (!existing && n(patient.fileNo)) existing = (await client.query("SELECT id FROM patients WHERE file_no=$1", [patient.fileNo])).rows[0];
    // Fallback: match by name (for Quick mode without phone/fileNo)
    if (!existing && n(patient.name)) existing = (await client.query("SELECT id FROM patients WHERE LOWER(name)=LOWER($1) LIMIT 1", [patient.name])).rows[0];

    if (existing) {
      patientId = existing.id;
      await client.query(
        `UPDATE patients SET name=COALESCE($2,name), age=COALESCE($3,age), sex=COALESCE($4,sex),
         file_no=COALESCE($5,file_no), abha_id=COALESCE($6,abha_id),
         health_id=COALESCE($7,health_id), aadhaar=COALESCE($8,aadhaar),
         govt_id=COALESCE($9,govt_id), govt_id_type=COALESCE($10,govt_id_type),
         dob=COALESCE($11,dob) WHERE id=$1`,
        [patientId, n(patient.name), int(patient.age), n(patient.sex),
         n(patient.fileNo), n(patient.abhaId), n(patient.healthId),
         n(patient.aadhaar), n(patient.govtId), n(patient.govtIdType), n(patient.dob)||null]
      );
    } else {
      const r = await client.query(
        `INSERT INTO patients (name, phone, age, sex, file_no, abha_id, health_id, aadhaar, govt_id, govt_id_type, dob)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [n(patient.name)||'Unknown', n(patient.phone), int(patient.age), n(patient.sex),
         n(patient.fileNo), n(patient.abhaId), n(patient.healthId),
         n(patient.aadhaar), n(patient.govtId), n(patient.govtIdType), n(patient.dob)||null]
      );
      patientId = r.rows[0].id;
    }

    const con = await client.query(
      `INSERT INTO consultations (patient_id, mo_name, con_name, mo_transcript, con_transcript, quick_transcript, mo_data, con_data, plan_edits, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed') RETURNING id`,
      [patientId, n(moName), n(conName), n(moTranscript), n(conTranscript), n(quickTranscript), safeJson(moData), safeJson(conData), safeJson(planEdits)]
    );
    const consultationId = con.rows[0].id;

    if (vitals && (num(vitals.bp_sys) || num(vitals.weight))) {
      await client.query(
        `INSERT INTO vitals (patient_id, consultation_id, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, waist, body_fat, muscle_mass)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [patientId, consultationId, num(vitals.bp_sys), num(vitals.bp_dia), num(vitals.pulse),
         num(vitals.temp), num(vitals.spo2), num(vitals.weight), num(vitals.height), num(vitals.bmi),
         num(vitals.waist), num(vitals.body_fat), num(vitals.muscle_mass)]
      );
    }

    for (const d of (moData?.diagnoses || [])) {
      if (d?.id && d?.label) {
        await client.query(
          `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [patientId, consultationId, d.id, d.label, n(d.status) || 'New']
        );
      }
    }
    for (const m of (moData?.previous_medications || [])) {
      if (m?.name) {
        await client.query(
          `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, is_new, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,true)`,
          [patientId, consultationId, m.name, n(m._matched), n(m.composition), n(m.dose), n(m.frequency), n(m.timing)]
        );
      }
    }
    for (const m of (conData?.medications_confirmed || [])) {
      if (m?.name) {
        await client.query(
          `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, route, is_new, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
          [patientId, consultationId, m.name, n(m._matched), n(m.composition), n(m.dose), n(m.frequency), n(m.timing), n(m.route)||'Oral', m.isNew===true]
        );
      }
    }
    for (const inv of (moData?.investigations || [])) {
      if (inv?.test && num(inv.value) !== null) {
        await client.query(
          `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, is_critical, ref_range, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scribe')`,
          [patientId, consultationId, inv.test, num(inv.value), n(inv.unit), n(inv.flag), inv.critical===true, n(inv.ref)]
        );
      }
    }
    for (const g of (conData?.goals || [])) {
      if (g?.marker) {
        await client.query(`INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [patientId, consultationId, g.marker, n(g.current), n(g.target), n(g.timeline), n(g.priority)]);
      }
    }
    for (const c of (moData?.complications || [])) {
      if (c?.name) {
        await client.query(`INSERT INTO complications (patient_id, consultation_id, name, status, detail, severity) VALUES ($1,$2,$3,$4,$5,$6)`,
          [patientId, consultationId, c.name, n(c.status), n(c.detail), n(c.severity)]);
      }
    }

    await client.query("COMMIT");
    console.log(`✅ Saved: patient=${patientId} consultation=${consultationId}`);
    res.json({ success: true, patient_id: patientId, consultation_id: consultationId });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Save error:", e.message, e.detail || "");
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.get("/api/consultations/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, p.name as patient_name, p.age, p.sex, p.phone, p.file_no
       FROM consultations c JOIN patients p ON p.id = c.patient_id WHERE c.id=$1`, [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ VITALS / LABS / MEDS ============
app.get("/api/patients/:id/vitals", async (req, res) => {
  try { res.json((await pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [req.params.id])).rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/patients/:id/labs", async (req, res) => {
  try {
    const { test } = req.query;
    const q = test
      ? `SELECT DISTINCT ON (test_name, test_date) * FROM lab_results WHERE patient_id=$1 AND test_name=$2 ORDER BY test_name, test_date, created_at DESC`
      : `SELECT DISTINCT ON (test_name, test_date) * FROM lab_results WHERE patient_id=$1 ORDER BY test_name, test_date DESC, created_at DESC`;
    const params = test ? [req.params.id, test] : [req.params.id];
    res.json((await pool.query(q, params)).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/patients/:id/medications", async (req, res) => {
  try {
    const { active } = req.query;
    const where = active === "true" ? "AND is_active=TRUE" : "";
    res.json((await pool.query(`SELECT DISTINCT ON (UPPER(name)) * FROM medications WHERE patient_id=$1 ${where} ORDER BY UPPER(name), created_at DESC`, [req.params.id])).rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/patients/:id/documents", async (req, res) => {
  try {
    const { doc_type, title, file_name, file_url, extracted_text, extracted_data, doc_date, source, notes, consultation_id } = req.body;
    const result = await pool.query(
      `INSERT INTO documents (patient_id, consultation_id, doc_type, title, file_name, file_url, extracted_text, extracted_data, doc_date, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.params.id, n(consultation_id), n(doc_type), n(title), n(file_name), n(file_url), n(extracted_text), safeJson(extracted_data), n(doc_date)||null, n(source), n(notes)]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ OUTCOMES — EXPANDED ============
app.get("/api/patients/:id/outcomes", async (req, res) => {
  try {
    const id = req.params.id;
    const { period } = req.query;
    let df = "", vf = "";
    if (period === "3m") { df = "AND test_date > NOW() - INTERVAL '3 months'"; vf = "AND recorded_at > NOW() - INTERVAL '3 months'"; }
    else if (period === "6m") { df = "AND test_date > NOW() - INTERVAL '6 months'"; vf = "AND recorded_at > NOW() - INTERVAL '6 months'"; }
    else if (period === "1y") { df = "AND test_date > NOW() - INTERVAL '1 year'"; vf = "AND recorded_at > NOW() - INTERVAL '1 year'"; }

    const labQ = (names) => `SELECT DISTINCT ON (test_date) result, test_date FROM lab_results WHERE patient_id=$1 AND test_name IN (${names.map((_,i)=>`$${i+2}`).join(',')}) ${df} ORDER BY test_date, created_at DESC`;

    const [hba1c, fpg, ldl, tg, hdl, creat, egfr, uacr, tsh, bp, weight, waist, bodyFat, muscleMass] = await Promise.all([
      pool.query(labQ(['HbA1c']), [id, 'HbA1c']),
      pool.query(labQ(['FPG','Fasting Glucose','Fasting Blood Sugar','FBS']), [id, 'FPG','Fasting Glucose','Fasting Blood Sugar','FBS']),
      pool.query(labQ(['LDL','LDL Cholesterol','LDL-C']), [id, 'LDL','LDL Cholesterol','LDL-C']),
      pool.query(labQ(['Triglycerides','TG','Triglyceride']), [id, 'Triglycerides','TG','Triglyceride']),
      pool.query(labQ(['HDL','HDL Cholesterol','HDL-C']), [id, 'HDL','HDL Cholesterol','HDL-C']),
      pool.query(labQ(['Creatinine','Serum Creatinine']), [id, 'Creatinine','Serum Creatinine']),
      pool.query(labQ(['eGFR']), [id, 'eGFR']),
      pool.query(labQ(['UACR','Urine Albumin Creatinine Ratio','Microalbumin']), [id, 'UACR','Urine Albumin Creatinine Ratio','Microalbumin']),
      pool.query(labQ(['TSH']), [id, 'TSH']),
      pool.query(`SELECT DISTINCT ON (recorded_at::date) bp_sys, bp_dia, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND bp_sys IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`, [id]),
      pool.query(`SELECT DISTINCT ON (recorded_at::date) weight, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND weight IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`, [id]),
      pool.query(`SELECT DISTINCT ON (recorded_at::date) waist, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND waist IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`, [id]),
      pool.query(`SELECT DISTINCT ON (recorded_at::date) body_fat, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND body_fat IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`, [id]),
      pool.query(`SELECT DISTINCT ON (recorded_at::date) muscle_mass, recorded_at::date as date FROM vitals WHERE patient_id=$1 AND muscle_mass IS NOT NULL ${vf} ORDER BY recorded_at::date, recorded_at DESC`, [id]),
    ]);

    const screenings = await pool.query(
      `SELECT DISTINCT ON (test_name) test_name, result, unit, test_date, flag
       FROM lab_results WHERE patient_id=$1 AND test_name IN ('VPT','ABI','Retinopathy','ECG','Doppler','DEXA','Ultrasound','X-Ray','MRI')
       ORDER BY test_name, test_date DESC`, [id]);

    const diagJourney = await pool.query(
      `SELECT d.diagnosis_id, d.label, d.status, c.visit_date
       FROM diagnoses d JOIN consultations c ON c.id = d.consultation_id
       WHERE d.patient_id=$1 ORDER BY d.diagnosis_id, c.visit_date`, [id]);

    const medTimeline = await pool.query(
      `SELECT m.name, m.dose, m.frequency, m.timing, m.is_active, m.is_new, m.started_date, c.visit_date, m.pharmacy_match
       FROM medications m JOIN consultations c ON c.id = m.consultation_id
       WHERE m.patient_id=$1 ORDER BY UPPER(m.name), c.visit_date`, [id]);

    res.json({
      hba1c: hba1c.rows, fpg: fpg.rows, ldl: ldl.rows, triglycerides: tg.rows,
      hdl: hdl.rows, creatinine: creat.rows, egfr: egfr.rows, uacr: uacr.rows, tsh: tsh.rows,
      bp: bp.rows, weight: weight.rows,
      waist: waist.rows, body_fat: bodyFat.rows, muscle_mass: muscleMass.rows,
      screenings: screenings.rows,
      diagnosis_journey: diagJourney.rows,
      med_timeline: medTimeline.rows,
    });
  } catch (e) { console.error("Outcomes error:", e.message); res.status(500).json({ error: e.message }); }
});

// ============ HISTORY IMPORT ============
app.post("/api/patients/:id/history", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const patientId = req.params.id;
    const { visit_date, visit_type, doctor_name, specialty, vitals, diagnoses, medications, labs } = req.body;

    const con = await client.query(
      "INSERT INTO consultations (patient_id, visit_date, visit_type, con_name, status) VALUES ($1,$2,$3,$4,'historical') RETURNING id",
      [patientId, visit_date, n(visit_type)||"OPD", n(doctor_name)]
    );
    const cid = con.rows[0].id;

    if (vitals && Object.keys(vitals).length > 0) {
      await client.query(
        "INSERT INTO vitals (patient_id, consultation_id, recorded_at, bp_sys, bp_dia, pulse, weight, height, bmi, waist, body_fat, muscle_mass) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [patientId, cid, visit_date, num(vitals.bp_sys), num(vitals.bp_dia), num(vitals.pulse), num(vitals.weight), num(vitals.height), num(vitals.bmi), num(vitals.waist), num(vitals.body_fat), num(vitals.muscle_mass)]
      );
    }

    for (const d of (diagnoses || [])) {
      if (d && (d.id || d.label)) {
        await client.query("INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status) VALUES ($1,$2,$3,$4,$5)",
          [patientId, cid, d.id || d.label.toLowerCase().replace(/\s+/g,'_'), d.label, n(d.status)||'New']);
      }
    }
    for (const m of (medications || [])) {
      if (m?.name) {
        await client.query("INSERT INTO medications (patient_id, consultation_id, name, composition, dose, frequency, timing, is_active, started_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [patientId, cid, m.name, n(m.composition), n(m.dose), n(m.frequency), n(m.timing), m.is_active!==false, n(m.started_date)||visit_date]);
      }
    }
    for (const l of (labs || [])) {
      if (l?.test_name) {
        await client.query("INSERT INTO lab_results (patient_id, consultation_id, test_date, test_name, result, unit, flag, ref_range, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')",
          [patientId, cid, visit_date, l.test_name, num(l.result), n(l.unit), n(l.flag), n(l.ref_range)]);
      }
    }

    await client.query("COMMIT");
    console.log(`✅ History saved: patient=${patientId} consultation=${cid}`);
    res.json({ success: true, consultation_id: cid });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ History save error:", e.message);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ============ SERVE FRONTEND ============
const distPath = path.join(__dirname, "..", "dist");
app.use(express.static(distPath));
app.get("*", (req, res) => {
  // Don't catch API routes
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found" });
  res.sendFile(path.join(distPath, "index.html"));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Gini Scribe API + Frontend running on port ${PORT}`));
