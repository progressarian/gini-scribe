import { Router } from "express";
import pool from "../config/db.js";
import { n, int } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { encryptAadhaar, decryptAadhaar } from "../utils/aadhaarCrypt.js";
import { validate } from "../middleware/validate.js";
import { patientCreateSchema } from "../schemas/index.js";

const router = Router();

// List patients with search/filter (paginated)
router.get("/patients", async (req, res) => {
  try {
    const { q, doctor, period } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    const baseSelect = `SELECT p.*,
      (SELECT COUNT(*) FROM consultations c WHERE c.patient_id=p.id) as visit_count,
      (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) as last_visit,
      (SELECT string_agg(DISTINCT d.label, ', ' ORDER BY d.label) FROM diagnoses d WHERE d.patient_id=p.id AND d.is_active=true) as diagnosis_labels,
      (SELECT con_name FROM consultations c WHERE c.patient_id=p.id ORDER BY visit_date DESC LIMIT 1) as last_doctor
      FROM patients p`;
    const baseCount = `SELECT COUNT(*) FROM patients p`;

    const conditions = [];
    const params = [];
    let idx = 1;
    if (q) {
      conditions.push(
        `(p.name ILIKE $${idx} OR p.phone LIKE $${idx} OR p.file_no ILIKE $${idx} OR p.abha_id ILIKE $${idx})`,
      );
      params.push(`%${q}%`);
      idx++;
    }
    if (doctor) {
      conditions.push(
        `EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND (
          c.con_name ILIKE $${idx} OR c.mo_name ILIKE $${idx}
          OR c.con_name IN (SELECT short_name FROM doctors WHERE name ILIKE $${idx})
          OR c.mo_name IN (SELECT short_name FROM doctors WHERE name ILIKE $${idx})
        ))`,
      );
      params.push(`%${doctor}%`);
      idx++;
    }
    if (period === "today") {
      conditions.push(
        `EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND c.visit_date::date = CURRENT_DATE)`,
      );
    } else if (period === "week") {
      conditions.push(
        `EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND c.visit_date >= CURRENT_DATE - INTERVAL '7 days')`,
      );
    } else if (period === "month") {
      conditions.push(
        `EXISTS (SELECT 1 FROM consultations c WHERE c.patient_id=p.id AND c.visit_date >= CURRENT_DATE - INTERVAL '30 days')`,
      );
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const orderBy = ` ORDER BY (SELECT MAX(visit_date) FROM consultations c WHERE c.patient_id=p.id) DESC NULLS LAST`;

    const [countResult, dataResult] = await Promise.all([
      pool.query(`${baseCount}${where}`, params),
      pool.query(`${baseSelect}${where}${orderBy} LIMIT $${idx} OFFSET $${idx + 1}`, [
        ...params,
        limit,
        offset,
      ]),
    ]);

    const total = parseInt(countResult.rows[0].count);
    res.json({
      data: dataResult.rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (e) {
    handleError(res, e, "Patient");
  }
});

// Dashboard stats
router.get("/stats", async (req, res) => {
  try {
    const [total, today, week, topDx, doctorCounts] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM patients"),
      pool.query(
        "SELECT COUNT(DISTINCT patient_id) FROM consultations WHERE visit_date::date = CURRENT_DATE",
      ),
      pool.query(
        "SELECT COUNT(DISTINCT patient_id) FROM consultations WHERE visit_date >= CURRENT_DATE - INTERVAL '7 days'",
      ),
      pool.query(
        "SELECT label, COUNT(*) as cnt FROM diagnoses WHERE is_active=true GROUP BY label ORDER BY cnt DESC LIMIT 5",
      ),
      pool.query(
        `SELECT doctor_name, COUNT(DISTINCT patient_id)::int AS patient_count
         FROM (
           SELECT con_name AS doctor_name, patient_id FROM consultations WHERE con_name IS NOT NULL AND con_name != ''
           UNION ALL
           SELECT mo_name AS doctor_name, patient_id FROM consultations WHERE mo_name IS NOT NULL AND mo_name != ''
         ) sub
         GROUP BY doctor_name ORDER BY patient_count DESC`,
      ),
    ]);
    res.json({
      total_patients: parseInt(total.rows[0].count),
      today: parseInt(today.rows[0].count),
      this_week: parseInt(week.rows[0].count),
      top_diagnoses: topDx.rows,
      doctors: doctorCounts.rows,
    });
  } catch (e) {
    handleError(res, e, "Patient");
  }
});

// Check duplicate (must be before /:id route)
router.get("/patients/check-duplicate", async (req, res) => {
  try {
    const { file_no, phone, name, age, sex } = req.query;
    let match = null;
    if (file_no)
      match = (
        await pool.query(
          "SELECT id, name, phone, file_no, age, sex FROM patients WHERE file_no=$1 LIMIT 1",
          [file_no],
        )
      ).rows[0];
    if (!match && phone)
      match = (
        await pool.query(
          "SELECT id, name, phone, file_no, age, sex FROM patients WHERE phone=$1 LIMIT 1",
          [phone],
        )
      ).rows[0];
    if (!match && name && age && sex)
      match = (
        await pool.query(
          "SELECT id, name, phone, file_no, age, sex FROM patients WHERE LOWER(name)=LOWER($1) AND age=$2 AND sex=$3 LIMIT 1",
          [name, parseInt(age), sex],
        )
      ).rows[0];
    res.json({ exists: !!match, patient: match || null });
  } catch (e) {
    handleError(res, e, "Patient");
  }
});

// Get single patient with all related data
router.get("/patients/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const patient = await pool.query("SELECT * FROM patients WHERE id=$1", [id]);
    if (!patient.rows[0]) return res.status(404).json({ error: "Not found" });

    const [consultations, vitals, meds, labs, diagnoses, docs, consultRx, goals] =
      await Promise.all([
        pool.query(
          "SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at, con_data FROM consultations WHERE patient_id=$1 ORDER BY visit_date DESC, created_at DESC",
          [id],
        ),
        pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [id]),
        pool.query(
          `WITH latest_cons AS (
        SELECT DISTINCT ON (COALESCE(con_name, mo_name, 'unknown')) id, con_name, mo_name, visit_date
        FROM consultations WHERE patient_id=$1
        ORDER BY COALESCE(con_name, mo_name, 'unknown'), visit_date DESC, created_at DESC
      )
      SELECT m.*, c.con_name as prescriber, c.visit_date as prescribed_date, c.visit_type, c.status as con_status
        FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
        WHERE m.patient_id=$1
          AND m.is_active = true
          AND (
            m.consultation_id IN (SELECT id FROM latest_cons)
            OR m.consultation_id IS NULL
          )
        ORDER BY m.created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT DISTINCT ON (test_name, test_date) * FROM lab_results
        WHERE patient_id=$1 ORDER BY test_name, test_date DESC, created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
        WHERE patient_id=$1 ORDER BY diagnosis_id, created_at DESC`,
          [id],
        ),
        pool.query(
          "SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, storage_path, consultation_id, created_at FROM documents WHERE patient_id=$1 ORDER BY doc_date DESC",
          [id],
        ),
        pool.query(
          `SELECT id, visit_date, con_name, mo_name, con_data FROM consultations WHERE patient_id=$1 AND con_data IS NOT NULL AND id NOT IN (SELECT consultation_id FROM documents WHERE patient_id=$1 AND consultation_id IS NOT NULL) ORDER BY visit_date DESC`,
          [id],
        ),
        pool.query("SELECT * FROM goals WHERE patient_id=$1 ORDER BY status, created_at DESC", [
          id,
        ]),
      ]);

    // Deduplicate consultations by visit_date+status
    const seenVisits = new Set();
    const uniqueConsultations = consultations.rows.filter((c) => {
      const key = `${c.visit_date}|${c.status}`;
      if (seenVisits.has(key)) return false;
      seenVisits.add(key);
      return true;
    });

    // Synthesize prescription docs from consultations with no document row
    const synthDocs = (consultRx.rows || [])
      .filter((c) => c.con_data && (c.con_data.medications_confirmed || []).length > 0)
      .map((c) => {
        const cd = c.con_data;
        const visitDate = c.visit_date
          ? new Date(c.visit_date.toString().slice(0, 10) + "T12:00:00").toLocaleDateString(
              "en-IN",
              { day: "2-digit", month: "short", year: "numeric" },
            )
          : "";
        return {
          id: `consult_rx_${c.id}`,
          doc_type: "prescription",
          title: `Prescription — ${c.con_name || "Dr. Bhansali"} — ${visitDate}`,
          file_name: null,
          doc_date: c.visit_date,
          source: "consultation",
          notes: null,
          storage_path: null,
          consultation_id: c.id,
          created_at: c.visit_date,
          extracted_data: {
            doctor: c.con_name || "Dr. Bhansali",
            mo: c.mo_name || null,
            date: c.visit_date,
            diagnoses: cd.diagnoses || [],
            chief_complaints: cd.chief_complaints || [],
            medications: (cd.medications_confirmed || []).map((m) => ({
              name: m.name,
              dose: m.dose,
              frequency: m.frequency,
              timing: m.timing,
              route: m.route || "Oral",
              composition: m.composition,
              forDiagnosis: m.forDiagnosis || [],
              isNew: m.isNew || false,
            })),
            goals: cd.goals || [],
            diet_lifestyle: cd.diet_lifestyle || [],
            assessment_summary: cd.assessment_summary || null,
            follow_up: cd.follow_up || null,
            investigations_ordered: cd.investigations_to_order || [],
          },
        };
      });

    // Merge and sort all docs by date newest first
    const allDocs = [...docs.rows, ...synthDocs].sort((a, b) => {
      const da = a.doc_date ? new Date(a.doc_date) : new Date(0);
      const db = b.doc_date ? new Date(b.doc_date) : new Date(0);
      return db - da;
    });

    const patientData = patient.rows[0];
    if (patientData.aadhaar) patientData.aadhaar = decryptAadhaar(patientData.aadhaar);

    res.json({
      ...patientData,
      consultations: uniqueConsultations,
      vitals: vitals.rows,
      medications: meds.rows,
      lab_results: labs.rows,
      diagnoses: diagnoses.rows,
      documents: allDocs,
      goals: goals.rows,
    });
  } catch (e) {
    handleError(res, e, "Patient detail");
  }
});

// Create or update patient
router.post("/patients", validate(patientCreateSchema), async (req, res) => {
  try {
    const p = req.body;
    let existing = null;
    if (n(p.phone))
      existing = (await pool.query("SELECT id FROM patients WHERE phone=$1", [p.phone])).rows[0];
    if (!existing && n(p.file_no))
      existing = (await pool.query("SELECT id FROM patients WHERE file_no=$1", [p.file_no]))
        .rows[0];
    if (!existing && n(p.abha_id))
      existing = (await pool.query("SELECT id FROM patients WHERE abha_id=$1", [p.abha_id]))
        .rows[0];

    if (existing) {
      const result = await pool.query(
        `UPDATE patients SET name=COALESCE($2,name), dob=COALESCE($3,dob), age=COALESCE($4,age),
         sex=COALESCE($5,sex), file_no=COALESCE($6,file_no), abha_id=COALESCE($7,abha_id),
         health_id=COALESCE($8,health_id), aadhaar=COALESCE($9,aadhaar),
         govt_id=COALESCE($10,govt_id), govt_id_type=COALESCE($11,govt_id_type),
         email=COALESCE($12,email), phone=COALESCE($13,phone)
         WHERE id=$1 RETURNING *`,
        [
          existing.id,
          n(p.name),
          n(p.dob) || null,
          int(p.age),
          n(p.sex),
          n(p.file_no),
          n(p.abha_id),
          n(p.health_id),
          encryptAadhaar(n(p.aadhaar)),
          n(p.govt_id),
          n(p.govt_id_type),
          n(p.email),
          n(p.phone),
        ],
      );
      const row = result.rows[0];
      if (row.aadhaar) row.aadhaar = decryptAadhaar(row.aadhaar);
      res.json({ ...row, _isNew: false });
    } else {
      const result = await pool.query(
        `INSERT INTO patients (name, phone, dob, age, sex, file_no, abha_id, health_id, aadhaar, govt_id, govt_id_type, email, address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [
          n(p.name),
          n(p.phone),
          n(p.dob) || null,
          int(p.age),
          n(p.sex),
          n(p.file_no),
          n(p.abha_id),
          n(p.health_id),
          encryptAadhaar(n(p.aadhaar)),
          n(p.govt_id),
          n(p.govt_id_type),
          n(p.email),
          n(p.address),
        ],
      );
      const row = result.rows[0];
      if (row.aadhaar) row.aadhaar = decryptAadhaar(row.aadhaar);
      res.json({ ...row, _isNew: true });
    }
  } catch (e) {
    handleError(res, e, "Patient");
  }
});

// Update patient by ID
router.put("/patients/:id", validate(patientCreateSchema), async (req, res) => {
  try {
    const p = req.body;
    const result = await pool.query(
      `UPDATE patients SET name=COALESCE($2,name), dob=COALESCE($3,dob), age=COALESCE($4,age),
       sex=COALESCE($5,sex), file_no=COALESCE($6,file_no), abha_id=COALESCE($7,abha_id),
       health_id=COALESCE($8,health_id), aadhaar=COALESCE($9,aadhaar),
       govt_id=COALESCE($10,govt_id), govt_id_type=COALESCE($11,govt_id_type),
       email=COALESCE($12,email), phone=COALESCE($13,phone), address=COALESCE($14,address),
       updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [
        req.params.id,
        n(p.name),
        n(p.dob) || null,
        int(p.age),
        n(p.sex),
        n(p.file_no),
        n(p.abha_id),
        n(p.health_id),
        encryptAadhaar(n(p.aadhaar)),
        n(p.govt_id),
        n(p.govt_id_type),
        n(p.email),
        n(p.phone),
        n(p.address),
      ],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Patient not found" });
    const row = result.rows[0];
    if (row.aadhaar) row.aadhaar = decryptAadhaar(row.aadhaar);
    res.json(row);
  } catch (e) {
    handleError(res, e, "Patient update");
  }
});

export default router;
