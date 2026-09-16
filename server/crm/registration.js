import { withRegistrationContext } from "./db.js";
import { REFERRAL_ANSWER_TYPE_VALUES } from "../../shared/crmVocab.js";

// "Who referred you?" at patient registration — the CRM's primary attribution
// source. A rep-logged referral is only ever *claimed* until something confirms
// it, and this answer is what confirms it, so a registration desk that skips
// the question leaves every referral unverified and the Doctor 360 revenue
// figures unusable.
//
// Both calls run as crm_registration, which can execute the picker and insert
// an answer and nothing else. See 2026-10-01_crm_registration.sql.

const HOSPITAL_CODE = "GACH";

export async function searchReferringDoctors(query, limit = 10) {
  const q = (query || "").trim();
  if (q.length < 2) return [];
  return withRegistrationContext(async (sql) => {
    const { rows } = await sql("SELECT * FROM crm.search_doctors_for_registration($1, $2)", [
      q,
      limit,
    ]);
    return rows;
  });
}

/**
 * Record what the patient said. Returns false when the CRM is not installed,
 * so a Scribe deployment without the crm schema still registers patients.
 *
 * An absent row and a `none_self` row mean different things and must not be
 * conflated: `none_self` is a patient saying nobody referred them, while no row
 * at all means nobody was asked — which is what the unattended creation paths
 * (appointment booking, consultation save, HealthRay and Sheets sync) leave
 * behind, and what crm.v_attribution_unknown exists to surface.
 */
export async function recordReferralSource(patientId, answer, capturedBy = null) {
  if (!patientId || !answer?.answer_type) return false;
  if (!REFERRAL_ANSWER_TYPE_VALUES.includes(answer.answer_type)) {
    throw new Error(`Unknown referral answer type: ${answer.answer_type}`);
  }

  const doctorId = answer.answer_type === "doctor" ? answer.doctor_id || null : null;
  const freeText = answer.answer_type === "free_text" ? (answer.free_text || "").trim() : null;
  if (answer.answer_type === "doctor" && !doctorId) throw new Error("Pick a doctor");
  if (answer.answer_type === "free_text" && !freeText) throw new Error("Say who referred them");

  try {
    return await withRegistrationContext(async (sql) => {
      const { rows } = await sql(
        "SELECT crm.record_referral_source($1, $2, $3, $4, $5) AS recorded",
        [patientId, answer.answer_type, doctorId, freeText, capturedBy],
      );
      return rows[0]?.recorded === true;
    });
  } catch (err) {
    // Never fail a patient registration because the growth CRM is unavailable.
    // The patient still gets a chart; the row lands in the attribution-unknown
    // queue, which is the same place every unattended path lands.
    if (err.code === "3F000" || err.code === "42P01") return false;
    console.error("CRM referral source not recorded:", err.message);
    return false;
  }
}
