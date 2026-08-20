import { Router } from "express";
import pool from "../config/db.js";
import { handleError } from "../utils/errorHandler.js";
import { resolveDocumentUrl } from "./documents.js";
import { fetchVisitHistory } from "../services/visitHistory.js";

const router = Router();

const BASE = "/ghm-patient-record";

router.get(`${BASE}/:patientId`, async (req, res) => {
  try {
    const id = Number(req.params.patientId);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid patient id" });

    const patientQ = await pool.query(
      `SELECT id, name, file_no, phone, age, sex, address, email FROM patients WHERE id=$1`,
      [id],
    );
    if (!patientQ.rows.length) return res.status(404).json({ error: "Patient not found" });

    const [docs, consultations, visits, labs, meds] = await Promise.all([
      pool.query(
        `SELECT id, doc_type, title, file_name, doc_date, source, notes, consultation_id,
                storage_path IS NOT NULL AS has_file, created_at
           FROM documents
          WHERE patient_id=$1
          ORDER BY COALESCE(doc_date, created_at::date) DESC, id DESC`,
        [id],
      ),
      pool.query(
        `SELECT id, visit_date, visit_type, mo_name, con_name, status,
                con_data IS NOT NULL AS has_prescription
           FROM consultations
          WHERE patient_id=$1
          ORDER BY visit_date DESC, id DESC`,
        [id],
      ),
      fetchVisitHistory(id),
      pool.query(
        `SELECT DISTINCT ON (COALESCE(canonical_name, test_name), test_date)
                id, COALESCE(canonical_name, test_name) AS test_name, result, result_text,
                unit, ref_range, flag, is_critical, test_date
           FROM lab_results
          WHERE patient_id=$1
          ORDER BY COALESCE(canonical_name, test_name), test_date DESC, created_at DESC`,
        [id],
      ),
      pool.query(
        `SELECT id, name, dose, frequency, timing, is_active, started_date
           FROM medications
          WHERE patient_id=$1 AND is_active = TRUE
          ORDER BY started_date DESC NULLS LAST, id DESC`,
        [id],
      ),
    ]);

    pool
      .query(
        `INSERT INTO audit_log (doctor_id, action, entity_type, entity_id, details)
         VALUES ($1, 'view_ghm_patient_record', 'patient', $2, $3)`,
        [req.doctor?.doctor_id || null, id, JSON.stringify({ via: "ghm_sheet" })],
      )
      .catch(() => {});

    res.json({
      patient: patientQ.rows[0],
      documents: docs.rows,
      consultations: consultations.rows,
      visits,
      labs: labs.rows.sort((a, b) => String(b.test_date).localeCompare(String(a.test_date))),
      medications: meds.rows,
    });
  } catch (e) {
    handleError(res, e, "GHM patient record");
  }
});

router.get(`${BASE}/document/:docId/stream`, async (req, res) => {
  try {
    const result = await resolveDocumentUrl(req.params.docId);
    if (result.error) return res.status(result.status).json({ error: result.error });

    const send = (buffer, mimeType, fileName) => {
      res.set("Content-Type", mimeType || "application/pdf");
      res.set(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(fileName || "document")}"`,
      );
      res.set("Cache-Control", "private, max-age=300");
      res.send(buffer);
    };

    if (result.buffer) return send(result.buffer, result.mimeType, result.fileName);

    const fileRes = await fetch(result.url);
    if (!fileRes.ok) return res.status(502).json({ error: "Failed to fetch document" });
    const responseMime = fileRes.headers.get("content-type")?.split(";")[0].trim();
    if (responseMime === "application/json")
      return res.status(502).json({ error: "Could not retrieve file" });
    const mimeType =
      responseMime && responseMime !== "application/octet-stream"
        ? responseMime
        : result.mimeType || "application/pdf";
    send(Buffer.from(await fileRes.arrayBuffer()), mimeType, result.fileName);
  } catch (e) {
    handleError(res, e, "GHM patient record document");
  }
});

router.get(`${BASE}/prescription/:consultationId`, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, visit_date, mo_name, con_name, con_data FROM consultations WHERE id=$1`,
      [req.params.consultationId],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Consultation not found" });
    const c = r.rows[0];
    const cd = c.con_data || {};
    res.json({
      id: c.id,
      visit_date: c.visit_date,
      mo_name: c.mo_name,
      con_name: c.con_name,
      diagnoses: cd.diagnoses || [],
      chief_complaints: cd.chief_complaints || [],
      medications: cd.medications_confirmed || [],
      investigations: cd.investigations_to_order || [],
      diet_lifestyle: cd.diet_lifestyle || [],
      follow_up: cd.follow_up || null,
      assessment_summary: cd.assessment_summary || null,
    });
  } catch (e) {
    handleError(res, e, "GHM patient record prescription");
  }
});

export default router;
