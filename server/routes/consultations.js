import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";
import { n, num, int, safeJson, t } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { getCanonical } from "../utils/labCanonical.js";
import { encryptAadhaar } from "../utils/aadhaarCrypt.js";
import { validate } from "../middleware/validate.js";
import { consultationCreateSchema, historyCreateSchema } from "../schemas/index.js";

const require = createRequire(import.meta.url);
let syncVisitToGenie = null;
try {
  syncVisitToGenie = require("../genie-sync.cjs").syncVisitToGenie;
} catch (e) {
  console.log("genie-sync.js not found — Genie sync disabled");
}

let syncPatientLogsFromGenie = null;
try {
  syncPatientLogsFromGenie = require("../genie-sync.cjs").syncPatientLogsFromGenie;
} catch (e) {
  console.log("Genie reverse sync not available");
}

const router = Router();

// Idempotent migration — add exam_data column if not present
pool.query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS exam_data JSONB`).catch(() => {});

// Save consultation (full visit)
router.post("/consultations", validate(consultationCreateSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const {
      patient,
      vitals,
      moData,
      conData,
      moTranscript,
      conTranscript,
      quickTranscript,
      moName,
      conName,
      planEdits,
      moDoctorId,
      conDoctorId,
      visitDate,
      examData,
      examNotes,
      examSummary,
    } = req.body;

    let patientId,
      existing = null;
    if (n(patient.phone))
      existing = (await client.query("SELECT id FROM patients WHERE phone=$1", [patient.phone]))
        .rows[0];
    if (!existing && n(patient.fileNo))
      existing = (await client.query("SELECT id FROM patients WHERE file_no=$1", [patient.fileNo]))
        .rows[0];
    if (!existing && n(patient.name) && patient.age && patient.sex) {
      existing = (
        await client.query(
          "SELECT id FROM patients WHERE LOWER(name)=LOWER($1) AND age=$2 AND sex=$3 LIMIT 1",
          [patient.name, int(patient.age), patient.sex],
        )
      ).rows[0];
    }

    if (existing) {
      patientId = existing.id;
      await client.query(
        `UPDATE patients SET name=COALESCE($2,name), age=COALESCE($3,age), sex=COALESCE($4,sex),
         file_no=COALESCE($5,file_no), abha_id=COALESCE($6,abha_id),
         health_id=COALESCE($7,health_id), aadhaar=COALESCE($8,aadhaar),
         govt_id=COALESCE($9,govt_id), govt_id_type=COALESCE($10,govt_id_type),
         dob=COALESCE($11,dob), address=COALESCE($12,address) WHERE id=$1`,
        [
          patientId,
          n(patient.name),
          int(patient.age),
          n(patient.sex),
          n(patient.fileNo),
          n(patient.abhaId),
          n(patient.healthId),
          encryptAadhaar(n(patient.aadhaar)),
          n(patient.govtId),
          n(patient.govtIdType),
          n(patient.dob) || null,
          n(patient.address),
        ],
      );
    } else {
      const r = await client.query(
        `INSERT INTO patients (name, phone, age, sex, file_no, abha_id, health_id, aadhaar, govt_id, govt_id_type, dob, address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          n(patient.name) || "Unknown",
          n(patient.phone),
          int(patient.age),
          n(patient.sex),
          n(patient.fileNo),
          n(patient.abhaId),
          n(patient.healthId),
          encryptAadhaar(n(patient.aadhaar)),
          n(patient.govtId),
          n(patient.govtIdType),
          n(patient.dob) || null,
          n(patient.address),
        ],
      );
      patientId = r.rows[0].id;
    }

    const vDate = n(visitDate) || null;
    const effectiveDate = vDate || new Date().toISOString().split("T")[0];

    let consultationId;
    {
      // Always create a new consultation row
      const examDataJson = examData
        ? safeJson({ findings: examData, notes: examNotes || null, summary: examSummary || null })
        : null;
      const con = await client.query(
        `INSERT INTO consultations (patient_id, visit_date, mo_name, con_name, mo_transcript, con_transcript, quick_transcript, mo_data, con_data, plan_edits, status, mo_doctor_id, con_doctor_id, exam_data)
         VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12,$13) RETURNING id`,
        [
          patientId,
          effectiveDate,
          n(moName),
          n(conName),
          n(moTranscript),
          n(conTranscript),
          n(quickTranscript),
          safeJson(moData),
          safeJson(conData),
          safeJson(planEdits),
          int(moDoctorId),
          int(conDoctorId),
          examDataJson,
        ],
      );
      consultationId = con.rows[0].id;
    }

    // Audit log
    const doctorId = req.doctor?.doctor_id || int(conDoctorId) || int(moDoctorId);
    if (doctorId) {
      await client
        .query(
          "INSERT INTO audit_log (doctor_id, action, entity_type, entity_id, details) VALUES ($1, 'save_consultation', 'consultation', $2, $3)",
          [
            doctorId,
            consultationId,
            JSON.stringify({ patient_id: patientId, patient_name: patient.name }),
          ],
        )
        .catch(() => {});
    }

    if (vitals && (num(vitals.bp_sys) || num(vitals.weight))) {
      await client.query(
        `INSERT INTO vitals (patient_id, consultation_id, bp_sys, bp_dia, pulse, temp, spo2, weight, height, bmi, waist, body_fat, muscle_mass, recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,COALESCE($14::timestamptz, NOW()))`,
        [
          patientId,
          consultationId,
          num(vitals.bp_sys),
          num(vitals.bp_dia),
          num(vitals.pulse),
          num(vitals.temp),
          num(vitals.spo2),
          num(vitals.weight),
          num(vitals.height),
          num(vitals.bmi),
          num(vitals.waist),
          num(vitals.body_fat),
          num(vitals.muscle_mass),
          vDate,
        ],
      );
    }

    for (const d of moData?.diagnoses || []) {
      if (d?.id && d?.label) {
        await client.query(
          `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (patient_id, diagnosis_id) DO UPDATE SET consultation_id = EXCLUDED.consultation_id, label = EXCLUDED.label, status = EXCLUDED.status, updated_at = NOW()`,
          [patientId, consultationId, t(d.id, 100), t(d.label, 500), t(d.status, 100) || "New"],
        );
      }
    }
    // previous_medications = meds the patient was on but stopped or changed
    // (per parser.js the AI emits status: "stopped"/"changed"). They must NOT
    // land in the active list. Two steps:
    //   1) If a matching active row exists (e.g. carried over from a prior
    //      visit or HealthRay sync), flip it to inactive and record why.
    //   2) Upsert a historical record into the inactive partial index so the
    //      doctor still sees the med in the patient's history.
    for (const m of moData?.previous_medications || []) {
      if (!m?.name) continue;
      const stopReason = t(m.reason || m.status, 200);
      await client.query(
        `UPDATE medications
            SET is_active   = false,
                stopped_date = COALESCE(stopped_date, CURRENT_DATE),
                stop_reason  = COALESCE(stop_reason, $3),
                updated_at   = NOW()
          WHERE patient_id = $1
            AND UPPER(COALESCE(pharmacy_match, name)) = UPPER(COALESCE($2, $4))
            AND is_active = true`,
        [patientId, t(m._matched, 200), stopReason, t(m.name, 200)],
      );
      await client.query(
        `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, stop_reason, stopped_date, is_new, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,CURRENT_DATE,false,false)
         ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
         DO UPDATE SET consultation_id = EXCLUDED.consultation_id,
           composition = COALESCE(EXCLUDED.composition, medications.composition),
           dose = COALESCE(EXCLUDED.dose, medications.dose),
           frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
           timing = COALESCE(EXCLUDED.timing, medications.timing),
           stop_reason = COALESCE(EXCLUDED.stop_reason, medications.stop_reason),
           stopped_date = COALESCE(medications.stopped_date, CURRENT_DATE),
           updated_at = NOW()`,
        [
          patientId,
          consultationId,
          t(m.name, 200),
          t(m._matched, 200),
          t(m.composition, 200),
          t(m.dose, 100),
          t(m.frequency, 100),
          t(m.timing, 100),
          stopReason,
        ],
      );
    }
    for (const m of conData?.medications_confirmed || []) {
      if (m?.name) {
        await client.query(
          `INSERT INTO medications (patient_id, consultation_id, name, pharmacy_match, composition, dose, frequency, timing, route, is_new, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
           DO UPDATE SET consultation_id = EXCLUDED.consultation_id,
             pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
             composition = COALESCE(EXCLUDED.composition, medications.composition),
             dose = COALESCE(EXCLUDED.dose, medications.dose),
             frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
             timing = COALESCE(EXCLUDED.timing, medications.timing),
             route = COALESCE(EXCLUDED.route, medications.route),
             is_new = EXCLUDED.is_new,
             updated_at = NOW()`,
          [
            patientId,
            consultationId,
            t(m.name, 200),
            t(m._matched, 200),
            t(m.composition, 200),
            t(m.dose, 100),
            t(m.frequency, 100),
            t(m.timing, 100),
            t(m.route, 50) || "Oral",
            m.isNew === true,
          ],
        );
      }
    }
    await client.query(`DELETE FROM lab_results WHERE consultation_id=$1 AND source='scribe'`, [
      consultationId,
    ]);
    for (const inv of moData?.investigations || []) {
      if (inv?.test && num(inv.value) !== null && !inv.from_report) {
        const invDate = inv.date || vDate || null;
        await client.query(
          `INSERT INTO lab_results (patient_id, consultation_id, test_name, canonical_name, result, unit, flag, is_critical, ref_range, source, test_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'scribe',COALESCE($10::date, CURRENT_DATE))`,
          [
            patientId,
            consultationId,
            t(inv.test, 200),
            getCanonical(inv.test),
            num(inv.value),
            t(inv.unit, 50),
            t(inv.flag, 50),
            inv.critical === true,
            t(inv.ref, 100),
            invDate,
          ],
        );
      }
    }
    for (const g of conData?.goals || []) {
      if (g?.marker) {
        await client.query(
          `INSERT INTO goals (patient_id, consultation_id, marker, current_value, target_value, timeline, priority) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            patientId,
            consultationId,
            t(g.marker, 200),
            t(g.current, 200),
            t(g.target, 200),
            t(g.timeline, 200),
            t(g.priority, 100),
          ],
        );
      }
    }
    for (const c of moData?.complications || []) {
      if (c?.name) {
        await client.query(
          `INSERT INTO complications (patient_id, consultation_id, name, status, detail, severity) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            patientId,
            consultationId,
            t(c.name, 200),
            t(c.status, 100),
            t(c.detail, 500),
            t(c.severity, 100),
          ],
        );
      }
    }

    // Auto-stop previous meds from same doctor not in new plan
    if ((conData?.medications_confirmed || []).length > 0 && n(conName)) {
      const newMedNames = (conData.medications_confirmed || []).map((m) =>
        (m.name || "").toUpperCase().replace(/\s+/g, ""),
      );
      const prevMeds = (
        await client.query(
          `SELECT id, name FROM medications WHERE patient_id=$1 AND consultation_id != $2 AND is_active=true
         AND consultation_id IN (SELECT id FROM consultations WHERE patient_id=$1 AND con_name=$3)`,
          [patientId, consultationId, conName],
        )
      ).rows;
      const toStop = prevMeds.filter(
        (m) => !newMedNames.includes((m.name || "").toUpperCase().replace(/\s+/g, "")),
      );
      if (toStop.length > 0) {
        await client.query(`UPDATE medications SET is_active=false WHERE id = ANY($1::int[])`, [
          toStop.map((m) => m.id),
        ]);
        console.log(
          `  ↳ Auto-stopped ${toStop.length} previous meds from ${conName}: ${toStop.map((m) => m.name).join(", ")}`,
        );
      }
    }

    await client.query("COMMIT");
    console.log(`✅ Saved: patient=${patientId} consultation=${consultationId}`);
    res.json({ success: true, patient_id: patientId, consultation_id: consultationId });

    // Auto-mark today's appointment as completed (non-blocking)
    pool
      .query(
        `UPDATE appointments SET status='completed', updated_at=NOW()
       WHERE patient_id=$1 AND appointment_date=CURRENT_DATE AND status='scheduled'`,
        [patientId],
      )
      .catch(() => {});

    // Sync to MyHealth Genie (non-blocking)
    const visit = {
      consultation_id: consultationId,
      patient_id: patientId,
      visit_date: vDate || new Date().toISOString().split("T")[0],
      mo_data: moData,
      con_data: conData,
      vitals,
      plan_edits: planEdits,
      medications: conData?.medications_confirmed || [],
      lab_results: moData?.investigations || [],
      diagnoses: moData?.diagnoses || [],
      goals: conData?.goals || [],
      lifestyle: conData?.diet_lifestyle || [],
      self_monitoring: conData?.self_monitoring || [],
      follow_up: conData?.follow_up || null,
      follow_up_date: conData?.follow_up?.date || conData?.follow_up_date || null,
      follow_up_instructions: conData?.follow_up?.notes || conData?.follow_up?.instructions || null,
      chief_complaints: moData?.chief_complaints || [],
      summary: conData?.assessment_summary || null,
    };
    const doctorInfo = { con_name: conName, mo_name: moName };
    const syncPatient = { ...patient, id: patientId, file_no: patient.fileNo };
    if (syncVisitToGenie)
      syncVisitToGenie(visit, syncPatient, doctorInfo)
        .then((r) => {
          if (r) console.log("📱 Genie sync:", r);

          if (syncPatientLogsFromGenie) {
            syncPatientLogsFromGenie(patientId, pool)
              .then((res) => {
                if (res) console.log("📲 Genie logs sync:", res);
              })
              .catch((e) => console.log("Genie logs sync background:", e.message));
          }
        })
        .catch((e) => console.log("Genie sync background:", e.message));
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Save error:", e.message, e.detail || "");
    handleError(res, e, "Consultation");
  } finally {
    client.release();
  }
});

// Get single consultation
router.get("/consultations/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, p.name as patient_name, p.age, p.sex, p.phone, p.file_no
       FROM consultations c JOIN patients p ON p.id = c.patient_id WHERE c.id=$1`,
      [req.params.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Consultation get");
  }
});

// History import
router.post("/patients/:id/history", validate(historyCreateSchema), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const patientId = req.params.id;
    const { visit_date, visit_type, doctor_name, specialty, vitals, diagnoses, medications, labs } =
      req.body;
    const conNameStr = doctor_name
      ? specialty
        ? `${doctor_name} (${specialty})`
        : doctor_name
      : "Unknown";

    const con = await client.query(
      "INSERT INTO consultations (patient_id, visit_date, visit_type, con_name, status) VALUES ($1,$2,$3,$4,'historical') RETURNING id",
      [patientId, visit_date, n(visit_type) || "OPD", conNameStr],
    );
    const cid = con.rows[0].id;

    if (vitals && Object.keys(vitals).length > 0) {
      await client.query(
        "INSERT INTO vitals (patient_id, consultation_id, recorded_at, bp_sys, bp_dia, pulse, weight, height, bmi, waist, body_fat, muscle_mass) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          patientId,
          cid,
          visit_date,
          num(vitals.bp_sys),
          num(vitals.bp_dia),
          num(vitals.pulse),
          num(vitals.weight),
          num(vitals.height),
          num(vitals.bmi),
          num(vitals.waist),
          num(vitals.body_fat),
          num(vitals.muscle_mass),
        ],
      );
    }

    for (const d of diagnoses || []) {
      if (d && (d.id || d.label)) {
        await client.query(
          `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (patient_id, diagnosis_id) DO UPDATE SET
             consultation_id = EXCLUDED.consultation_id,
             label = EXCLUDED.label,
             status = EXCLUDED.status,
             updated_at = NOW()`,
          [
            patientId,
            cid,
            d.id || d.label.toLowerCase().replace(/\s+/g, "_"),
            d.label,
            n(d.status) || "New",
          ],
        );
      }
    }
    for (const m of medications || []) {
      if (m?.name) {
        const isActive = m.is_active !== false;
        await client.query(
          `INSERT INTO medications (patient_id, consultation_id, name, composition, dose, frequency, timing, is_active, started_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
           DO UPDATE SET consultation_id = EXCLUDED.consultation_id,
             composition = COALESCE(EXCLUDED.composition, medications.composition),
             dose = COALESCE(EXCLUDED.dose, medications.dose),
             frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
             timing = COALESCE(EXCLUDED.timing, medications.timing),
             is_active = EXCLUDED.is_active,
             started_date = COALESCE(EXCLUDED.started_date, medications.started_date),
             updated_at = NOW()`,
          [
            patientId,
            cid,
            m.name,
            n(m.composition),
            n(m.dose),
            n(m.frequency),
            n(m.timing),
            isActive,
            n(m.started_date) || visit_date,
          ],
        );
      }
    }
    for (const l of labs || []) {
      if (l?.test_name) {
        await client.query(
          "INSERT INTO lab_results (patient_id, consultation_id, test_date, test_name, canonical_name, result, unit, flag, ref_range, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual')",
          [
            patientId,
            cid,
            visit_date,
            l.test_name,
            getCanonical(l.test_name),
            num(l.result),
            n(l.unit),
            n(l.flag),
            n(l.ref_range),
          ],
        );
      }
    }

    await client.query("COMMIT");
    console.log(`✅ History saved: patient=${patientId} consultation=${cid}`);
    res.json({ success: true, consultation_id: cid });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ History save error:", e.message, e.detail || "");
    handleError(res, e, "Consultation");
  } finally {
    client.release();
  }
});

export default router;
