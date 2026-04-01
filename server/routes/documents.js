import { Router } from "express";
import pool from "../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../config/storage.js";
import { n, safeJson } from "../utils/helpers.js";
import { handleError } from "../utils/errorHandler.js";
import { validate } from "../middleware/validate.js";
import { documentCreateSchema, fileUploadSchema } from "../schemas/index.js";

const router = Router();

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
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)
      return res.status(400).json({ error: "Storage not configured" });

    const doc = await pool.query(
      "SELECT storage_path, mime_type, file_name FROM documents WHERE id=$1",
      [req.params.id],
    );
    if (!doc.rows[0]?.storage_path) return res.status(404).json({ error: "No file attached" });

    const signResp = await fetch(
      `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${doc.rows[0].storage_path}`,
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
    res.json({ url, mime_type: doc.rows[0].mime_type, file_name: doc.rows[0].file_name });
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

    await pool.query("DELETE FROM documents WHERE id=$1", [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    handleError(res, e, "Document delete");
  }
});

export default router;
