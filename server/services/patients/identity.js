import pool from "../../config/db.js";
import { encryptAadhaar, encryptionReady } from "../../utils/aadhaarCrypt.js";
import {
  aadhaarDigits,
  cleanGovtId,
  identityProblems,
  schemeNeedsCard,
} from "../../../shared/patientIdentity.js";

const clean = (v) => (v == null ? "" : String(v).trim());

export async function loadActiveScheme(code, db = pool) {
  if (!code) return null;
  const { rows } = await db.query(
    `SELECT s.code, s.parent_code, s.requires_ref FROM patient_schemes s
       LEFT JOIN patient_schemes p ON p.code = s.parent_code
      WHERE s.code = $1 AND s.is_active AND COALESCE(p.is_active, TRUE)`,
    [code],
  );
  return rows[0] || null;
}

export async function checkNewPatientIdentity(p, db = pool) {
  const identity = {
    scheme_code: clean(p.scheme_code),
    scheme_ref: clean(p.scheme_ref),
    aadhaar: aadhaarDigits(p.aadhaar),
    govt_id_type: clean(p.govt_id_type),
    govt_id: cleanGovtId(p.govt_id),
  };
  const scheme = await loadActiveScheme(identity.scheme_code, db);
  if (identity.scheme_code && !scheme) {
    return { fields: { scheme_code: "Choose a category from the list." } };
  }
  const fields = identityProblems(identity, { requiresCard: needsCard(scheme) });
  if (Object.keys(fields).length) return { fields };
  if ((identity.aadhaar || identity.scheme_ref) && !encryptionReady()) {
    return {
      status: 409,
      error: "ID numbers can't be stored until the encryption key is set; ask an admin.",
    };
  }
  return { identity, requiredScan: requiredScanKind(identity.scheme_code, scheme) };
}

const needsCard = (scheme) =>
  schemeNeedsCard(scheme?.code, scheme?.parent_code, scheme?.requires_ref);

export const requiredScanKind = (schemeCode, scheme) =>
  !schemeCode ? "id_proof" : needsCard(scheme) ? "scheme_card" : null;

export const identityFailure = (res, { status = 400, error, fields }) =>
  res.status(status).json({
    error: error || Object.values(fields)[0],
    fields,
  });

export const sealIdentity = (value) => (clean(value) ? encryptAadhaar(clean(value)) : null);
