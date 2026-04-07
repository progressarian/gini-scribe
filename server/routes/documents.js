import { Router } from "express";
import pool from "../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { n, safeJson } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { getCanonical } from "../utils/labCanonical.js";
import { validate } from "../middleware/validate.js";
import { documentCreateSchema, fileUploadSchema } from "../schemas/index.js";
import { fetchMedicalRecords } from "../services/healthray/client.js";

const router = Router();

// ── DB migration: ensure document_id columns exist ──────────────────────────
pool
  .query(
    `ALTER TABLE lab_results ADD COLUMN IF NOT EXISTS document_id INTEGER;
   ALTER TABLE medications ADD COLUMN IF NOT EXISTS document_id INTEGER;`,
  )
  .catch(() => {});

// ── DB migration: reviewed flag for unread report rule ───────────────────────
pool
  .query(`ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed BOOLEAN DEFAULT FALSE`)
  .catch(() => {});

// ── Refresh OPD consultations when prescription data changes ────────────────
async function refreshOpdConsultations(client, patientId) {
  // Get ALL prescription documents for this patient
  const { rows: rxDocs } = await client.query(
    `SELECT extracted_data, doc_date, created_at FROM documents
     WHERE patient_id = $1 AND source = 'opd_upload' AND doc_type = 'prescription'
       AND extracted_data IS NOT NULL
     ORDER BY doc_date DESC NULLS LAST, created_at DESC`,
    [patientId],
  );
  if (!rxDocs.length) return;

  // Aggregate all prescription data
  const allDiags = [];
  const allMeds = [];
  const allStopped = [];
  const transcriptParts = [];

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

  // Deduplicate diagnoses by id
  const diagMap = {};
  for (const d of allDiags) {
    if (d?.id) diagMap[d.id] = d;
  }
  const mergedDiags = Object.values(diagMap);
  const conTranscript = transcriptParts.filter(Boolean).join("\n\n");

  // Update ALL OPD consultations for this patient
  const { rows: opdCons } = await client.query(
    `SELECT id, mo_data, con_data FROM consultations
     WHERE patient_id = $1 AND visit_type = 'OPD'`,
    [patientId],
  );

  for (const con of opdCons) {
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
  }

  // Link unlinked documents to the latest consultation
  if (opdCons.length) {
    await client.query(
      `UPDATE documents SET consultation_id = $1
       WHERE patient_id = $2 AND source = 'opd_upload' AND consultation_id IS NULL`,
      [opdCons[0].id, patientId],
    );
  }
}

// Save document metadata
router.post("/patients/:id/documents", validate(documentCreateSchema), async (req, res) => {
  try {
    const {
      doc_type,
      title,
      file_name,
      file_url,
      extracted_text,
      extracted_data,
      doc_date,
      source,
      notes,
      consultation_id,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO documents (patient_id, consultation_id, doc_type, title, file_name, file_url, extracted_text, extracted_data, doc_date, source, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        req.params.id,
        n(consultation_id),
        n(doc_type),
        n(title),
        n(file_name),
        n(file_url),
        n(extracted_text),
        safeJson(extracted_data),
        n(doc_date) || null,
        n(source),
        n(notes),
      ],
    );
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Get specific document
router.get("/documents/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Upload file to Supabase Storage
router.post("/documents/:id/upload-file", validate(fileUploadSchema), async (req, res) => {
  try {
    const { base64, mediaType, fileName } = req.body;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
      return res.status(400).json({ error: "Storage not configured" });

    const doc = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!doc.rows[0]) return res.status(404).json({ error: "Document not found" });
    const patientId = doc.rows[0].patient_id;

    const docType = doc.rows[0].doc_type || "other";
    const ts = Date.now();
    const storagePath = `patients/${patientId}/${docType}/${ts}_${fileName}`;

    const fileBuffer = Buffer.from(base64, "base64");
    const uploadResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": mediaType || "application/octet-stream",
          "x-upsert": "true",
        },
        body: fileBuffer,
      },
    );

    if (!uploadResp.ok) {
      const err = await uploadResp.text();
      return res.status(500).json({ error: "Upload failed: " + err });
    }

    await pool.query("UPDATE documents SET storage_path=$1, mime_type=$2 WHERE id=$3", [
      storagePath,
      mediaType,
      req.params.id,
    ]);
    res.json({ success: true, storage_path: storagePath });
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Get signed URL to view/download a file
router.get("/documents/:id/file-url", async (req, res) => {
  try {
    const doc = await pool.query(
      "SELECT storage_path, file_url, mime_type, file_name, source, notes, patient_id, doc_date FROM documents WHERE id=$1",
      [req.params.id],
    );
    const d = doc.rows[0];
    if (!d) return res.status(404).json({ error: "Document not found" });

    // ── HealthRay document: re-fetch fresh URL from HealthRay API ──────────────
    if (!d.storage_path && d.source === "healthray") {
      try {
        const apptR = await pool.query(
          `SELECT healthray_id FROM appointments
       WHERE patient_id = $1 AND appointment_date::date = $2::date
       AND healthray_id IS NOT NULL LIMIT 1`,
          [d.patient_id, d.doc_date],
        );

        const healthrayApptId = apptR.rows[0]?.healthray_id;
        if (!healthrayApptId)
          return res.status(404).json({ error: "No HealthRay appointment found" });

        const records = await fetchMedicalRecords(healthrayApptId);

        const recordIdStr = (d.notes || "").match(/healthray_record:(\d+)/)?.[1];

        const match = records?.find((r) => String(r.id) === recordIdStr);

        const url = match?.url || match?.file_url || match?.attachment_url;

        if (!url) return res.status(404).json({ error: "Could not get file URL from HealthRay" });
        return res.json({ url, file_name: d.file_name, mime_type: d.mime_type });
      } catch (err) {
        return res.status(404).json({ error: "Failed to get fresh URL from HealthRay" });
      }
    }

    if (!d.storage_path) return res.status(404).json({ error: "No file attached" });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
      return res.status(400).json({ error: "Storage not configured" });

    const signResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${d.storage_path}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );

    if (!signResp.ok) return res.status(500).json({ error: "Failed to generate URL" });
    const signData = await signResp.json();
    const signedPath = signData.signedURL || signData.signedUrl || signData.token;

    const url = signedPath?.startsWith("http")
      ? signedPath
      : `${SUPABASE_URL}/storage/v1${signedPath}`;
    res.json({ url, mime_type: d.mime_type, file_name: d.file_name });
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Get prescription for a consultation (for reprinting)
router.get("/consultations/:id/prescription", async (req, res) => {
  try {
    const doc = await pool.query(
      "SELECT * FROM documents WHERE consultation_id=$1 AND doc_type='prescription' ORDER BY created_at DESC LIMIT 1",
      [req.params.id],
    );
    if (doc.rows[0]) return res.json(doc.rows[0]);

    const con = await pool.query(
      `SELECT c.*, p.name as patient_name, p.age, p.sex, p.phone, p.file_no, p.dob
       FROM consultations c JOIN patients p ON p.id=c.patient_id WHERE c.id=$1`,
      [req.params.id],
    );
    if (!con.rows[0]) return res.status(404).json({ error: "Not found" });
    const c = con.rows[0];
    res.json({
      doc_type: "prescription",
      title: `Prescription — ${c.con_name} — ${new Date(c.visit_date || c.created_at).toLocaleDateString("en-IN")}`,
      extracted_data: {
        patient: {
          name: c.patient_name,
          age: c.age,
          sex: c.sex,
          phone: c.phone,
          fileNo: c.file_no,
        },
        doctor: c.con_name,
        mo: c.mo_name,
        date: c.visit_date || c.created_at,
        diagnoses: c.mo_data?.diagnoses || [],
        medications: c.con_data?.medications_confirmed || [],
        diet_lifestyle: c.con_data?.diet_lifestyle || [],
        follow_up: c.con_data?.follow_up || {},
        assessment_summary: c.con_data?.assessment_summary || "",
        chief_complaints: c.mo_data?.chief_complaints || [],
        plan_edits: c.plan_edits,
      },
      source: "scribe",
      doc_date: c.visit_date || c.created_at,
    });
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Get imaging documents for a patient
router.get("/patients/:id/imaging", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, doc_type, title, file_name, doc_date, source, notes, extracted_data, created_at
       FROM documents WHERE patient_id=$1 AND doc_type NOT IN ('prescription','lab_report')
       ORDER BY doc_date DESC`,
      [req.params.id],
    );
    res.json(result.rows);
  } catch (e) {
    handleError(res, e, "Document");
  }
});

// Update a document (extracted_data, notes, etc.)
// When extracted_data contains lab panels, syncs all tests to lab_results table
router.patch("/documents/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { extracted_data, notes } = req.body;
    const sets = [];
    const vals = [req.params.id];
    let idx = 2;
    if (extracted_data !== undefined) {
      sets.push(`extracted_data = $${idx}::jsonb`);
      vals.push(JSON.stringify(extracted_data));
      idx++;
    }
    if (notes !== undefined) {
      sets.push(`notes = $${idx}`);
      vals.push(notes);
      idx++;
    }
    if (!sets.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Nothing to update" });
    }
    const result = await client.query(
      `UPDATE documents SET ${sets.join(", ")} WHERE id = $1 RETURNING *`,
      vals,
    );
    if (!result.rows[0]) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Not found" });
    }

    const doc = result.rows[0];

    // ── Sync extracted lab tests to lab_results table ──
    if (extracted_data?.panels && doc.patient_id) {
      // Remove previous entries synced from this document
      await client.query(`DELETE FROM lab_results WHERE document_id = $1`, [doc.id]);

      const testDate =
        extracted_data.report_date ||
        extracted_data.collection_date ||
        (doc.doc_date
          ? new Date(doc.doc_date).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0]);

      for (const panel of extracted_data.panels) {
        for (const test of panel.tests || []) {
          if (test.result == null && !test.result_text) continue;
          const numResult = typeof test.result === "number" ? test.result : parseFloat(test.result);

          await client.query(
            `INSERT INTO lab_results
               (patient_id, document_id, consultation_id, test_date, panel_name, test_name, canonical_name, result, result_text, unit, flag, ref_range, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'report_extract')`,
            [
              doc.patient_id,
              doc.id,
              doc.consultation_id || null,
              testDate,
              panel.panel_name || null,
              test.test_name,
              getCanonical(test.test_name) || test.test_name,
              isNaN(numResult) ? null : numResult,
              test.result_text || null,
              test.unit || null,
              test.flag || null,
              test.ref_range || null,
            ],
          );
        }
      }
    }

    // ── Sync extracted prescription data (diagnoses + medications) ──
    if (doc.patient_id && extracted_data?.medications) {
      // Add document_id columns to medications if not yet there
      await client
        .query(`ALTER TABLE medications ADD COLUMN IF NOT EXISTS document_id INTEGER`)
        .catch(() => {});

      // Remove previous entries synced from this document
      await client.query(`DELETE FROM medications WHERE document_id = $1`, [doc.id]);

      const rxDate =
        extracted_data.visit_date ||
        (doc.doc_date
          ? new Date(doc.doc_date).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0]);

      for (const m of extracted_data.medications || []) {
        if (!m?.name) continue;
        await client.query(
          `INSERT INTO medications
             (patient_id, document_id, consultation_id, name, dose, frequency, timing, route, is_new, is_active, source, started_date)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, true, 'report_extract', $9)
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = true
           DO UPDATE SET document_id = EXCLUDED.document_id,
             consultation_id = COALESCE(EXCLUDED.consultation_id, medications.consultation_id),
             dose = COALESCE(EXCLUDED.dose, medications.dose),
             frequency = COALESCE(EXCLUDED.frequency, medications.frequency),
             timing = COALESCE(EXCLUDED.timing, medications.timing),
             route = COALESCE(EXCLUDED.route, medications.route),
             source = EXCLUDED.source,
             started_date = COALESCE(EXCLUDED.started_date, medications.started_date),
             updated_at = NOW()`,
          [
            doc.patient_id,
            doc.id,
            doc.consultation_id || null,
            (m.name || "").slice(0, 200),
            (m.dose || "").slice(0, 100),
            (m.frequency || "").slice(0, 100),
            (m.timing || "").slice(0, 100),
            (m.route || "Oral").slice(0, 50),
            rxDate,
          ],
        );
      }

      // Sync stopped medications as inactive
      for (const m of extracted_data.stopped_medications || []) {
        if (!m?.name) continue;
        await client.query(
          `INSERT INTO medications
             (patient_id, document_id, consultation_id, name, is_new, is_active, source, started_date)
           VALUES ($1, $2, $3, $4, false, false, 'report_extract', $5)
           ON CONFLICT (patient_id, UPPER(COALESCE(pharmacy_match, name))) WHERE is_active = false
           DO UPDATE SET document_id = EXCLUDED.document_id,
             consultation_id = COALESCE(EXCLUDED.consultation_id, medications.consultation_id),
             source = EXCLUDED.source,
             updated_at = NOW()`,
          [
            doc.patient_id,
            doc.id,
            doc.consultation_id || null,
            (m.name || "").slice(0, 200),
            rxDate,
          ],
        );
      }

      // Sync diagnoses
      for (const d of extracted_data.diagnoses || []) {
        if (!d?.id || !d?.label) continue;
        await client.query(
          `INSERT INTO diagnoses (patient_id, diagnosis_id, label, status)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (patient_id, diagnosis_id) DO UPDATE
             SET label = EXCLUDED.label,
                 status = EXCLUDED.status`,
          [doc.patient_id, d.id, d.label, d.status || "Controlled"],
        );
      }

      // ── Refresh OPD consultations with latest prescription data ──
      await refreshOpdConsultations(client, doc.patient_id);
    }

    await client.query("COMMIT");
    res.json(doc);
  } catch (e) {
    await client.query("ROLLBACK");
    handleError(res, e, "Document patch");
  } finally {
    client.release();
  }
});

// ── Mark a document as reviewed by the doctor ────────────────────────────────
router.patch("/documents/:id/reviewed", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE documents SET reviewed=TRUE WHERE id=$1 RETURNING id, reviewed`,
      [req.params.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Not found" });
    res.json(result.rows[0]);
  } catch (e) {
    handleError(res, e, "Mark document reviewed");
  }
});

// Delete a document and its file from storage
router.delete("/documents/:id", async (req, res) => {
  try {
    const doc = await pool.query("SELECT * FROM documents WHERE id=$1", [req.params.id]);
    if (!doc.rows[0]) return res.status(404).json({ error: "Not found" });

    // Delete file from Supabase Storage if it exists
    if (doc.rows[0].storage_path && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${doc.rows[0].storage_path}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        },
      ).catch(() => {}); // Don't fail if storage delete fails
    }

    const deletedDoc = doc.rows[0];

    // Remove synced records linked to this document
    await pool.query("DELETE FROM lab_results WHERE document_id=$1", [req.params.id]);
    await pool.query("DELETE FROM medications WHERE document_id=$1", [req.params.id]);
    await pool.query("DELETE FROM documents WHERE id=$1", [req.params.id]);

    // Refresh OPD consultations with remaining prescription data
    if (deletedDoc.patient_id && deletedDoc.doc_type === "prescription") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await refreshOpdConsultations(client, deletedDoc.patient_id);
        await client.query("COMMIT");
      } catch (e2) {
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    }

    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Document delete");
  }
});

export default router;
