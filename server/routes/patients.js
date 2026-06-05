import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcrypt";
import pool from "../config/db.js";
import { n, int } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
import { encryptAadhaar, decryptAadhaar } from "../utils/aadhaarCrypt.js";
import { validate } from "../middleware/validate.js";
import { patientCreateSchema } from "../schemas/index.js";
import { requireDoctor } from "../middleware/auth.js";
import { getGenieDb } from "../services/genieImport.js";
import {
  lookupGeniePatientsByPhone,
  convertGeniePatientByPhone,
  convertGeniePatientById,
} from "../services/genieImport.js";
import { propagateToAllRows } from "./patientAuth.js";

// Outbound Genie sync removed (2026-05-01): patients live in exactly one DB
// (this scribe Postgres OR the Genie Supabase), and the patient app picks the
// right one at login. See server/services/genieImport.js for the one-shot
// import used when reception converts a Genie-only patient into a gini patient.

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
      const trimmed = String(q).trim();
      // Exact-match short-circuit: file_no/phone/abha_id are unique identifiers,
      // so a full paste of one should return only that patient (not substring matches).
      const exactHit = await pool.query(
        `SELECT 1 FROM patients WHERE file_no = $1 OR phone = $1 OR abha_id = $1 LIMIT 1`,
        [trimmed],
      );
      if (exactHit.rowCount > 0) {
        conditions.push(`(p.file_no = $${idx} OR p.phone = $${idx} OR p.abha_id = $${idx})`);
        params.push(trimmed);
        idx++;
      } else {
        conditions.push(
          `(p.name ILIKE $${idx} OR p.phone LIKE $${idx} OR p.file_no ILIKE $${idx} OR p.abha_id ILIKE $${idx}
            OR EXISTS (
              SELECT 1 FROM appointments a
               WHERE a.patient_id = p.id
                 AND (a.file_no ILIKE $${idx} OR a.patient_name ILIKE $${idx} OR a.phone LIKE $${idx})
            ))`,
        );
        params.push(`%${trimmed}%`);
        idx++;
      }
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
    const { file_no, name, age, sex } = req.query;
    let match = null;
    if (file_no)
      match = (
        await pool.query(
          "SELECT id, name, phone, file_no, age, sex FROM patients WHERE file_no=$1 LIMIT 1",
          [file_no],
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
// Fast-path orphan cleanup: when a user refreshes mid-upload, the doc row
// exists with extraction_status=pending but no file. We don't want the
// doctor to see a ghost "Extracting…" row for up to 3 min (cron cycle).
// Running a tiny DELETE here — scoped to this patient and older than 45s
// so in-flight uploads aren't touched — makes the ghost disappear on
// the next GET. Side-effect on a read is intentional and cheap.
async function cleanOrphanDocsForPatient(patientId) {
  try {
    await pool.query(
      `DELETE FROM documents
       WHERE patient_id = $1
         AND extracted_data->>'extraction_status' = 'pending'
         AND COALESCE(storage_path, '') = ''
         AND COALESCE(file_url, '') = ''
         AND created_at < NOW() - INTERVAL '45 seconds'`,
      [patientId],
    );
  } catch (e) {
    console.warn(`[OrphanClean] Patient ${patientId} cleanup failed:`, e.message);
  }
}

router.get("/patients/genie-lookup", async (req, res) => {
  try {
    const phone = String(req.query.phone || "").trim();
    if (!phone) return res.status(400).json({ error: "phone required" });
    const rows = await lookupGeniePatientsByPhone(phone);
    res.json({
      found: rows.length > 0,
      candidates: rows.map((p) => ({
        id: p.id,
        name: p.name,
        phone: p.phone,
        dob: p.dob,
        sex: p.sex,
        blood_group: p.blood_group,
        email: p.email,
        created_at: p.created_at,
      })),
    });
  } catch (e) {
    handleError(res, e, "Genie lookup");
  }
});

router.get("/patients/:id", async (req, res) => {
  cleanOrphanDocsForPatient(req.params.id).catch(() => {});
  try {
    const { id } = req.params;
    const patient = await pool.query("SELECT * FROM patients WHERE id=$1", [id]);
    if (!patient.rows[0]) return res.status(404).json({ error: "Not found" });

    const [consultations, vitals, meds, labs, diagnoses, docs, consultRx, goals, latestAppt] =
      await Promise.all([
        pool.query(
          `WITH cons AS (
             SELECT id, visit_date, visit_type, mo_name, con_name, status, created_at, con_data,
                    'consultation' AS source_type
             FROM consultations WHERE patient_id=$1
           ),
           appts AS (
             SELECT id, appointment_date AS visit_date, visit_type,
                    NULL AS mo_name, doctor_name AS con_name, status, created_at, NULL::jsonb AS con_data,
                    'appointment' AS source_type
             FROM appointments WHERE patient_id=$1 AND healthray_id IS NOT NULL AND appointment_date IS NOT NULL
           ),
           deduped AS (
             SELECT * FROM cons
             UNION ALL
             SELECT a.* FROM appts a
             WHERE NOT EXISTS (SELECT 1 FROM cons c WHERE c.visit_date::date = a.visit_date::date)
           )
           SELECT * FROM deduped ORDER BY visit_date DESC, created_at DESC`,
          [id],
        ),
        pool.query("SELECT * FROM vitals WHERE patient_id=$1 ORDER BY recorded_at DESC", [id]),
        pool.query(
          `WITH latest_cons AS (
        SELECT DISTINCT ON (COALESCE(con_name, mo_name, 'unknown')) id, con_name, mo_name, visit_date
        FROM consultations WHERE patient_id=$1
        ORDER BY COALESCE(con_name, mo_name, 'unknown'), visit_date DESC, created_at DESC
      )
      SELECT m.*, c.con_name as prescriber, COALESCE(c.visit_date, m.started_date) as prescribed_date, c.visit_type, c.status as con_status
        FROM medications m LEFT JOIN consultations c ON c.id = m.consultation_id
        WHERE m.patient_id=$1
          AND m.is_active = true
          AND (
            m.consultation_id IN (SELECT id FROM latest_cons)
            OR m.consultation_id IS NULL
          )
        ORDER BY COALESCE(c.visit_date, m.started_date) DESC, m.created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT DISTINCT ON (COALESCE(canonical_name, test_name), test_date::date) * FROM lab_results
        WHERE patient_id=$1 ORDER BY COALESCE(canonical_name, test_name), test_date::date DESC, created_at DESC`,
          [id],
        ),
        pool.query(
          `SELECT DISTINCT ON (diagnosis_id) * FROM diagnoses
        WHERE patient_id=$1 ORDER BY diagnosis_id, is_active DESC, updated_at DESC`,
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
        pool.query(
          `SELECT healthray_investigations, healthray_follow_up, compliance, biomarkers
           FROM appointments WHERE patient_id=$1 AND healthray_clinical_notes IS NOT NULL
           ORDER BY appointment_date DESC LIMIT 1`,
          [id],
        ),
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

    // Merge and sort all docs by date newest first. Mismatch-review docs are
    // returned as-is — doctor-facing UIs surface them with a "Needs review"
    // flag and skip their extracted fields; companion UIs render the
    // Accept/Reject banner.
    const allDocs = [...docs.rows, ...synthDocs].sort((a, b) => {
      const da = a.doc_date ? new Date(a.doc_date) : new Date(0);
      const db = b.doc_date ? new Date(b.doc_date) : new Date(0);
      return db - da;
    });

    const patientData = patient.rows[0];
    if (patientData.aadhaar) patientData.aadhaar = decryptAadhaar(patientData.aadhaar);

    const apptPlan = latestAppt.rows[0] || null;
    const apptCompliance = apptPlan?.compliance || {};
    const apptBiomarkers = apptPlan?.biomarkers || {};
    const followUpDate =
      apptPlan?.healthray_follow_up ||
      (apptBiomarkers.followup
        ? { date: apptBiomarkers.followup, notes: null, timing: null }
        : null);

    res.json({
      ...patientData,
      consultations: uniqueConsultations,
      vitals: vitals.rows,
      medications: meds.rows,
      lab_results: labs.rows,
      diagnoses: sortDiagnoses(diagnoses.rows),
      documents: allDocs,
      goals: goals.rows,
      appt_plan: apptPlan
        ? {
            investigations_to_order: (apptPlan.healthray_investigations || []).map((t) =>
              typeof t === "string" ? { name: t, urgency: "routine" } : t,
            ),
            follow_up: followUpDate,
            diet_lifestyle: [
              apptCompliance.diet,
              apptCompliance.exercise,
              apptCompliance.stress,
            ].filter(Boolean),
          }
        : null,
    });

    // Note: the per-patient sync from Genie is handled by GET /api/visit/:id
    // (with a 30s throttle). Running it here too made the server log spam
    // `📲 Auto-sync patient` on every sidebar/care-team fetch.
  } catch (e) {
    handleError(res, e, "Patient detail");
  }
});

// Create or update patient
router.post("/patients", validate(patientCreateSchema), async (req, res) => {
  try {
    const p = req.body;
    let existing = null;
    if (n(p.file_no))
      existing = (await pool.query("SELECT id FROM patients WHERE file_no=$1", [p.file_no]))
        .rows[0];
    if (!existing && n(p.abha_id))
      existing = (await pool.query("SELECT id FROM patients WHERE abha_id=$1", [p.abha_id]))
        .rows[0];

    // Auto-generate file_no if not provided and creating a new patient
    if (!existing && !n(p.file_no)) {
      const seq = await pool.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(file_no FROM 'GNI-([0-9]+)') AS INTEGER)), 0) + 1 AS next
         FROM patients WHERE file_no ~ '^GNI-[0-9]+$'`,
      );
      p.file_no = `GNI-${String(seq.rows[0].next).padStart(5, "0")}`;
    }

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

// Convert a Genie patient into scribe (one-shot import). Pass `genie_id`
// (preferred — disambiguates when multiple app rows share a phone) or
// `phone` (legacy, picks the first non-migrated match). Idempotent on the
// patient row; safe to retry if it failed mid-import.
router.post("/patients/convert-from-genie", async (req, res) => {
  try {
    const genieId = req.body?.genie_id ? String(req.body.genie_id).trim() : null;
    const phone = req.body?.phone ? String(req.body.phone).trim() : null;
    if (!genieId && !phone) {
      return res.status(400).json({ error: "genie_id or phone required" });
    }
    const result = genieId
      ? await convertGeniePatientById(genieId)
      : await convertGeniePatientByPhone(phone);
    if (!result.ok) {
      const status =
        result.reason === "no_genie_patient_for_id" ||
        result.reason === "no_genie_patient_for_phone"
          ? 404
          : 409;
      return res.status(status).json(result);
    }
    res.json(result);
  } catch (e) {
    handleError(res, e, "Convert from genie");
  }
});

// ── POST /patients/:id/reset-app-password ──────────────────────────────────
// Doctor-only. Generates a random temp password for the patient's app login,
// stores its bcrypt hash, flips `force_password_reset` so the app forces a
// password change on next login, and returns the temp password ONCE.
// Staff reads it to the patient verbally.
router.post("/patients/:id/reset-app-password", requireDoctor, async (req, res) => {
  try {
    const scribeId = Number(req.params.id);
    if (!Number.isInteger(scribeId) || scribeId <= 0) {
      return res.status(400).json({ error: "Invalid patient id" });
    }
    const { rows } = await pool.query("SELECT id, phone FROM patients WHERE id=$1", [scribeId]);
    const hospitalPatient = rows[0];
    if (!hospitalPatient) return res.status(404).json({ error: "Patient not found" });
    if (!hospitalPatient.phone) {
      return res.status(400).json({ error: "Patient has no phone — cannot manage app password." });
    }

    // The patient may have signed up on the app DB first, before the doctor
    // intake. Reset the password on whichever DB owns their auth row.
    let db = "hospital";
    let appRow = null;
    const sb = getGenieDb();
    if (sb) {
      const variants = [
        hospitalPatient.phone,
        hospitalPatient.phone.replace(/\D/g, ""),
        hospitalPatient.phone.replace(/^\+/, ""),
      ];
      const r = await sb
        .from("patients")
        .select("*")
        .in("phone", Array.from(new Set(variants)))
        .eq("migrated_to_gini", false)
        .limit(1);
      appRow = r.data?.[0] || null;
    }
    if (appRow) db = "app";

    // 8-char URL-safe random temp password — enough entropy, easy to read out.
    const tempPassword = crypto.randomBytes(6).toString("base64").replace(/[+/=]/g, "").slice(0, 8);
    const hash = await bcrypt.hash(tempPassword, 10);

    if (db === "hospital") {
      await pool.query(
        `UPDATE patients
            SET password_hash=$1,
                force_password_reset=TRUE,
                verification_token=NULL,
                verification_token_expires_at=NULL,
                otp_code=NULL,
                otp_expires_at=NULL
          WHERE id=$2`,
        [hash, hospitalPatient.id],
      );
    } else {
      const { error } = await sb
        .from("patients")
        .update({
          password_hash: hash,
          force_password_reset: true,
          verification_token: null,
          verification_token_expires_at: null,
          otp_code: null,
          otp_expires_at: null,
        })
        .eq("id", appRow.id);
      if (error) throw new Error(`App DB update failed: ${error.message}`);
    }

    // Mirror the temp password + force-reset flag to every other row
    // sharing this phone (across both DBs) so the patient can sign in
    // regardless of which record auth resolves to next time.
    await propagateToAllRows(hospitalPatient.phone, {
      password_hash: hash,
      force_password_reset: true,
    });

    // Revoke all existing patient sessions for this account so the old
    // password / old token stop working immediately.
    const ref = db === "hospital" ? String(hospitalPatient.id) : String(appRow.id);
    await pool
      .query("DELETE FROM auth_sessions WHERE patient_db=$1 AND patient_ref=$2", [db, ref])
      .catch(() => {});

    res.json({
      ok: true,
      db,
      temp_password: tempPassword,
      message:
        "Read this password to the patient. They will be required to set a new password on next login. This password will not be shown again.",
    });
  } catch (e) {
    handleError(res, e, "Reset app password");
  }
});

export default router;
