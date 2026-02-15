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

// Strip any existing sslmode param to avoid conflicts
const cleanDbUrl = dbUrl.replace(/[?&]sslmode=[^&]*/g, '');
const finalDbUrl = cleanDbUrl || undefined;

const pool = new pg.Pool({
  connectionString: finalDbUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 10,
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

// ============ AUTH ============

// DB health check
app.get("/api/health", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW() as time, current_database() as db");
    res.json({ status: "ok", ...result.rows[0], db_url_prefix: (process.env.DATABASE_URL||"").slice(0,50)+"..." });
  } catch (e) { res.status(500).json({ status: "error", error: e.message, code: e.code }); }
});

// Get all active doctors (for login screen)
app.get("/api/doctors", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, name, short_name, specialty, role FROM doctors WHERE is_active=true ORDER BY role, name"
    );
    res.json(result.rows);
  } catch (e) { console.error("Doctors fetch error:", e.message); res.json([]); }
});

// Login with PIN
app.post("/api/auth/login", async (req, res) => {
  try {
    const { doctor_id, pin } = req.body;
    const doc = await pool.query("SELECT * FROM doctors WHERE id=$1 AND pin=$2 AND is_active=true", [doctor_id, pin]);
    if (doc.rows.length === 0) return res.status(401).json({ error: "Invalid PIN" });
    
    // Generate token
    const token = Date.now().toString(36) + Math.random().toString(36).slice(2);
    await pool.query(
      "INSERT INTO auth_sessions (doctor_id, token) VALUES ($1, $2)",
      [doctor_id, token]
    );
    
    // Audit
    await pool.query(
      "INSERT INTO audit_log (doctor_id, action, details) VALUES ($1, 'login', $2)",
      [doctor_id, JSON.stringify({ ip: req.ip })]
    );
    
    res.json({ token, doctor: doc.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Verify token middleware
const authMiddleware = async (req, res, next) => {
  const token = req.headers["x-auth-token"];
  if (!token) return next(); // Allow unauthenticated for now (graceful degradation)
  try {
    const session = await pool.query(
      "SELECT s.*, d.name as doctor_name, d.short_name, d.specialty, d.role FROM auth_sessions s JOIN doctors d ON d.id=s.doctor_id WHERE s.token=$1 AND s.expires_at > NOW()",
      [token]
    );
    if (session.rows.length > 0) {
      req.doctor = session.rows[0];
    }
  } catch {}
  next();
};
app.use(authMiddleware);

// Logout
app.post("/api/auth/logout", async (req, res) => {
  const token = req.headers["x-auth-token"];
  if (token) await pool.query("DELETE FROM auth_sessions WHERE token=$1", [token]).catch(()=>{});
  res.json({ ok: true });
});

// Check session
app.get("/api/auth/me", async (req, res) => {
  if (req.doctor) {
    res.json({ authenticated: true, doctor: req.doctor });
  } else {
    res.json({ authenticated: false });
  }
});

// ============ PATIENTS ============

app.get("/api/patients", async (req, res) => {
  try {
    const { q, limit = 30, doctor, period } = req.query;
    const baseQ = `SELECT p.*, 
      (SELECT COUNT(*) FROM consultations c WHERE c.patient_id=p.id) as visit_count,
      (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) as last_visit,
      (SELECT string_agg(DISTINCT d.label, ', ' ORDER BY d.label) FROM diagnoses d WHERE d.patient_id=p.id AND d.is_active=true) as diagnosis_labels,
      (SELECT con_name FROM consultations c WHERE c.patient_id=p.id ORDER BY visit_date DESC LIMIT 1) as last_doctor
      FROM patients p`;
    const conditions = [];
    const params = [];
    let idx = 1;
    if (q) {
      conditions.push(`(p.name ILIKE $${idx} OR p.phone LIKE $${idx} OR p.file_no ILIKE $${idx} OR p.abha_id ILIKE $${idx})`);
      params.push(`%${q}%`); idx++;
    }
    if (doctor) {
      conditions.push(`EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND c.con_name ILIKE $${idx})`);
      params.push(`%${doctor}%`); idx++;
    }
    if (period === 'today') {
      conditions.push(`EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND c.visit_date::date = CURRENT_DATE)`);
    } else if (period === 'week') {
      conditions.push(`EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND c.visit_date >= CURRENT_DATE - INTERVAL '7 days')`);
    } else if (period === 'month') {
      conditions.push(`EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND c.visit_date >= CURRENT_DATE - INTERVAL '30 days')`);
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit)); idx++;
    const result = await pool.query(
      `${baseQ}${where} ORDER BY (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) DESC NULLS LAST LIMIT $${params.length}`,
      params
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get list of doctors
app.get("/api/doctors", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT con_name as name, COUNT(DISTINCT patient_id) as patient_count
       FROM consultations WHERE con_name IS NOT NULL AND con_name != ''
       GROUP BY con_name ORDER BY patient_count DESC`
    );
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get patient stats for dashboard
app.get("/api/stats", async (req, res) => {
  try {
    const [total, today, week, topDx] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM patients"),
      pool.query("SELECT COUNT(DISTINCT patient_id) FROM consultations WHERE visit_date::date = CURRENT_DATE"),
      pool.query("SELECT COUNT(DISTINCT patient_id) FROM consultations WHERE visit_date >= CURRENT_DATE - INTERVAL '7 days'"),
      pool.query("SELECT label, COUNT(*) as cnt FROM diagnoses WHERE is_active=true GROUP BY label ORDER BY cnt DESC LIMIT 5")
    ]);
    res.json({
      total_patients: parseInt(total.rows[0].count),
      today: parseInt(today.rows[0].count),
      this_week: parseInt(week.rows[0].count),
      top_diagnoses: topDx.rows
    });
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
      pool.query("SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, consultation_id, created_at FROM documents WHERE patient_id=$1 ORDER BY doc_date DESC", [id]),
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
    const { patient, vitals, moData, conData, moTranscript, conTranscript, quickTranscript, moName, conName, planEdits, moDoctorId, conDoctorId, visitDate } = req.body;

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

    const vDate = n(visitDate) || null;
    const con = await client.query(
      `INSERT INTO consultations (patient_id, visit_date, mo_name, con_name, mo_transcript, con_transcript, quick_transcript, mo_data, con_data, plan_edits, status, mo_doctor_id, con_doctor_id)
       VALUES ($1,COALESCE($2::date, CURRENT_DATE),$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12) RETURNING id`,
      [patientId, vDate, n(moName), n(conName), n(moTranscript), n(conTranscript), n(quickTranscript), safeJson(moData), safeJson(conData), safeJson(planEdits), int(moDoctorId), int(conDoctorId)]
    );
    const consultationId = con.rows[0].id;

    // Audit log
    const doctorId = req.doctor?.doctor_id || int(conDoctorId) || int(moDoctorId);
    if (doctorId) {
      await client.query(
        "INSERT INTO audit_log (doctor_id, action, entity_type, entity_id, details) VALUES ($1, 'save_consultation', 'consultation', $2, $3)",
        [doctorId, consultationId, JSON.stringify({ patient_id: patientId, patient_name: patient.name })]
      ).catch(()=>{});
    }

    if (vitals && (num(vitals.bp_sys) || num(vitals.weight))) {
      await client.query(
        `INSERT INTO vitals (patient_id, consultation_id, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, waist, body_fat, muscle_mass, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::timestamptz, NOW()))`,
        [patientId, consultationId, num(vitals.bp_sys), num(vitals.bp_dia), num(vitals.pulse),
         num(vitals.temp), num(vitals.spo2), num(vitals.weight), num(vitals.height), num(vitals.bmi),
         num(vitals.waist), num(vitals.body_fat), num(vitals.muscle_mass), vDate]
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
          `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, is_critical, ref_range, source, test_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scribe',COALESCE($9::date, CURRENT_DATE))`,
          [patientId, consultationId, inv.test, num(inv.value), n(inv.unit), n(inv.flag), inv.critical===true, n(inv.ref), vDate]
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

// Save individual lab result
app.post("/api/patients/:id/labs", async (req, res) => {
  try {
    const { test_name, result, unit, flag, ref_range, test_date, consultation_id } = req.body;
    const r = await pool.query(
      `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, ref_range, test_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.params.id, n(consultation_id), test_name, result, n(unit), n(flag)||"N", n(ref_range), n(test_date)||new Date().toISOString().split("T")[0]]
    );
    res.json(r.rows[0]);
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

// Get specific document with full data
app.get("/api/documents/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get prescription for a consultation (for reprinting)
app.get("/api/consultations/:id/prescription", async (req, res) => {
  try {
    const doc = await pool.query(
      "SELECT * FROM documents WHERE consultation_id=$1 AND doc_type='prescription' ORDER BY created_at DESC LIMIT 1",
      [req.params.id]
    );
    if (doc.rows[0]) return res.json(doc.rows[0]);
    // Fallback: reconstruct from consultation data
    const con = await pool.query(
      `SELECT c.*, p.name as patient_name, p.age, p.sex, p.phone, p.file_no, p.dob
       FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE c.id=$1`, [req.params.id]);
    if (!con.rows[0]) return res.status(404).json({ error: "Not found" });
    const c = con.rows[0];
    res.json({
      doc_type: "prescription",
      title: `Prescription — ${c.con_name} — ${new Date(c.visit_date||c.created_at).toLocaleDateString("en-IN")}`,
      extracted_data: {
        patient: { name: c.patient_name, age: c.age, sex: c.sex, phone: c.phone, fileNo: c.file_no },
        doctor: c.con_name, mo: c.mo_name,
        date: c.visit_date || c.created_at,
        diagnoses: c.mo_data?.diagnoses || [],
        medications: c.con_data?.medications_confirmed || [],
        diet_lifestyle: c.con_data?.diet_lifestyle || [],
        follow_up: c.con_data?.follow_up || {},
        assessment_summary: c.con_data?.assessment_summary || "",
        chief_complaints: c.mo_data?.chief_complaints || [],
        plan_edits: c.plan_edits
      },
      source: "scribe",
      doc_date: c.visit_date || c.created_at
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get all imaging documents for a patient
app.get("/api/patients/:id/imaging", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, created_at
       FROM documents WHERE patient_id=$1 AND doc_type NOT IN ('prescription','lab_report')
       ORDER BY doc_date DESC`,
      [req.params.id]
    );
    res.json(result.rows);
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
      pool.query(labQ(['FPG','Fasting Glucose','Fasting Blood Sugar','FBS','FBG']), [id, 'FPG','Fasting Glucose','Fasting Blood Sugar','FBS','FBG']),
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
      `SELECT d.diagnosis_id, d.label, d.status, c.visit_date, c.con_name, c.mo_name
       FROM diagnoses d JOIN consultations c ON c.id = d.consultation_id
       WHERE d.patient_id=$1 ORDER BY d.diagnosis_id, c.visit_date`, [id]);

    const medTimeline = await pool.query(
      `SELECT m.name, m.dose, m.frequency, m.timing, m.is_active, m.is_new, m.started_date, c.visit_date, m.pharmacy_match
       FROM medications m JOIN consultations c ON c.id = m.consultation_id
       WHERE m.patient_id=$1 ORDER BY UPPER(m.name), c.visit_date`, [id]);

    // Consultations with full context for timeline
    const visits = await pool.query(
      `SELECT id, visit_date, visit_type, mo_name, con_name, status,
       mo_data->'history' as history, mo_data->'complications' as complications,
       mo_data->'symptoms' as symptoms, mo_data->'compliance' as compliance,
       mo_data->'chief_complaints' as chief_complaints,
       con_data->'diet_lifestyle' as lifestyle, con_data->'self_monitoring' as monitoring,
       con_data->'assessment_summary' as summary,
       con_data->'medications_confirmed' as medications_confirmed
       FROM consultations WHERE patient_id=$1 ORDER BY visit_date DESC`, [id]);

    res.json({
      hba1c: hba1c.rows, fpg: fpg.rows, ldl: ldl.rows, triglycerides: tg.rows,
      hdl: hdl.rows, creatinine: creat.rows, egfr: egfr.rows, uacr: uacr.rows, tsh: tsh.rows,
      bp: bp.rows, weight: weight.rows,
      waist: waist.rows, body_fat: bodyFat.rows, muscle_mass: muscleMass.rows,
      screenings: screenings.rows,
      diagnosis_journey: diagJourney.rows,
      med_timeline: medTimeline.rows,
      visits: visits.rows,
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

// ============ REPORTS ============

// Today's summary with outcomes trend
app.get("/api/reports/today", async (req, res) => {
  try {
    const { period = "today", doctor } = req.query;
    let dateFilter = "c.visit_date::date = CURRENT_DATE";
    if (period === "week") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '7 days'";
    else if (period === "month") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '30 days'";
    const doctorFilter = doctor ? ` AND c.con_name ILIKE '%${doctor.replace(/'/g,"")}%'` : "";
    
    // Patients seen with their latest key labs
    const patients = await pool.query(`
      SELECT DISTINCT ON (p.id) p.id, p.name, p.age, p.sex, p.file_no,
        c.visit_date, c.con_name,
        (SELECT json_agg(json_build_object('label',d.label,'status',d.status,'id',d.diagnosis_id))
         FROM diagnoses d WHERE d.patient_id=p.id AND d.is_active=true) as diagnoses
      FROM patients p
      JOIN consultations c ON c.patient_id=p.id
      WHERE ${dateFilter}${doctorFilter}
      ORDER BY p.id, c.visit_date DESC
    `);
    
    // Get HbA1c trends for these patients (latest 2 values)
    const patientIds = patients.rows.map(p=>p.id);
    let trends = [];
    if (patientIds.length > 0) {
      trends = (await pool.query(`
        SELECT lr.patient_id, lr.test_name, lr.result, lr.test_date
        FROM lab_results lr
        WHERE lr.patient_id = ANY($1)
          AND lr.test_name IN ('HbA1c','FBG','FPG','Fasting Glucose','Fasting Blood Sugar')
        ORDER BY lr.patient_id, lr.test_name, lr.test_date DESC
      `, [patientIds])).rows;
    }
    
    // Build trend map per patient
    const trendMap = {};
    trends.forEach(t => {
      if (!trendMap[t.patient_id]) trendMap[t.patient_id] = {};
      const key = t.test_name.includes("A1c") ? "HbA1c" : "FBG";
      if (!trendMap[t.patient_id][key]) trendMap[t.patient_id][key] = [];
      if (trendMap[t.patient_id][key].length < 3) trendMap[t.patient_id][key].push({ val: parseFloat(t.result), date: t.test_date });
    });
    
    // Classify patients
    let improving = 0, worsening = 0, stable = 0, newPt = 0;
    const enriched = patients.rows.map(p => {
      const t = trendMap[p.id] || {};
      let trend = "new";
      if (t.HbA1c && t.HbA1c.length >= 2) {
        const diff = t.HbA1c[0].val - t.HbA1c[1].val;
        if (diff < -0.2) { trend = "improving"; improving++; }
        else if (diff > 0.3) { trend = "worsening"; worsening++; }
        else { trend = "stable"; stable++; }
      } else if (t.FBG && t.FBG.length >= 2) {
        const diff = t.FBG[0].val - t.FBG[1].val;
        if (diff < -10) { trend = "improving"; improving++; }
        else if (diff > 15) { trend = "worsening"; worsening++; }
        else { trend = "stable"; stable++; }
      } else { newPt++; }
      return { ...p, trend, labs: t };
    });
    
    // Summary counts
    const byDoctor = {};
    patients.rows.forEach(p => {
      const d = p.con_name || "Unknown";
      byDoctor[d] = (byDoctor[d]||0) + 1;
    });
    
    res.json({
      total: patients.rows.length,
      improving, worsening, stable, new: newPt,
      by_doctor: byDoctor,
      patients: enriched
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Diagnosis distribution
app.get("/api/reports/diagnoses", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.label, d.diagnosis_id as id, d.status, COUNT(DISTINCT d.patient_id) as patient_count
      FROM diagnoses d WHERE d.is_active=true
      GROUP BY d.label, d.diagnosis_id, d.status
      ORDER BY patient_count DESC
    `);
    
    // Aggregate by diagnosis (combine statuses)
    const map = {};
    result.rows.forEach(r => {
      if (!map[r.id]) map[r.id] = { id:r.id, label:r.label, total:0, controlled:0, uncontrolled:0, present:0 };
      const cnt = parseInt(r.patient_count);
      map[r.id].total += cnt;
      if (r.status === "Controlled") map[r.id].controlled += cnt;
      else if (r.status === "Uncontrolled") map[r.id].uncontrolled += cnt;
      else map[r.id].present += cnt;
    });
    
    res.json(Object.values(map).sort((a,b) => b.total - a.total));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Doctor performance
app.get("/api/reports/doctors", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT c.con_name as doctor,
        COUNT(DISTINCT c.patient_id) as total_patients,
        COUNT(DISTINCT c.id) as total_visits,
        COUNT(DISTINCT CASE WHEN c.visit_date::date = CURRENT_DATE THEN c.patient_id END) as today,
        COUNT(DISTINCT CASE WHEN c.visit_date >= CURRENT_DATE - INTERVAL '7 days' THEN c.patient_id END) as this_week,
        COUNT(DISTINCT CASE WHEN c.visit_date >= CURRENT_DATE - INTERVAL '30 days' THEN c.patient_id END) as this_month
      FROM consultations c
      WHERE c.con_name IS NOT NULL AND c.con_name != ''
      GROUP BY c.con_name
      ORDER BY total_patients DESC
    `);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI Query — returns raw data for AI to analyze
app.get("/api/reports/query-data", async (req, res) => {
  try {
    const [patients, meds, labs, diagnoses, vitals] = await Promise.all([
      pool.query(`SELECT p.id, p.name, p.age, p.sex, p.file_no,
        (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) as last_visit,
        (SELECT con_name FROM consultations c WHERE c.patient_id=p.id ORDER BY visit_date DESC LIMIT 1) as doctor
        FROM patients p ORDER BY (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) DESC NULLS LAST LIMIT 200`),
      pool.query(`SELECT m.patient_id, m.name, m.dose, m.is_active FROM medications m WHERE m.is_active=true`),
      pool.query(`SELECT lr.patient_id, lr.test_name, lr.result, lr.unit, lr.test_date 
        FROM lab_results lr WHERE lr.test_date > CURRENT_DATE - INTERVAL '12 months'
        ORDER BY lr.test_date DESC`),
      pool.query(`SELECT d.patient_id, d.label, d.diagnosis_id, d.status, d.is_active FROM diagnoses d WHERE d.is_active=true`),
      pool.query(`SELECT DISTINCT ON (v.patient_id) v.patient_id, v.weight, v.bp_sys, v.bp_dia, v.bmi, v.recorded_at
        FROM vitals v ORDER BY v.patient_id, v.recorded_at DESC`)
    ]);
    
    // Build per-patient summary
    const medMap = {}, labMap = {}, dxMap = {}, vMap = {};
    meds.rows.forEach(m => { if (!medMap[m.patient_id]) medMap[m.patient_id]=[]; medMap[m.patient_id].push(m); });
    labs.rows.forEach(l => { if (!labMap[l.patient_id]) labMap[l.patient_id]=[]; if(labMap[l.patient_id].length<10) labMap[l.patient_id].push(l); });
    diagnoses.rows.forEach(d => { if (!dxMap[d.patient_id]) dxMap[d.patient_id]=[]; dxMap[d.patient_id].push(d); });
    vitals.rows.forEach(v => { vMap[v.patient_id] = v; });
    
    const summary = patients.rows.map(p => ({
      ...p,
      medications: (medMap[p.id]||[]).map(m=>`${m.name} ${m.dose}`),
      diagnoses: (dxMap[p.id]||[]).map(d=>`${d.label}(${d.status})`),
      recent_labs: (labMap[p.id]||[]).map(l=>`${l.test_name}:${l.result}${l.unit||""}(${String(l.test_date||"").slice(0,10)})`),
      vitals: vMap[p.id] ? `Wt:${vMap[p.id].weight}kg BP:${vMap[p.id].bp_sys}/${vMap[p.id].bp_dia} BMI:${vMap[p.id].bmi}` : null
    }));
    
    res.json({ patient_count: summary.length, patients: summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
