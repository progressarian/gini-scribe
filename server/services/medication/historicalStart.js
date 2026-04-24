// ── Historical started_date lookup ──────────────────────────────────────────
// When a patient's prescription is re-extracted or re-synced, each medication's
// `started_date` should be the EARLIEST time we've ever seen that drug in this
// patient's chart — not the current prescription's date. Two sources:
//
//   1. `medications` rows (any source, active or stopped) with a matching
//      canonical key — use MIN(started_date).
//   2. Prior `documents.extracted_data->'medications'` on prescription docs
//      for the same patient — use MIN(doc_date). Catches drugs whose original
//      medications row was deleted by a re-extract/sweep cycle.
//
// Callers pass the DB client (so this can run inside a transaction) and a list
// of canonical keys they're about to insert. Returns a Map<canonical, ISO-date>
// with the earliest known date per canonical, or empty map if none.

import { canonicalMedKey, stripFormPrefix } from "./normalize.js";

function toISO(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * @param {import("pg").PoolClient | import("pg").Pool} db
 * @param {number} patientId
 * @param {string[]} canonicalKeys — already uppercased canonical names
 * @param {number|null} excludeDocId — skip this prescription doc (the one we're about to write)
 * @returns {Promise<Map<string, string>>} canonical → ISO date
 */
export async function findEarliestStartDates(db, patientId, canonicalKeys, excludeDocId = null) {
  const out = new Map();
  if (!patientId || !Array.isArray(canonicalKeys) || canonicalKeys.length === 0) return out;

  // Source 1: existing medications rows.
  const { rows: medRows } = await db.query(
    `SELECT UPPER(COALESCE(pharmacy_match, name)) AS k, MIN(started_date) AS earliest
       FROM medications
      WHERE patient_id = $1
        AND UPPER(COALESCE(pharmacy_match, name)) = ANY($2::text[])
        AND started_date IS NOT NULL
      GROUP BY UPPER(COALESCE(pharmacy_match, name))`,
    [patientId, canonicalKeys],
  );
  for (const r of medRows) {
    const iso = toISO(r.earliest);
    if (iso) out.set(r.k, iso);
  }

  // Source 2: prior prescription docs' extracted medication names.
  const { rows: docRows } = await db.query(
    `SELECT id, doc_date, extracted_data
       FROM documents
      WHERE patient_id = $1
        AND doc_type = 'prescription'
        AND doc_date IS NOT NULL
        AND extracted_data IS NOT NULL
        AND ($2::int IS NULL OR id <> $2)`,
    [patientId, excludeDocId],
  );
  for (const r of docRows) {
    let ext = r.extracted_data;
    if (typeof ext === "string") {
      try {
        ext = JSON.parse(ext);
      } catch {
        continue;
      }
    }
    const meds = Array.isArray(ext?.medications) ? ext.medications : [];
    if (meds.length === 0) continue;
    const docDateISO = toISO(r.doc_date);
    if (!docDateISO) continue;
    for (const em of meds) {
      if (!em?.name) continue;
      const { name: cleanName } = stripFormPrefix(em.name);
      const k = canonicalMedKey(cleanName || em.name).slice(0, 200);
      if (!canonicalKeys.includes(k)) continue;
      const existing = out.get(k);
      if (!existing || docDateISO < existing) out.set(k, docDateISO);
    }
  }

  return out;
}

/**
 * Resolve the started_date for a single medication:
 *   = min(earliest-known-from-history, current-prescription-date)
 *   = currentRxDate if no history found.
 *
 * @param {Map<string, string>} earliestByKey — from findEarliestStartDates
 * @param {string} canonical — uppercase canonical key
 * @param {string} currentRxDate — ISO date for the current prescription
 */
export function resolveStartedDate(earliestByKey, canonical, currentRxDate) {
  const prior = earliestByKey.get(canonical);
  if (!prior) return currentRxDate;
  return prior < currentRxDate ? prior : currentRxDate;
}
