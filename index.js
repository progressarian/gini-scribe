import express from "express";
import cors from "cors";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { syncVisitToGenie } = require("./genie-sync.js");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Supabase Storage config
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const STORAGE_BUCKET = "patient-files";

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
const t = (v, max=500) => { const s = n(v); return s && s.length > max ? s.slice(0, max) : s; }; // safe truncate

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

// Convert HEIC/HEIF — not yet supported server-side
app.post("/api/convert-heic", async (req, res) => {
  res.status(400).json({ error: "HEIC not supported. Please change iPhone settings: Settings → Camera → Formats → Most Compatible" });
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
      pool.query("SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at FROM consultations WHERE patient_id=$1 ORDER BY visit_date DESC, created_at DESC", [id]),
      pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [id]),
      // Deduplicate meds: latest entry per med name, include prescribing doctor
      pool.query(`SELECT DISTINCT ON (UPPER(m.name)) m.*, c.con_name as prescriber, c.visit_date as prescribed_date, c.visit_type, c.status as con_status
        FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
        WHERE m.patient_id=$1 ORDER BY UPPER(m.name), m.created_at DESC`, [id]),
      // Deduplicate labs: distinct by test+date
      pool.query(`SELECT DISTINCT ON (test_name, test_date) * FROM lab_results
        WHERE patient_id=$1 ORDER BY test_name, test_date DESC, created_at DESC`, [id]),
      // Deduplicate diagnoses: latest status per diagnosis_id
      pool.query(`SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
        WHERE patient_id=$1 ORDER BY diagnosis_id, created_at DESC`, [id]),
      pool.query("SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, storage_path, consultation_id, created_at FROM documents WHERE patient_id=$1 ORDER BY doc_date DESC", [id]),
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
         dob=COALESCE($11,dob), address=COALESCE($12,address) WHERE id=$1`,
        [patientId, n(patient.name), int(patient.age), n(patient.sex),
         n(patient.fileNo), n(patient.abhaId), n(patient.healthId),
         n(patient.aadhaar), n(patient.govtId), n(patient.govtIdType), n(patient.dob)||null, n(patient.address)]
      );
    } else {
      const r = await client.query(
        `INSERT INTO patients (name, phone, age, sex, file_no, abha_id, health_id, aadhaar, govt_id, govt_id_type, dob, address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [n(patient.name)||'Unknown', n(patient.phone), int(patient.age), n(patient.sex),
         n(patient.fileNo), n(patient.abhaId), n(patient.healthId),
         n(patient.aadhaar), n(patient.govtId), n(patient.govtIdType), n(patient.dob)||null, n(patient.address)]
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
          [patientId, consultationId, t(d.id, 100), t(d.label, 500), t(d.status, 100) || 'New']
        );
      }
    }
    for (const m of (moData?.previous_medications || [])) {
      if (m?.name) {
        await client.query(
          `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, is_new, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,true)`,
          [patientId, consultationId, t(m.name,200), t(m._matched,200), t(m.composition,200), t(m.dose,100), t(m.frequency,100), t(m.timing,100)]
        );
      }
    }
    for (const m of (conData?.medications_confirmed || [])) {
      if (m?.name) {
        await client.query(
          `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, route, is_new, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
          [patientId, consultationId, t(m.name,200), t(m._matched,200), t(m.composition,200), t(m.dose,100), t(m.frequency,100), t(m.timing,100), t(m.route,50)||'Oral', m.isNew===true]
        );
      }
    }
    for (const inv of (moData?.investigations || [])) {
      if (inv?.test && num(inv.value) !== null && !inv.from_report) {
        const invDate = inv.date || vDate || null;
        await client.query(
          `INSERT INTO lab_results (patient_id, consultation_id, test_name, result, unit, flag, is_critical, ref_range, source, test_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scribe',COALESCE($9::date, CURRENT_DATE))`,
          [patientId, consultationId, t(inv.test,200), num(inv.value), t(inv.unit,50), t(inv.flag,50), inv.critical===true, t(inv.ref,100), invDate]
        );
      }
    }
    for (const g of (conData?.goals || [])) {
      if (g?.marker) {
        await client.query(`INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [patientId, consultationId, t(g.marker,200), t(g.current,200), t(g.target,200), t(g.timeline,200), t(g.priority,100)]);
      }
    }
    for (const c of (moData?.complications || [])) {
      if (c?.name) {
        await client.query(`INSERT INTO complications (patient_id, consultation_id, name, status, detail, severity) VALUES ($1,$2,$3,$4,$5,$6)`,
          [patientId, consultationId, t(c.name,200), t(c.status,100), t(c.detail,500), t(c.severity,100)]);
      }
    }

    await client.query("COMMIT");
    console.log(`✅ Saved: patient=${patientId} consultation=${consultationId}`);
    res.json({ success: true, patient_id: patientId, consultation_id: consultationId });

    // ── Sync to MyHealth Genie (non-blocking) ──
    const visit = {
      consultation_id: consultationId,
      patient_id: patientId,
      visit_date: vDate || new Date().toISOString().split("T")[0],
      mo_data: moData,
      con_data: conData,
      vitals,
      plan_edits: planEdits,
      // Extracted arrays for Genie sync
      medications: conData?.medications_confirmed || [],
      lab_results: moData?.investigations || [],
      diagnoses: moData?.diagnoses || [],
      goals: conData?.goals || [],
      lifestyle: conData?.diet_lifestyle || [],
      self_monitoring: conData?.self_monitoring || [],
      follow_up: conData?.follow_up || null,
      chief_complaints: moData?.chief_complaints || [],
      summary: conData?.assessment_summary || null
    };
    const doctorInfo = { con_name: conName, mo_name: moName };
    syncVisitToGenie(visit, patient, doctorInfo)
      .then(r => { if (r) console.log("📱 Genie sync:", r); })
      .catch(e => console.log("Genie sync background:", e.message));
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

// Upload file to Supabase Storage and link to document
app.post("/api/documents/:id/upload-file", async (req, res) => {
  try {
    const { base64, mediaType, fileName } = req.body;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(400).json({ error: "Storage not configured" });
    
    // Get document to find patient_id
    const doc = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!doc.rows[0]) return res.status(404).json({ error: "Document not found" });
    const patientId = doc.rows[0].patient_id;
    
    // Build storage path: patients/{patient_id}/{doc_type}/{timestamp}_{filename}
    const docType = doc.rows[0].doc_type || "other";
    const ts = Date.now();
    const storagePath = `patients/${patientId}/${docType}/${ts}_${fileName}`;
    
    // Upload to Supabase Storage
    const fileBuffer = Buffer.from(base64, "base64");
    const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": mediaType || "application/octet-stream",
        "x-upsert": "true"
      },
      body: fileBuffer
    });
    
    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      return res.status(500).json({ error: "Upload failed: " + err });
    }
    
    // Update document record with storage path
    await pool.query("UPDATE documents SET storage_path=$1, mime_type=$2 WHERE id=$3", [storagePath, mediaType, req.params.id]);
    
    res.json({ success: true, storage_path: storagePath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get signed URL to view/download a file
app.get("/api/documents/:id/file-url", async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(400).json({ error: "Storage not configured" });
    
    const doc = await pool.query("SELECT storage_path, mime_type, file_name FROM documents WHERE id=$1", [req.params.id]);
    if (!doc.rows[0]?.storage_path) return res.status(404).json({ error: "No file attached" });
    
    // Create signed URL (valid for 1 hour)
    const signResp = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${doc.rows[0].storage_path}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    
    if (!signResp.ok) return res.status(500).json({ error: "Failed to generate URL" });
    const signData = await signResp.json();
    const signedPath = signData.signedURL || signData.signedUrl || signData.token;
    
    const url = signedPath?.startsWith("http") ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`;
    res.json({ url, mime_type: doc.rows[0].mime_type, file_name: doc.rows[0].file_name });
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

    const labQ = (names) => `SELECT result, test_date, test_name FROM lab_results WHERE patient_id=$1 AND LOWER(test_name) IN (${names.map((_,i)=>`LOWER($${i+2})`).join(',')}) ${df} ORDER BY test_date, created_at DESC`;

    const [hba1c, fpg, ldl, tg, hdl, creat, egfr, uacr, tsh, ppg, alt, ast, alp, nonhdl, vitd, vitb12, ferritin, crp, bp, weight, waist, bodyFat, muscleMass] = await Promise.all([
      pool.query(labQ(['HbA1c','Glycated Hemoglobin','Glycated Haemoglobin','A1c','Hemoglobin A1c']), [id, 'HbA1c','Glycated Hemoglobin','Glycated Haemoglobin','A1c','Hemoglobin A1c']),
      pool.query(labQ(['FBS','FPG','Fasting Glucose','Fasting Blood Sugar','Fasting Plasma Glucose','FBG','Blood Sugar Fasting','Glucose Fasting']), [id, 'FBS','FPG','Fasting Glucose','Fasting Blood Sugar','Fasting Plasma Glucose','FBG','Blood Sugar Fasting','Glucose Fasting']),
      pool.query(labQ(['LDL','LDL Cholesterol','LDL-C','LDL Cholesterol (Direct)','Low Density Lipoprotein']), [id, 'LDL','LDL Cholesterol','LDL-C','LDL Cholesterol (Direct)','Low Density Lipoprotein']),
      pool.query(labQ(['Triglycerides','TG','Triglyceride','Serum Triglycerides']), [id, 'Triglycerides','TG','Triglyceride','Serum Triglycerides']),
      pool.query(labQ(['HDL','HDL Cholesterol','HDL-C','HDL Cholesterol (Direct)','High Density Lipoprotein']), [id, 'HDL','HDL Cholesterol','HDL-C','HDL Cholesterol (Direct)','High Density Lipoprotein']),
      pool.query(labQ(['Creatinine','Serum Creatinine','S. Creatinine']), [id, 'Creatinine','Serum Creatinine','S. Creatinine']),
      pool.query(labQ(['eGFR','GFR','Estimated GFR']), [id, 'eGFR','GFR','Estimated GFR']),
      pool.query(labQ(['UACR','Urine Albumin Creatinine Ratio','Microalbumin','Urine Microalbumin']), [id, 'UACR','Urine Albumin Creatinine Ratio','Microalbumin','Urine Microalbumin']),
      pool.query(labQ(['TSH','Thyroid Stimulating Hormone','TSH Ultrasensitive']), [id, 'TSH','Thyroid Stimulating Hormone','TSH Ultrasensitive']),
      pool.query(labQ(['PPBS','PP','PPG','PP Glucose','Post Prandial','Post Prandial Glucose','Post Prandial Blood Sugar','PP Blood Sugar']), [id, 'PPBS','PP','PPG','PP Glucose','Post Prandial','Post Prandial Glucose','Post Prandial Blood Sugar','PP Blood Sugar']),
      pool.query(labQ(['SGPT (ALT)','SGPT','ALT','Alanine Aminotransferase','SGPT(ALT)']), [id, 'SGPT (ALT)','SGPT','ALT','Alanine Aminotransferase','SGPT(ALT)']),
      pool.query(labQ(['SGOT (AST)','SGOT','AST','Aspartate Aminotransferase','SGOT(AST)']), [id, 'SGOT (AST)','SGOT','AST','Aspartate Aminotransferase','SGOT(AST)']),
      pool.query(labQ(['ALP','Alkaline Phosphatase']), [id, 'ALP','Alkaline Phosphatase']),
      pool.query(labQ(['Non-HDL','Non HDL','NonHDL','Non-HDL Cholesterol']), [id, 'Non-HDL','Non HDL','NonHDL','Non-HDL Cholesterol']),
      pool.query(labQ(['Vitamin D','25-OH Vitamin D','Vit D','Vitamin D3','25(OH) Vitamin D','25 Hydroxy Vitamin D']), [id, 'Vitamin D','25-OH Vitamin D','Vit D','Vitamin D3','25(OH) Vitamin D','25 Hydroxy Vitamin D']),
      pool.query(labQ(['Vitamin B12','Vit B12','B12','Cyanocobalamin']), [id, 'Vitamin B12','Vit B12','B12','Cyanocobalamin']),
      pool.query(labQ(['Ferritin','Serum Ferritin']), [id, 'Ferritin','Serum Ferritin']),
      pool.query(labQ(['CRP','C-Reactive Protein','hs-CRP']), [id, 'CRP','C-Reactive Protein','hs-CRP']),
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
      hba1c: hba1c.rows, fpg: fpg.rows, ppg: ppg.rows,
      ldl: ldl.rows, triglycerides: tg.rows, hdl: hdl.rows, nonhdl: nonhdl.rows,
      creatinine: creat.rows, egfr: egfr.rows, uacr: uacr.rows, tsh: tsh.rows,
      alt: alt.rows, ast: ast.rows, alp: alp.rows,
      vitamin_d: vitd.rows, vitamin_b12: vitb12.rows, ferritin: ferritin.rows, crp: crp.rows,
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
    const conNameStr = doctor_name ? (specialty ? `${doctor_name} (${specialty})` : doctor_name) : "Unknown";

    const con = await client.query(
      "INSERT INTO consultations (patient_id, visit_date, visit_type, con_name, status) VALUES ($1,$2,$3,$4,'historical') RETURNING id",
      [patientId, visit_date, n(visit_type)||"OPD", conNameStr]
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

// Today's summary with biomarker control rates
app.get("/api/reports/today", async (req, res) => {
  try {
    const { period = "today", doctor } = req.query;
    let dateFilter = "c.visit_date::date = CURRENT_DATE";
    if (period === "week") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '7 days'";
    else if (period === "month") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '30 days'";
    else if (period === "quarter") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '90 days'";
    else if (period === "year") dateFilter = "c.visit_date >= CURRENT_DATE - INTERVAL '365 days'";
    else if (period === "all") dateFilter = "1=1";
    const doctorFilter = doctor ? ` AND c.con_name ILIKE '%${doctor.replace(/'/g,"")}%'` : "";
    
    // Patients seen in period
    const patients = await pool.query(`
      SELECT DISTINCT ON (p.id) p.id, p.name, p.age, p.sex, p.file_no, p.phone,
        c.visit_date, c.con_name,
        (SELECT json_agg(DISTINCT jsonb_build_object('label',d.label,'status',d.status,'id',d.diagnosis_id))
         FROM (SELECT DISTINCT ON (patient_id, diagnosis_id) label, status, diagnosis_id, patient_id
               FROM diagnoses WHERE patient_id=p.id AND is_active=true ORDER BY patient_id, diagnosis_id, created_at DESC) d
        ) as diagnoses
      FROM patients p
      JOIN consultations c ON c.patient_id=p.id
      WHERE ${dateFilter}${doctorFilter}
      ORDER BY p.id, c.visit_date DESC
    `);
    
    const patientIds = patients.rows.map(p=>p.id);
    if (patientIds.length === 0) {
      return res.json({ total:0, biomarkers:[], patients:[], by_doctor:{} });
    }
    
    // Get latest lab values for ALL relevant biomarkers
    const labs = (await pool.query(`
      SELECT DISTINCT ON (patient_id, test_name) patient_id, test_name, result, unit, test_date
      FROM lab_results
      WHERE patient_id = ANY($1)
        AND test_name IN ('HbA1c','FBG','FPG','Fasting Glucose','Fasting Blood Sugar','PP','PP Glucose','Post Prandial','PPG',
                          'LDL','LDL-C','LDL Cholesterol','Triglycerides','TG','Non-HDL','Non HDL','NonHDL',
                          'eGFR','GFR','UACR','ACR','Microalbumin','Urine ACR',
                          'Creatinine','Serum Creatinine')
        AND result IS NOT NULL
      ORDER BY patient_id, test_name, test_date DESC
    `, [patientIds])).rows;
    
    // Get latest vitals (BP, BMI, Weight)
    const vitals = (await pool.query(`
      SELECT DISTINCT ON (patient_id) patient_id, bp_sys, bp_dia, bmi, weight
      FROM vitals
      WHERE patient_id = ANY($1) AND (bp_sys IS NOT NULL OR bmi IS NOT NULL OR weight IS NOT NULL)
      ORDER BY patient_id, recorded_at DESC
    `, [patientIds])).rows;
    
    // Get previous weight for trend
    const prevWeights = (await pool.query(`
      SELECT DISTINCT ON (v.patient_id) v.patient_id, v.weight, v.recorded_at
      FROM vitals v
      INNER JOIN (
        SELECT patient_id, MAX(recorded_at) as latest FROM vitals WHERE patient_id = ANY($1) AND weight IS NOT NULL GROUP BY patient_id
      ) lv ON v.patient_id=lv.patient_id AND v.recorded_at < lv.latest
      WHERE v.patient_id = ANY($1) AND v.weight IS NOT NULL
      ORDER BY v.patient_id, v.recorded_at DESC
    `, [patientIds])).rows;
    
    // Build per-patient biomarker map
    const patientBio = {};
    patientIds.forEach(id => { patientBio[id] = {}; });
    
    // Normalize lab names and map values
    labs.forEach(l => {
      const pid = l.patient_id;
      const val = parseFloat(l.result);
      if (isNaN(val)) return;
      const tn = l.test_name.toLowerCase();
      
      if (tn.includes('a1c') || tn === 'hba1c') patientBio[pid].hba1c = val;
      else if (['fbg','fpg','fasting glucose','fasting blood sugar'].includes(tn)) patientBio[pid].fbg = val;
      else if (['pp','ppg','pp glucose','post prandial'].includes(tn)) patientBio[pid].ppg = val;
      else if (['ldl','ldl-c','ldl cholesterol'].includes(tn)) patientBio[pid].ldl = val;
      else if (['tg','triglycerides'].includes(tn)) patientBio[pid].tg = val;
      else if (['non-hdl','non hdl','nonhdl'].includes(tn)) patientBio[pid].nonhdl = val;
      else if (['egfr','gfr'].includes(tn)) patientBio[pid].egfr = val;
      else if (['uacr','acr','microalbumin','urine acr'].includes(tn)) patientBio[pid].uacr = val;
      else if (['creatinine','serum creatinine'].includes(tn)) patientBio[pid].creatinine = val;
    });
    
    vitals.forEach(v => {
      const pid = v.patient_id;
      if (v.bp_sys) patientBio[pid].bp_sys = parseFloat(v.bp_sys);
      if (v.bp_dia) patientBio[pid].bp_dia = parseFloat(v.bp_dia);
      if (v.bmi) patientBio[pid].bmi = parseFloat(v.bmi);
      if (v.weight) patientBio[pid].weight = parseFloat(v.weight);
    });
    
    prevWeights.forEach(w => {
      patientBio[w.patient_id].prev_weight = parseFloat(w.weight);
    });
    
    // Define biomarker targets
    const targets = [
      { key:"hba1c", label:"HbA1c", target:"<7%", unit:"%", good:v=>v<7, warn:v=>v>=7&&v<8, emoji:"🩸" },
      { key:"fbg", label:"Fasting Glucose", target:"<130 mg/dL", unit:"mg/dL", good:v=>v<130, warn:v=>v>=130&&v<180, emoji:"🍳" },
      { key:"ppg", label:"Post-Prandial", target:"<180 mg/dL", unit:"mg/dL", good:v=>v<180, warn:v=>v>=180&&v<250, emoji:"🍽️" },
      { key:"bp", label:"Blood Pressure", target:"<130/80", unit:"mmHg", good:(v,p)=>p.bp_sys<130&&p.bp_dia<80, warn:(v,p)=>p.bp_sys>=130&&p.bp_sys<140, emoji:"💓", composite:true },
      { key:"ldl", label:"LDL", target:"<100 mg/dL", unit:"mg/dL", good:v=>v<100, warn:v=>v>=100&&v<130, emoji:"🫀" },
      { key:"tg", label:"Triglycerides", target:"<150 mg/dL", unit:"mg/dL", good:v=>v<150, warn:v=>v>=150&&v<200, emoji:"🧈" },
      { key:"nonhdl", label:"Non-HDL", target:"<130 mg/dL", unit:"mg/dL", good:v=>v<130, warn:v=>v>=130&&v<160, emoji:"🫀" },
      { key:"egfr", label:"eGFR", target:">60 mL/min", unit:"mL/min", good:v=>v>60, warn:v=>v>=45&&v<=60, emoji:"🫘" },
      { key:"uacr", label:"UACR", target:"<30 mg/g", unit:"mg/g", good:v=>v<30, warn:v=>v>=30&&v<300, emoji:"🫘" },
      { key:"bmi", label:"BMI", target:"<25", unit:"kg/m²", good:v=>v<25, warn:v=>v>=25&&v<30, emoji:"⚖️" },
      { key:"weight", label:"Weight Trend", target:"Losing/Stable", unit:"kg", good:(v,p)=>p.prev_weight&&v<=p.prev_weight, warn:(v,p)=>!p.prev_weight, emoji:"📉", trend:true }
    ];
    
    // Calculate control rates per biomarker
    const biomarkers = targets.map(t => {
      let inControl=0, outControl=0, warning=0, noData=0, tested=0;
      const patientDetails = [];
      
      patients.rows.forEach(p => {
        const bio = patientBio[p.id];
        let val, status, displayVal;
        
        if (t.composite && t.key==="bp") {
          if (bio.bp_sys && bio.bp_dia) {
            val = bio.bp_sys;
            displayVal = `${bio.bp_sys}/${bio.bp_dia}`;
            tested++;
            if (t.good(val, bio)) { status="in_control"; inControl++; }
            else if (t.warn(val, bio)) { status="warning"; warning++; }
            else { status="out_control"; outControl++; }
          } else { status="no_data"; noData++; }
        } else if (t.trend && t.key==="weight") {
          if (bio.weight) {
            val = bio.weight;
            displayVal = `${bio.weight}kg`;
            tested++;
            if (bio.prev_weight) {
              const diff = bio.weight - bio.prev_weight;
              displayVal += ` (${diff>0?"+":""}${diff.toFixed(1)})`;
              if (diff <= 0) { status="in_control"; inControl++; }
              else if (diff <= 2) { status="warning"; warning++; }
              else { status="out_control"; outControl++; }
            } else { status="no_data"; noData++; }
          } else { status="no_data"; noData++; }
        } else {
          val = bio[t.key];
          if (val !== undefined && val !== null) {
            displayVal = `${val} ${t.unit}`;
            tested++;
            if (t.good(val, bio)) { status="in_control"; inControl++; }
            else if (t.warn(val, bio)) { status="warning"; warning++; }
            else { status="out_control"; outControl++; }
          } else { status="no_data"; noData++; }
        }
        
        patientDetails.push({
          id:p.id, name:p.name, age:p.age, sex:p.sex, file_no:p.file_no,
          phone:p.phone, con_name:p.con_name, visit_date:p.visit_date,
          value:val, display:displayVal, status,
          diagnoses:p.diagnoses
        });
      });
      
      return {
        key:t.key, label:t.label, target:t.target, unit:t.unit, emoji:t.emoji,
        in_control:inControl, warning, out_control:outControl, no_data:noData,
        tested, total:patients.rows.length,
        pct: tested>0 ? Math.round(inControl/tested*100) : null,
        patients: patientDetails.sort((a,b) => {
          const order = {out_control:0, warning:1, in_control:2, no_data:3};
          return (order[a.status]||3) - (order[b.status]||3);
        })
      };
    });
    
    // Build per-patient summary (how many targets met)
    const patientSummaries = patients.rows.map(p => {
      const bio = patientBio[p.id];
      let met=0, total=0;
      const conditions = {};
      
      targets.forEach(t => {
        let val, inCtrl = false, hasData = false;
        if (t.composite && t.key==="bp") {
          if (bio.bp_sys && bio.bp_dia) { hasData=true; inCtrl=t.good(bio.bp_sys, bio); val=`${bio.bp_sys}/${bio.bp_dia}`; }
        } else if (t.trend) {
          // skip weight from target count
        } else {
          val = bio[t.key];
          if (val !== undefined && val !== null) { hasData=true; inCtrl=t.good(val, bio); }
        }
        if (hasData && !t.trend) {
          total++;
          if (inCtrl) met++;
          conditions[t.key] = { val, in_control:inCtrl, label:t.label, emoji:t.emoji, target:t.target };
        }
      });
      
      return {
        id:p.id, name:p.name, age:p.age, sex:p.sex, file_no:p.file_no,
        phone:p.phone, con_name:p.con_name, visit_date:p.visit_date,
        diagnoses:p.diagnoses,
        targets_met:met, targets_total:total,
        pct: total>0?Math.round(met/total*100):null,
        conditions, all_bio:bio
      };
    }).sort((a,b) => (a.pct===null?999:a.pct) - (b.pct===null?999:b.pct));
    
    // Doctor breakdown
    const byDoctor = {};
    patients.rows.forEach(p => {
      const d = p.con_name || "Unknown";
      byDoctor[d] = (byDoctor[d]||0) + 1;
    });
    
    res.json({
      total: patients.rows.length,
      biomarkers,
      patients: patientSummaries,
      by_doctor: byDoctor
    });
  } catch (e) { console.error("Reports error:", e); res.status(500).json({ error: e.message }); }
});

// Diagnosis distribution
app.get("/api/reports/diagnoses", async (req, res) => {
  try {
    const result = await pool.query(`
      WITH latest AS (
        SELECT DISTINCT ON (patient_id, diagnosis_id)
          patient_id, diagnosis_id, label, status
        FROM diagnoses WHERE is_active=true
        ORDER BY patient_id, diagnosis_id, created_at DESC
      )
      SELECT diagnosis_id as id, 
        (array_agg(label ORDER BY label))[1] as label,
        status, 
        COUNT(DISTINCT patient_id) as patient_count
      FROM latest
      GROUP BY diagnosis_id, status
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

// ============ CLINICAL REASONING ============
// Save clinical reasoning for a consultation
app.post("/api/consultations/:id/reasoning", async (req, res) => {
  try {
    const { patient_id, doctor_id, doctor_name, reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method } = req.body;
    const r = await pool.query(
      `INSERT INTO clinical_reasoning (consultation_id, patient_id, doctor_id, doctor_name, reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.params.id, patient_id, doctor_id||null, doctor_name, reasoning_text, primary_condition, secondary_conditions||[], reasoning_tags||[], capture_method||'text']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save reasoning standalone (no consultation yet)
app.post("/api/reasoning", async (req, res) => {
  try {
    const { patient_id, doctor_id, doctor_name, reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method, patient_context } = req.body;
    const r = await pool.query(
      `INSERT INTO clinical_reasoning (consultation_id, patient_id, doctor_id, doctor_name, reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [null, patient_id||null, doctor_id||null, doctor_name, reasoning_text + (patient_context ? "\n\n--- Context ---\n" + patient_context : ""), primary_condition, secondary_conditions||[], reasoning_tags||[], capture_method||'text']
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update clinical reasoning
app.put("/api/reasoning/:id", async (req, res) => {
  try {
    const { reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method, audio_transcript, transcription_status } = req.body;
    const r = await pool.query(
      `UPDATE clinical_reasoning SET reasoning_text=COALESCE($1,reasoning_text), primary_condition=COALESCE($2,primary_condition),
       secondary_conditions=COALESCE($3,secondary_conditions), reasoning_tags=COALESCE($4,reasoning_tags),
       capture_method=COALESCE($5,capture_method), audio_transcript=COALESCE($6,audio_transcript),
       transcription_status=COALESCE($7,transcription_status), updated_at=NOW() WHERE id=$8 RETURNING *`,
      [reasoning_text, primary_condition, secondary_conditions, reasoning_tags, capture_method, audio_transcript, transcription_status, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get clinical reasoning for a consultation
app.get("/api/consultations/:id/reasoning", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM clinical_reasoning WHERE consultation_id=$1 ORDER BY created_at DESC", [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload audio for clinical reasoning
app.post("/api/reasoning/:id/audio", async (req, res) => {
  try {
    const { base64, duration } = req.body;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(400).json({ error: "Storage not configured" });
    
    const cr = await pool.query("SELECT * FROM clinical_reasoning WHERE id=$1", [req.params.id]);
    if (!cr.rows[0]) return res.status(404).json({ error: "Not found" });
    
    const r = cr.rows[0];
    const ts = Date.now();
    const storagePath = `clinical-recordings/${r.doctor_id||"unknown"}/${new Date().toISOString().slice(0,7)}/${r.consultation_id}_${ts}.webm`;
    
    const fileBuffer = Buffer.from(base64, "base64");
    const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "audio/webm", "x-upsert": "true" },
      body: fileBuffer
    });
    
    if (!uploadResp.ok) return res.status(500).json({ error: "Upload failed: " + await uploadResp.text() });
    
    await pool.query(
      "UPDATE clinical_reasoning SET audio_url=$1, audio_duration=$2, capture_method=CASE WHEN reasoning_text IS NOT NULL AND reasoning_text!='' THEN 'both' ELSE 'audio' END, transcription_status='pending', updated_at=NOW() WHERE id=$3",
      [storagePath, duration||0, req.params.id]
    );
    
    res.json({ success: true, storage_path: storagePath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get signed URL for audio playback
app.get("/api/reasoning/:id/audio-url", async (req, res) => {
  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(400).json({ error: "Storage not configured" });
    const cr = await pool.query("SELECT audio_url FROM clinical_reasoning WHERE id=$1", [req.params.id]);
    if (!cr.rows[0]?.audio_url) return res.status(404).json({ error: "No audio" });
    
    const signResp = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${cr.rows[0].audio_url}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expiresIn: 3600 })
    });
    if (!signResp.ok) return res.status(500).json({ error: "Failed to generate URL" });
    const signData = await signResp.json();
    const signedPath = signData.signedURL || signData.signedUrl || signData.token;
    res.json({ url: signedPath?.startsWith("http") ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ RX REVIEW FEEDBACK ============
app.post("/api/consultations/:id/rx-feedback", async (req, res) => {
  try {
    const { patient_id, doctor_id, doctor_name, ai_rx_analysis, ai_model, agreement_level, feedback_text, correct_approach, reason_for_difference, disagreement_tags, primary_condition, medications_involved, severity } = req.body;
    const r = await pool.query(
      `INSERT INTO rx_review_feedback (consultation_id, patient_id, doctor_id, doctor_name, ai_rx_analysis, ai_model, agreement_level, feedback_text, correct_approach, reason_for_difference, disagreement_tags, primary_condition, medications_involved, severity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.params.id, patient_id, doctor_id||null, doctor_name, ai_rx_analysis, ai_model||'claude-sonnet-4.5', agreement_level, feedback_text, correct_approach, reason_for_difference, disagreement_tags||[], primary_condition, medications_involved||[], severity]
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get Rx feedback for a consultation
app.get("/api/consultations/:id/rx-feedback", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM rx_review_feedback WHERE consultation_id=$1 ORDER BY created_at DESC", [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upload audio for Rx feedback
app.post("/api/rx-feedback/:id/audio", async (req, res) => {
  try {
    const { base64 } = req.body;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(400).json({ error: "Storage not configured" });
    
    const fb = await pool.query("SELECT * FROM rx_review_feedback WHERE id=$1", [req.params.id]);
    if (!fb.rows[0]) return res.status(404).json({ error: "Not found" });
    
    const ts = Date.now();
    const storagePath = `rx-feedback-audio/${fb.rows[0].doctor_id||"unknown"}/${new Date().toISOString().slice(0,7)}/${fb.rows[0].consultation_id}_${ts}.webm`;
    
    const fileBuffer = Buffer.from(base64, "base64");
    const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`, "Content-Type": "audio/webm", "x-upsert": "true" },
      body: fileBuffer
    });
    if (!uploadResp.ok) return res.status(500).json({ error: "Upload failed" });
    
    await pool.query("UPDATE rx_review_feedback SET feedback_audio_url=$1 WHERE id=$2", [storagePath, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ CLINICAL INTELLIGENCE REPORT ============
app.get("/api/reports/clinical-intelligence", async (req, res) => {
  try {
    const { period } = req.query; // 'month','quarter','year','all'
    let dateFilter = "";
    if (period === "month") dateFilter = "AND created_at > NOW() - INTERVAL '1 month'";
    else if (period === "quarter") dateFilter = "AND created_at > NOW() - INTERVAL '3 months'";
    else if (period === "year") dateFilter = "AND created_at > NOW() - INTERVAL '1 year'";
    
    // Overview stats
    const [crTotal, crMonth, rxTotal, rxMonth, agreementStats, disagreementTags, weeklyTrend, doctorStats, audioHours] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM clinical_reasoning`),
      pool.query(`SELECT COUNT(*) FROM clinical_reasoning WHERE created_at > NOW() - INTERVAL '1 month'`),
      pool.query(`SELECT COUNT(*) FROM rx_review_feedback`),
      pool.query(`SELECT COUNT(*) FROM rx_review_feedback WHERE created_at > NOW() - INTERVAL '1 month'`),
      pool.query(`SELECT agreement_level, COUNT(*) as count FROM rx_review_feedback ${dateFilter ? 'WHERE 1=1 '+dateFilter : ''} GROUP BY agreement_level`),
      pool.query(`SELECT unnest(disagreement_tags) as tag, COUNT(*) as count FROM rx_review_feedback WHERE agreement_level != 'agree' ${dateFilter} GROUP BY tag ORDER BY count DESC LIMIT 10`),
      pool.query(`SELECT date_trunc('week', created_at)::date as week, agreement_level, COUNT(*) as count FROM rx_review_feedback WHERE created_at > NOW() - INTERVAL '3 months' GROUP BY week, agreement_level ORDER BY week`),
      pool.query(`SELECT doctor_name, 
        (SELECT COUNT(*) FROM clinical_reasoning cr WHERE cr.doctor_name=d.doctor_name) as reasoning_count,
        (SELECT COUNT(*) FROM rx_review_feedback rx WHERE rx.doctor_name=d.doctor_name) as rx_count
        FROM (SELECT DISTINCT doctor_name FROM clinical_reasoning UNION SELECT DISTINCT doctor_name FROM rx_review_feedback) d
        ORDER BY reasoning_count DESC`),
      pool.query(`SELECT COALESCE(SUM(audio_duration),0) as total_seconds FROM clinical_reasoning WHERE audio_url IS NOT NULL`),
    ]);
    
    // Recent clinical reasoning entries
    const reasoningFeed = await pool.query(
      `SELECT cr.*, p.name as patient_name, p.file_no FROM clinical_reasoning cr JOIN patients p ON p.id=cr.patient_id ${dateFilter ? 'WHERE 1=1 '+dateFilter : ''} ORDER BY cr.created_at DESC LIMIT 50`
    );
    
    // Recent Rx feedback entries
    const rxFeed = await pool.query(
      `SELECT rf.*, p.name as patient_name, p.file_no FROM rx_review_feedback rf JOIN patients p ON p.id=rf.patient_id ${dateFilter ? 'WHERE 1=1 '+dateFilter : ''} ORDER BY rf.created_at DESC LIMIT 50`
    );
    
    res.json({
      overview: {
        cr_total: parseInt(crTotal.rows[0].count),
        cr_month: parseInt(crMonth.rows[0].count),
        rx_total: parseInt(rxTotal.rows[0].count),
        rx_month: parseInt(rxMonth.rows[0].count),
        agreement: agreementStats.rows,
        audio_hours: Math.round(parseInt(audioHours.rows[0].total_seconds) / 3600 * 10) / 10,
      },
      disagreement_tags: disagreementTags.rows,
      weekly_trend: weeklyTrend.rows,
      doctor_stats: doctorStats.rows,
      reasoning_feed: reasoningFeed.rows,
      rx_feed: rxFeed.rows,
    });
  } catch (e) { console.error("CI Report error:", e.message); res.status(500).json({ error: e.message }); }
});

// Export clinical intelligence data as JSON
app.get("/api/reports/clinical-intelligence/export", async (req, res) => {
  try {
    const [reasoning, feedback] = await Promise.all([
      pool.query(`SELECT cr.*, p.file_no FROM clinical_reasoning cr JOIN patients p ON p.id=cr.patient_id ORDER BY cr.created_at DESC`),
      pool.query(`SELECT rf.*, p.file_no FROM rx_review_feedback rf JOIN patients p ON p.id=rf.patient_id ORDER BY rf.created_at DESC`),
    ]);
    res.json({ clinical_reasoning: reasoning.rows, rx_feedback: feedback.rows, exported_at: new Date().toISOString() });
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
