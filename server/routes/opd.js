import { Router } from "express";
import { createRequire } from "module";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { sortDiagnoses } from "../utils/diagnosisSort.js";
import { syncTodaysShow } from "../services/cron/todaysShowSync.js";
import { markAppointmentAsSeen } from "../services/healthray/db.js";
import {
  stripFormPrefix,
  canonicalMedKey,
  routeForForm,
} from "../services/medication/normalize.js";

const require = createRequire(import.meta.url);
const {
  syncVitalsRowToGenie,
  syncAppointmentToGenie,
  syncCareTeamToGenie,
} = require("../genie-sync.cjs");

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
    // Auto-mark completed HealthRay appointments as "seen" if not already
    backfillHealthraySeenStatus().catch((e) => console.log("HealthRay seen backfill:", e.message));
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

      // Insert diagnoses (batched — diagMap dedup above already guarantees
      // unique diagnosis_id per consultation, so ON CONFLICT is safe).
      const dxRows = mergedDiags.filter((d) => d?.id && d?.label);
      if (dxRows.length) {
        await client.query(
          `INSERT INTO diagnoses (patient_id, consultation_id, diagnosis_id, label, status)
           SELECT $1, $2, d_id, d_label, d_status
             FROM UNNEST($3::text[], $4::text[], $5::text[]) AS t(d_id, d_label, d_status)
           ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
             SET label = EXCLUDED.label,
                 status = EXCLUDED.status,
                 consultation_id = EXCLUDED.consultation_id`,
          [
            con.patient_id,
            con.id,
            dxRows.map((d) => String(d.id)),
            dxRows.map((d) => d.label),
            dxRows.map((d) => d.status || "Controlled"),
          ],
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

// ── Backfill: auto-mark completed HealthRay appointments as "seen" ──────────
async function backfillHealthraySeenStatus() {
  const { rows } = await pool.query(
    `SELECT id FROM appointments
     WHERE healthray_id IS NOT NULL
       AND status IN ('completed', 'seen')
       AND patient_id IS NOT NULL
       AND healthray_diagnoses IS NOT NULL
       AND jsonb_array_length(healthray_diagnoses) > 0
       AND (
         consultation_id IS NULL
         OR prep_steps->>'biomarkers' != 'true'
         OR prep_steps->>'compliance' != 'true'
         OR prep_steps->>'categorized' != 'true'
         OR prep_steps->>'assigned' != 'true'
       )`,
  );
  if (!rows.length) return;
  console.log(`🔄 Auto-marking ${rows.length} HealthRay appointments as seen...`);

  let marked = 0;
  for (const row of rows) {
    const result = await markAppointmentAsSeen(row.id);
    if (result) marked++;
  }
  console.log(`✅ Marked ${marked}/${rows.length} HealthRay appointments as seen`);
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

// ── POST /api/opd/sync-noshow — trigger Google Sheet no-show sync on demand ──
router.post("/opd/sync-noshow", async (_req, res) => {
  try {
    const result = await syncTodaysShow();
    res.json({ ok: true, ...result });
  } catch (e) {
    handleError(res, e, "Sync no-show failed");
  }
});

// ── GET /api/opd/appointments — OPD list (flat array, by date) ───────────────
//
// Previously this was one SELECT with 11 correlated subqueries per row. On a
// 30-patient list that meant ~330 extra lookups. We now fetch core appointment
// rows once and aggregate the rest with two patient-scoped queries, then merge
// in JS. All per-appointment subqueries (visit_count, last_visit, etc.)
// reduced to per-patient because every row in the list shares the same
// appointment_date = $1.
router.get("/opd/appointments", async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split("T")[0];

    // 1) Core appointment rows + joined patient fields (no aggregation).
    const { rows } = await pool.query(
      `SELECT a.*,
              COALESCE(p.id, a.patient_id) AS patient_id,
              COALESCE(a.age, EXTRACT(YEAR FROM AGE(p.dob))::INTEGER, p.age) AS age,
              COALESCE(a.sex, p.sex) AS sex,
              p.file_no AS _resolved_file_no
         FROM appointments a
         LEFT JOIN patients p
           ON (a.file_no IS NOT NULL AND p.file_no = a.file_no)
           OR (a.file_no IS NULL AND p.id = a.patient_id)
        WHERE a.appointment_date = $1
        ORDER BY a.time_slot DESC NULLS LAST, a.created_at DESC`,
      [date],
    );

    const patientIds = [...new Set(rows.map((r) => r.patient_id).filter((x) => x != null))];
    const fileNos = [
      ...new Set(rows.map((r) => r._resolved_file_no).filter((x) => x != null && x !== "")),
    ];

    // 2) Per-patient aggregates (visit counts, last visit, healthray_diagnoses
    //    fallback, prev_hba1c, uploaded_labs from lab_results + documents).
    //    One query, one round-trip, all keyed on patient_id.
    const aggMap = new Map();
    if (patientIds.length) {
      const { rows: agg } = await pool.query(
        `WITH pids AS (
           SELECT UNNEST($1::int[]) AS pid
         )
         SELECT pids.pid AS patient_id,
           -- Mirror /api/visit/:patientId dedup: consultations UNION appointments
           -- (only HealthRay-linked), dropping appointments whose date already
           -- has a consultation, then distinct on (date, status).
           (SELECT COUNT(*) FROM (
              SELECT DISTINCT v_date, v_status FROM (
                SELECT c.visit_date::date AS v_date, c.status AS v_status
                  FROM consultations c WHERE c.patient_id = pids.pid
                UNION ALL
                SELECT a2.appointment_date::date AS v_date, a2.status AS v_status
                  FROM appointments a2
                  WHERE a2.patient_id = pids.pid
                    AND a2.healthray_id IS NOT NULL
                    AND a2.appointment_date IS NOT NULL
                    AND NOT EXISTS (
                      SELECT 1 FROM consultations c2
                       WHERE c2.patient_id = pids.pid
                         AND c2.visit_date::date = a2.appointment_date::date
                    )
              ) u
            ))::int AS visit_count,
           (SELECT MAX(a3.appointment_date) FROM appointments a3
              WHERE a3.patient_id = pids.pid
                AND a3.appointment_date < $2) AS last_visit_date,
           (SELECT a4.healthray_diagnoses FROM appointments a4
              WHERE a4.patient_id = pids.pid
                AND a4.healthray_diagnoses IS NOT NULL
                AND jsonb_array_length(a4.healthray_diagnoses) > 0
              ORDER BY a4.appointment_date DESC LIMIT 1) AS latest_healthray_dx,
           (SELECT lr.result FROM lab_results lr
              WHERE lr.patient_id = pids.pid
                AND LOWER(COALESCE(lr.canonical_name, lr.test_name)) = ANY(ARRAY['hba1c','hb_a1c','glycated hemoglobin','a1c'])
                AND lr.result IS NOT NULL
              ORDER BY lr.test_date DESC, lr.created_at DESC
              OFFSET 1 LIMIT 1) AS prev_hba1c,
           (SELECT COUNT(DISTINCT lr3.canonical_name)::int FROM lab_results lr3
              WHERE lr3.patient_id = pids.pid
                AND lr3.source = 'report_extract'
                AND lr3.test_date >= CURRENT_DATE - INTERVAL '7 days') AS uploaded_lab_canonicals,
           (SELECT COUNT(*)::int FROM documents d
              WHERE d.patient_id = pids.pid
                AND d.doc_type IN ('lab_report', 'blood_test')
                AND d.source NOT IN ('healthray', 'lab_healthray')
                AND COALESCE(d.doc_date, d.created_at::date) >= CURRENT_DATE - INTERVAL '7 days') AS uploaded_lab_docs,
           (SELECT MAX(lr4.test_date) FROM lab_results lr4
              WHERE lr4.patient_id = pids.pid
                AND lr4.source = 'report_extract'
                AND lr4.test_date >= CURRENT_DATE - INTERVAL '7 days') AS upl_lab_date_lr,
           (SELECT MAX(COALESCE(d2.doc_date, d2.created_at::date)) FROM documents d2
              WHERE d2.patient_id = pids.pid
                AND d2.doc_type IN ('lab_report', 'blood_test')
                AND d2.source NOT IN ('healthray', 'lab_healthray')
                AND COALESCE(d2.doc_date, d2.created_at::date) >= CURRENT_DATE - INTERVAL '7 days') AS upl_lab_date_doc
         FROM pids`,
        [patientIds, date],
      );
      for (const r of agg) aggMap.set(r.patient_id, r);
    }

    // 3) lab_cases counts. These need both patient_id AND file_no (for
    //    unlinked cases), so aggregate separately and merge.
    const labCasesByPid = new Map();
    const labCasesByFile = new Map();
    if (patientIds.length || fileNos.length) {
      const { rows: lc } = await pool.query(
        `SELECT
           lc.patient_id,
           lc.raw_list_json->'patient'->>'healthray_uid' AS healthray_uid,
           COUNT(*) FILTER (
             WHERE lc.results_synced = FALSE
               AND COALESCE(lc.retry_abandoned, FALSE) = FALSE
           )::int AS pending_labs,
           COUNT(*) FILTER (
             WHERE lc.results_synced = TRUE
               AND lc.case_date >= CURRENT_DATE - INTERVAL '7 days'
           )::int AS recent_labs
         FROM lab_cases lc
         WHERE lc.patient_id = ANY($1::int[])
            OR (lc.patient_id IS NULL AND lc.raw_list_json->'patient'->>'healthray_uid' = ANY($2::text[]))
         GROUP BY lc.patient_id, lc.raw_list_json->'patient'->>'healthray_uid'`,
        [patientIds, fileNos],
      );
      for (const r of lc) {
        if (r.patient_id != null) {
          const prev = labCasesByPid.get(r.patient_id) || { pending_labs: 0, recent_labs: 0 };
          prev.pending_labs += r.pending_labs;
          prev.recent_labs += r.recent_labs;
          labCasesByPid.set(r.patient_id, prev);
        } else if (r.healthray_uid) {
          const prev = labCasesByFile.get(r.healthray_uid) || {
            pending_labs: 0,
            recent_labs: 0,
          };
          prev.pending_labs += r.pending_labs;
          prev.recent_labs += r.recent_labs;
          labCasesByFile.set(r.healthray_uid, prev);
        }
      }
    }

    // 4) Latest lab_results by canonical for biomarker enrichment.
    const CANONICAL_TO_BIO = {
      HbA1c: "hba1c",
      FBS: "fg",
      LDL: "ldl",
      Triglycerides: "tg",
      UACR: "uacr",
      Microalbumin: "uacr",
      Creatinine: "creatinine",
      TSH: "tsh",
      Haemoglobin: "hb",
      Hemoglobin: "hb",
      eGFR: "egfr",
    };
    const labByPt = {};
    if (patientIds.length) {
      const { rows: labR } = await pool.query(
        `SELECT DISTINCT ON (patient_id, canonical_name)
           patient_id, canonical_name, result, test_date
         FROM lab_results
         WHERE patient_id = ANY($1)
           AND result IS NOT NULL AND canonical_name IS NOT NULL
         ORDER BY patient_id, canonical_name, test_date DESC NULLS LAST`,
        [patientIds],
      );
      for (const r of labR) {
        const bioKey = CANONICAL_TO_BIO[r.canonical_name];
        if (!bioKey) continue;
        const val = parseFloat(r.result);
        if (isNaN(val)) continue;
        if (!labByPt[r.patient_id]) labByPt[r.patient_id] = {};
        const prev = labByPt[r.patient_id][bioKey];
        if (!prev || r.test_date > prev.date) {
          labByPt[r.patient_id][bioKey] = { val, date: r.test_date };
        }
      }
    }

    // 5) Merge aggregates back into each appointment row.
    for (const row of rows) {
      const a = aggMap.get(row.patient_id);
      const lc = labCasesByPid.get(row.patient_id) ||
        (row._resolved_file_no ? labCasesByFile.get(row._resolved_file_no) : null) || {
          pending_labs: 0,
          recent_labs: 0,
        };

      const upl = Math.max(a?.uploaded_lab_canonicals || 0, a?.uploaded_lab_docs || 0);
      const uplDate =
        [a?.upl_lab_date_lr, a?.upl_lab_date_doc].filter(Boolean).sort().pop() || null;

      row.visit_count = a?.visit_count || row.visit_count || 1;
      row.last_visit_date = a?.last_visit_date || null;
      // Fall back to latest non-empty healthray_diagnoses if this row's is empty.
      if (
        !row.healthray_diagnoses ||
        (Array.isArray(row.healthray_diagnoses) && row.healthray_diagnoses.length === 0)
      ) {
        row.healthray_diagnoses = a?.latest_healthray_dx || row.healthray_diagnoses;
      }
      row.pending_labs = lc.pending_labs;
      row.recent_labs = lc.recent_labs;
      row.uploaded_labs = upl;
      row.uploaded_labs_date = uplDate;
      row.prev_hba1c = a?.prev_hba1c || null;

      // Apply clinical sort to HealthRay diagnoses.
      if (Array.isArray(row.healthray_diagnoses) && row.healthray_diagnoses.length > 0) {
        row.healthray_diagnoses = sortDiagnoses(row.healthray_diagnoses);
      }

      // Biomarker enrichment from latest labs.
      const labs = labByPt[row.patient_id];
      if (labs) {
        const bio = row.biomarkers || {};
        const dates = bio._lab_dates || {};
        for (const [bioKey, { val, date: d }] of Object.entries(labs)) {
          if (!dates[bioKey] || d >= dates[bioKey]) {
            bio[bioKey] = val;
            if (!bio._lab_dates) bio._lab_dates = {};
            bio._lab_dates[bioKey] = d;
          }
        }
        row.biomarkers = bio;
      }

      delete row._resolved_file_no;
    }

    res.json(rows);
  } catch (e) {
    handleError(res, e, "OPD appointments list");
  }
});

// ── GET /api/opd/appointments-range — flat appointment rows in [start,end] ───
//
// Used by the OPD dashboard's range/period report. Returns one row per
// appointment within the inclusive [start_date, end_date] window so the
// client can group by patient and compute first/last biomarker trends.
router.get("/opd/appointments-range", async (req, res) => {
  try {
    const start = req.query.start_date || req.query.start;
    const end = req.query.end_date || req.query.end || start;
    if (!start) {
      return res.status(400).json({ error: "start_date required" });
    }
    const doctorFilter = (req.query.doctor || "").trim();
    const specialtyFilter = (req.query.specialty || req.query.speciality || "").trim();
    const params = [start, end];
    let qualWhere = "WHERE a.appointment_date BETWEEN $1 AND $2";
    if (doctorFilter) {
      params.push(doctorFilter);
      qualWhere += ` AND a.doctor_name = $${params.length}`;
    }
    if (specialtyFilter) {
      params.push(specialtyFilter);
      qualWhere += ` AND d.specialty = $${params.length}`;
    }
    // Two-step: identify patients with at least one visit in the period
    // (qualifying CTE), then return *all* their visits so the client can show
    // full biomarker history — not just visits inside the window.
    const { rows } = await pool.query(
      `WITH qualifying AS (
         SELECT DISTINCT
           COALESCE(p.id, a.patient_id) AS pid,
           COALESCE(a.file_no, p.file_no) AS fno
           FROM appointments a
           LEFT JOIN patients p
             ON (a.file_no IS NOT NULL AND p.file_no = a.file_no)
             OR (a.file_no IS NULL AND p.id = a.patient_id)
           LEFT JOIN doctors d
             ON d.name = a.doctor_name
          ${qualWhere}
       )
       SELECT a.id,
              a.appointment_date,
              a.time_slot,
              a.status,
              a.visit_type,
              a.doctor_name,
              d.specialty,
              a.category,
              a.biomarkers,
              a.compliance,
              a.healthray_diagnoses,
              COALESCE(p.id, a.patient_id) AS patient_id,
              COALESCE(a.patient_name, p.name) AS patient_name,
              COALESCE(a.file_no, p.file_no) AS file_no,
              COALESCE(a.phone, p.phone) AS phone,
              COALESCE(a.age, EXTRACT(YEAR FROM AGE(p.dob))::INTEGER, p.age) AS age,
              COALESCE(a.sex, p.sex) AS sex,
              (a.appointment_date BETWEEN $1 AND $2) AS in_period
         FROM appointments a
         LEFT JOIN patients p
           ON (a.file_no IS NOT NULL AND p.file_no = a.file_no)
           OR (a.file_no IS NULL AND p.id = a.patient_id)
         LEFT JOIN doctors d
           ON d.name = a.doctor_name
        WHERE EXISTS (
                SELECT 1 FROM qualifying q
                 WHERE (q.pid IS NOT NULL
                          AND q.pid = COALESCE(p.id, a.patient_id))
                    OR (q.fno IS NOT NULL
                          AND q.fno = COALESCE(a.file_no, p.file_no))
              )
        ORDER BY COALESCE(p.id, a.patient_id) NULLS LAST,
                 a.appointment_date ASC,
                 a.time_slot ASC NULLS LAST,
                 a.created_at ASC`,
      params,
    );
    res.json(rows);
  } catch (e) {
    handleError(res, e, "OPD appointments range");
  }
});

// ── GET /api/opd/patient-docs/:patientId — OPD-uploaded documents ────────────
router.get("/opd/patient-docs/:patientId", async (req, res) => {
  try {
    // Clean up orphan pending docs (doc row exists but file never made it
    // to storage because the user refreshed mid-upload). Same rule as
    // /patients/:id — older than 45s so we don't kill live uploads.
    pool
      .query(
        `DELETE FROM documents
           WHERE patient_id = $1
             AND extracted_data->>'extraction_status' = 'pending'
             AND COALESCE(storage_path, '') = ''
             AND COALESCE(file_url, '') = ''
             AND created_at < NOW() - INTERVAL '45 seconds'`,
        [req.params.patientId],
      )
      .catch(() => {});

    const { rows } = await pool.query(
      `SELECT id, doc_type, title, file_name, doc_date, source, notes, storage_path, extracted_data, created_at
         FROM documents
        WHERE patient_id = $1
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
    if (appt.patient_id) {
      syncAppointmentToGenie(appt.patient_id, pool).catch((e) =>
        console.warn("[OPD] Appointment push skipped:", e.message),
      );
      if (doctor_name) {
        syncCareTeamToGenie(appt.patient_id, pool).catch((e) =>
          console.warn("[OPD] Care team push skipped:", e.message),
        );
      }
    }
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

      const labEntries = Object.entries(LAB_MAP)
        .map(([key, meta]) => ({ meta, val: num(req.body[key]) }))
        .filter((e) => e.val !== null);
      if (labEntries.length) {
        await client.query(
          `INSERT INTO lab_results
             (patient_id, appointment_id, test_date, panel_name, test_name, canonical_name, result, unit, source)
           SELECT $1, $2, $3, panel, test_name, canonical, result, unit, 'opd'
             FROM UNNEST($4::text[], $5::text[], $6::text[], $7::numeric[], $8::text[])
                  AS t(panel, test_name, canonical, result, unit)`,
          [
            appt.patient_id,
            appt.id,
            testDate,
            labEntries.map((e) => e.meta.panel),
            labEntries.map((e) => e.meta.test_name),
            labEntries.map((e) => e.meta.canonical),
            labEntries.map((e) => e.val),
            labEntries.map((e) => e.meta.unit),
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

      // Active medicines — dedupe on the canonical (prefix-stripped) key.
      {
        const active = new Map();
        for (const m of medications || []) {
          if (!m?.name) continue;
          const { name: cleanName, form: detectedForm } = stripFormPrefix(m.name);
          const storedName = cleanName || m.name;
          const key = canonicalMedKey(storedName);
          if (key)
            active.set(key, {
              ...m,
              _clean_name: storedName,
              _canonical: key,
              _detected_form: detectedForm,
            });
        }
        const rows = Array.from(active.values());
        if (rows.length) {
          await client.query(
            `INSERT INTO medications
               (patient_id, appointment_id, name, pharmacy_match, composition, dose, frequency, timing, route, is_new, is_active, source)
             SELECT $1, $2, name, pharm, composition, dose, freq, timing, route, false, true, 'opd'
               FROM UNNEST($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
                    AS t(name, pharm, composition, dose, freq, timing, route)
             ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
             DO UPDATE SET appointment_id = EXCLUDED.appointment_id,
               pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
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
              rows.map((m) => m._clean_name.slice(0, 200)),
              rows.map((m) => m._canonical.slice(0, 200)),
              rows.map((m) => (m.composition || "").slice(0, 200)),
              rows.map((m) => (m.dose || "").slice(0, 100)),
              rows.map((m) => (m.frequency || "").slice(0, 100)),
              rows.map((m) => (m.timing || "").slice(0, 100)),
              rows.map((m) => (m.route || routeForForm(m._detected_form) || "Oral").slice(0, 50)),
            ],
          );
        }
      }

      // Stopped/omitted meds — same dedupe.
      {
        const stopped = new Map();
        for (const m of stopped_medications || []) {
          if (!m?.name) continue;
          const { name: cleanName } = stripFormPrefix(m.name);
          const storedName = cleanName || m.name;
          const key = canonicalMedKey(storedName);
          if (key) stopped.set(key, { ...m, _clean_name: storedName, _canonical: key });
        }
        const rows = Array.from(stopped.values());
        if (rows.length) {
          await client.query(
            `INSERT INTO medications
               (patient_id, appointment_id, name, pharmacy_match, dose, is_new, is_active, source)
             SELECT $1, $2, name, pharm, dose, false, false, 'opd'
               FROM UNNEST($3::text[], $4::text[], $5::text[]) AS t(name, pharm, dose)
             ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
             DO UPDATE SET appointment_id = EXCLUDED.appointment_id,
               pharmacy_match = COALESCE(EXCLUDED.pharmacy_match, medications.pharmacy_match),
               dose = COALESCE(EXCLUDED.dose, medications.dose),
               source = EXCLUDED.source,
               updated_at = NOW()`,
            [
              appt.patient_id,
              appt.id,
              rows.map((m) => m._clean_name.slice(0, 200)),
              rows.map((m) => m._canonical.slice(0, 200)),
              rows.map((m) => (m.reason || "").slice(0, 100)),
            ],
          );
        }
      }

      // Diagnoses sync — dedupe on diagnosis_id.
      if (Array.isArray(diagnoses) && diagnoses.length > 0) {
        const dxMap = new Map();
        for (const d of diagnoses) {
          if (d?.id && d?.label) dxMap.set(String(d.id), d);
        }
        const rows = Array.from(dxMap.values());
        if (rows.length) {
          await client.query(
            `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status)
             SELECT $1, d_id, d_label, d_status
               FROM UNNEST($2::text[], $3::text[], $4::text[]) AS t(d_id, d_label, d_status)
             ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
               SET label = EXCLUDED.label,
                   status = EXCLUDED.status`,
            [
              appt.patient_id,
              rows.map((d) => String(d.id)),
              rows.map((d) => d.label),
              rows.map((d) => d.status || "Controlled"),
            ],
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
    let newVitalsRow = null;
    if (appt.patient_id && (num(v.bpSys) || num(v.weight))) {
      // Remove previous OPD vitals for this appointment (handles re-save)
      await client.query(`DELETE FROM vitals WHERE appointment_id = $1`, [appt.id]);

      const ins = await client.query(
        `INSERT INTO vitals
           (patient_id, appointment_id, recorded_at, bp_sys, bp_dia, pulse, spo2, weight, height, bmi, waist, body_fat, muscle_mass, rbs, meal_type, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING id, recorded_at, bp_sys, bp_dia, pulse, spo2, weight, height, rbs, meal_type`,
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
          v.mealType || null,
          "OPD vitals",
        ],
      );
      newVitalsRow = ins.rows[0];
    }

    await client.query("COMMIT");
    // Fire-and-forget push to Genie so the patient app reflects OPD-recorded
    // vitals without waiting for the next full consultation save.
    if (newVitalsRow && appt.patient_id) {
      syncVitalsRowToGenie(appt.patient_id, newVitalsRow).catch((e) =>
        console.warn("[OPD] Vitals push skipped:", e.message),
      );
    }
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
