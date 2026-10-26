import pool from "../config/db.js";
import { ALLERGY_STATES } from "../../shared/giniflowAllergy.js";

export async function savePatientAllergy(
  patientId,
  { status, note = null, actorId = null },
  db = pool,
) {
  if (!ALLERGY_STATES.includes(status)) {
    throw Object.assign(new Error(`Unknown allergy state: ${status}`), { status: 400 });
  }
  if (status === "known" && !note?.trim()) {
    throw Object.assign(new Error("Name the allergy before recording it"), { status: 400 });
  }
  const { rows } = await db.query(
    `UPDATE patients p
        SET allergy_status = CASE
              WHEN $2 = 'not_known' AND p.allergy_status IS NOT NULL THEN p.allergy_status
              ELSE $2 END,
            allergy_note = CASE
              WHEN $2 = 'known' THEN $3
              WHEN $2 = 'none_known' THEN NULL
              ELSE p.allergy_note END,
            allergy_asked_at = CASE WHEN $2 = 'not_known' THEN p.allergy_asked_at ELSE NOW() END,
            allergy_asked_by = CASE WHEN $2 = 'not_known' THEN p.allergy_asked_by ELSE $4 END
      WHERE p.id = $1
      RETURNING p.allergy_status, p.allergy_note`,
    [patientId, status, note?.trim() || null, actorId],
  );
  if (!rows.length) throw Object.assign(new Error("Patient not found"), { status: 404 });
  return rows[0];
}
