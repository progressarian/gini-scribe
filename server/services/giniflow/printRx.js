import pool from "../../config/db.js";
import { savePrescriptionForVisit, buildVisitPayloadFromDb } from "../prescriptionAutoSave.js";

// Scoped to the visit, not the patient: a desk prints for the person in front of
// it, and a visit id on a live board is a far smaller surface than a patient
// directory (docs/gini-flow/25-PRINT-PRESCRIPTION-PLAN.md §6).
const RX_FOR_VISIT_SQL = `
  SELECT v.id AS visit_id, v.visit_date::text AS visit_date, v.current_status,
         p.id AS patient_id, p.name, p.file_no,
         cons.id AS consultation_id,
         d.id AS document_id, d.file_url, d.file_name, d.created_at AS rendered_at,
         meds.last_change
    FROM giniflow_visits v
    JOIN patients p ON p.id = v.patient_id
    LEFT JOIN LATERAL (
      SELECT id FROM consultations c
       WHERE c.patient_id = v.patient_id AND c.visit_date = v.visit_date
       ORDER BY id DESC LIMIT 1
    ) cons ON TRUE
    LEFT JOIN LATERAL (
      SELECT id, file_url, storage_path, file_name, created_at FROM documents dd
       WHERE dd.patient_id = v.patient_id
         AND dd.doc_type = 'prescription'
         AND (dd.file_url IS NOT NULL OR dd.storage_path IS NOT NULL)
         AND dd.consultation_id IS NOT DISTINCT FROM cons.id
       ORDER BY dd.id DESC LIMIT 1
    ) d ON TRUE
    LEFT JOIN LATERAL (
      SELECT max(m.updated_at) AS last_change
        FROM medications m
       WHERE m.consultation_id = cons.id
    ) meds ON TRUE
   WHERE v.id = $1`;

export async function getPrintableRx(visitId, db = pool) {
  const { rows } = await db.query(RX_FOR_VISIT_SQL, [visitId]);
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const r = rows[0];

  if (!r.consultation_id) {
    throw Object.assign(new Error("This visit has no consultation yet"), {
      status: 409,
      reason: "not_finalized",
    });
  }
  // The PDF is written after the Finalize commit, fire-and-forget, so a visit can
  // legitimately be past the consult with no file yet. That is a wait, not a
  // failure (25 §4.1).
  if (!r.document_id) {
    throw Object.assign(new Error("The prescription is still being prepared"), {
      status: 409,
      reason: "not_ready",
    });
  }
  // The PDF is rendered once per consultation and never re-rendered for it
  // (prescriptionAutoSave is idempotent on patient + consultation + source), so
  // a prescription edited after that render still serves the old file. Six
  // prescriptions in the week to 5 Sep 2026 changed up to 42 minutes after
  // theirs, three of which never got a newer document. Handing a patient a
  // superseded prescription is worse than handing them none, so this refuses
  // rather than serving quietly.
  if (r.last_change && r.rendered_at && new Date(r.last_change) > new Date(r.rendered_at)) {
    throw Object.assign(new Error("The prescription changed after this copy was made"), {
      status: 409,
      reason: "stale",
      renderedAt: new Date(r.rendered_at).toISOString(),
      changedAt: new Date(r.last_change).toISOString(),
    });
  }

  return r;
}

export async function fetchRxFile(visitId, db = pool) {
  const r = await getPrintableRx(visitId, db);

  // Reuses the resolver every other document path already goes through: it
  // knows the Supabase shape, the HealthRay S3 shape, the auth each needs and
  // the JSON-error body HealthRay returns with HTTP 200.
  const { resolveDocumentUrl } = await import("../../routes/documents.js");
  const resolved = await resolveDocumentUrl(r.document_id);
  if (resolved?.error) {
    throw Object.assign(new Error(resolved.error), { status: resolved.status || 502 });
  }

  const who = String(r.name || "patient").replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileName = `Rx_${who}_${r.file_no || r.patient_id}.pdf`;

  if (resolved.buffer) {
    return {
      bytes: resolved.buffer,
      contentType: resolved.mimeType || "application/pdf",
      fileName,
    };
  }

  const resp = await fetch(resolved.url);
  if (!resp.ok) {
    throw Object.assign(new Error("The stored prescription could not be read"), {
      status: resp.status === 404 ? 404 : 502,
    });
  }
  return {
    bytes: Buffer.from(await resp.arrayBuffer()),
    contentType: resp.headers.get("content-type") || resolved.mimeType || "application/pdf",
    fileName,
  };
}

// Re-render the prescription for a visit whose medicines changed after the last
// copy was made. `overwrite` is the existing contract — it deletes the
// superseded row before generating a fresh one, which is what we want: a
// prescription that no longer matches the chart should not stay retrievable.
export async function regenerateRx(visitId, db = pool) {
  const { rows } = await db.query(
    `SELECT v.patient_id, v.appointment_id, cons.id AS consultation_id
       FROM giniflow_visits v
       LEFT JOIN LATERAL (
         SELECT id FROM consultations c
          WHERE c.patient_id = v.patient_id AND c.visit_date = v.visit_date
          ORDER BY id DESC LIMIT 1
       ) cons ON TRUE
      WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw Object.assign(new Error("Visit not found"), { status: 404 });
  const {
    patient_id: pid,
    appointment_id: appointmentId,
    consultation_id: consultationId,
  } = rows[0];

  if (!consultationId) {
    throw Object.assign(new Error("This visit has no consultation to re-issue from"), {
      status: 409,
      reason: "not_finalized",
    });
  }

  const payload = await buildVisitPayloadFromDb(pid, { appointmentId });
  if (!payload) {
    throw Object.assign(new Error("Could not rebuild the prescription"), { status: 500 });
  }

  const saved = await savePrescriptionForVisit(pid, payload, {
    source: "visit",
    appointmentId,
    consultationId,
    clientInitiated: true,
    overwrite: true,
  });

  return {
    ok: true,
    documentId: saved?.document?.id ?? null,
    fileName: saved?.file_name ?? null,
  };
}
