import pool from "../../config/db.js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, STORAGE_BUCKET } from "../../config/storage.js";
import { sanitizeForStorageKey } from "../../utils/storageKey.js";
import { httpError } from "../billing/transaction.js";
import { REGISTRATION_FILE_KINDS } from "../../../shared/patientIdentity.js";
import { loadActiveScheme, requiredScanKind } from "./identity.js";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_BYTES = 3 * 1024 * 1024;

async function storeObject(storagePath, buffer, mediaType) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) throw httpError(503, "File storage is not set up");
  const resp = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": mediaType,
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!resp.ok) {
    console.error("[registration-file] storage upload failed:", resp.status, await resp.text());
    throw httpError(502, "The file could not be saved. Try again.");
  }
}

async function loadPatient(patientId, db) {
  const { rows } = await db.query(
    `SELECT id, scheme_code, id_pending, id_doc_id, scheme_card_doc_id
       FROM patients WHERE id = $1`,
    [patientId],
  );
  if (!rows[0]) throw httpError(404, "Patient not found");
  return rows[0];
}

const shape = (row) => ({
  id_pending: row.id_pending,
  id_doc_id: row.id_doc_id,
  scheme_card_doc_id: row.scheme_card_doc_id,
});

export async function registrationFiles(patientId, db = pool) {
  const patient = await loadPatient(patientId, db);
  const scheme = await loadActiveScheme(patient.scheme_code, db);
  return { ...shape(patient), required_scan: requiredScanKind(patient.scheme_code, scheme) };
}

export async function saveRegistrationFile(
  patientId,
  kindKey,
  { base64, mediaType, fileName },
  db = pool,
) {
  const kind = REGISTRATION_FILE_KINDS[kindKey];
  if (!kind) throw httpError(400, "Unknown file kind");
  if (!ALLOWED_TYPES.includes(mediaType)) {
    throw httpError(400, "Upload a JPG, PNG, WEBP image or a PDF.");
  }
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw httpError(400, "The file is empty.");
  if (buffer.length > MAX_BYTES) throw httpError(400, "The file is larger than 3 MB.");

  const patient = await loadPatient(patientId, db);
  const safeName = sanitizeForStorageKey(fileName || `${kindKey}.${mediaType.split("/")[1]}`);
  const storagePath = `patients/${patient.id}/${kind.docType}/${Date.now()}_${safeName}`;
  await storeObject(storagePath, buffer, mediaType);

  const scheme = await loadActiveScheme(patient.scheme_code, db);
  const clearsPending = requiredScanKind(patient.scheme_code, scheme) === kindKey;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows: doc } = await client.query(
      `INSERT INTO documents (patient_id, doc_type, title, file_name, storage_path, mime_type,
                              extracted_data, doc_date, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE, 'registration') RETURNING id`,
      [
        patient.id,
        kind.docType,
        kind.title,
        safeName,
        storagePath,
        mediaType,
        JSON.stringify({ extraction_status: "skipped" }),
      ],
    );
    const { rows } = await client.query(
      `UPDATE patients SET ${kind.column} = $2,
              id_pending = CASE WHEN $3 THEN FALSE ELSE id_pending END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id_pending, id_doc_id, scheme_card_doc_id`,
      [patient.id, doc[0].id, clearsPending],
    );
    await client.query("COMMIT");
    return { document_id: doc[0].id, kind: kindKey, ...shape(rows[0]) };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
