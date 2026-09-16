import { withCrmContext } from "./db.js";
import {
  REFERRAL_SOURCE_VALUES,
  REFERRAL_STATUS_VALUES,
  URGENCY_VALUES,
} from "../../shared/crmVocab.js";

// Referral capture and the patient journey (brief §6, §7).
//
// The unit of account for the whole CRM. A visit is effort; a referral is the
// result, and §6 is blunt about where doctor CRMs die: attribution. So every
// referral here is either *claimed* — a rep's word for it — or *verified*,
// confirmed at registration. The two are never added together, and the one that
// counts is verified.

const clean = (v) => {
  const t = String(v ?? "").trim();
  return t === "" ? null : t;
};

/**
 * Log a referral. Claimed by default: a rep saying a doctor sent someone is a
 * claim until the patient turns up and says so themselves.
 */
export async function createReferral(crmUser, input) {
  const {
    referring_doctor_id,
    patient_name,
    patient_phone,
    reason_category,
    service_line_id,
    urgency = "routine",
    expected_action,
    source = "direct_doctor",
    is_self_referral = false,
  } = input;

  if (!referring_doctor_id && !is_self_referral) throw new Error("Pick the referring doctor");
  if (!clean(patient_name) && !clean(patient_phone)) {
    throw new Error("A referral needs a patient name or a phone number");
  }
  if (!URGENCY_VALUES.includes(urgency)) throw new Error(`Unknown urgency: ${urgency}`);
  if (!REFERRAL_SOURCE_VALUES.includes(source)) throw new Error(`Unknown source: ${source}`);

  return withCrmContext(crmUser, async (sql) => {
    const { rows: hos } = await sql("SELECT id FROM crm.hospitals WHERE code = 'GACH'");
    const { rows } = await sql(
      `INSERT INTO crm.doctor_referrals
         (hospital_id, referring_doctor_id, is_self_referral, source,
          patient_name_raw, patient_phone_raw, reason_category, service_line_id,
          urgency, expected_action, responsible_executive_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new',$11)
       RETURNING id, referral_code, status, attribution_status, referred_at`,
      [
        hos[0]?.id,
        referring_doctor_id ?? null,
        Boolean(is_self_referral),
        source,
        clean(patient_name),
        clean(patient_phone),
        clean(reason_category),
        service_line_id ?? null,
        urgency,
        clean(expected_action),
        // The rep who logged it owns the follow-up. A referral with nobody
        // responsible is the one nobody chases.
        crmUser.id,
      ],
    );

    // The opening journey entry, so the timeline starts where the referral did
    // rather than at whatever moved it first.
    await sql(
      `INSERT INTO crm.referral_journey_events
         (hospital_id, referral_id, status, occurred_at, notes, source, recorded_by)
       VALUES ($1, $2, 'new', now(), 'Logged by the growth team', 'manual', $3)`,
      [hos[0]?.id, rows[0].id, crmUser.id],
    );
    return rows[0];
  });
}

/**
 * Move a referral along the funnel. `lost` is the only status that demands a
 * reason, and the database enforces that rather than trusting this to remember
 * — §7 calls it mandatory because "lost, no reason" is how a leakage report
 * becomes a list of shrugs.
 */
export async function advanceReferral(crmUser, referralId, { status, notes, lost_reason }) {
  if (!REFERRAL_STATUS_VALUES.includes(status)) throw new Error(`Unknown status: ${status}`);
  if (status === "lost" && !clean(lost_reason)) throw new Error("A lost referral needs a reason");

  return withCrmContext(crmUser, async (sql) => {
    const { rows: ref } = await sql(
      "SELECT id, hospital_id, status FROM crm.doctor_referrals WHERE id = $1 AND deleted_at IS NULL",
      [referralId],
    );
    if (!ref[0]) throw new Error("Referral not found, or not yours");
    if (ref[0].status === status) return { ...ref[0], unchanged: true };

    await sql(
      `INSERT INTO crm.referral_journey_events
         (hospital_id, referral_id, status, occurred_at, notes, lost_reason, source, recorded_by)
       VALUES ($1, $2, $3, now(), $4, $5, 'manual', $6)`,
      [ref[0].hospital_id, referralId, status, clean(notes), clean(lost_reason), crmUser.id],
    );

    // The trigger on referral_journey_events moves the referral itself, so read
    // it back rather than assuming.
    const { rows } = await sql(
      `SELECT id, referral_code, status, status_changed_at, lost_reason
         FROM crm.doctor_referrals WHERE id = $1`,
      [referralId],
    );
    return { ...rows[0], unchanged: false };
  });
}

export async function openReferrals(crmUser, { limit = 50 } = {}) {
  return withCrmContext(crmUser, async (sql) => {
    const [open, counts] = await Promise.all([
      sql("SELECT * FROM crm.v_open_referrals LIMIT $1", [Math.min(Number(limit) || 50, 200)]),
      sql(
        `SELECT count(*)::int AS open,
                count(*) FILTER (WHERE status = 'new')::int AS untouched,
                count(*) FILTER (WHERE urgency IN ('urgent','emergency'))::int AS urgent,
                count(*) FILTER (WHERE attribution_status = 'verified')::int AS verified
           FROM crm.v_open_referrals`,
      ),
    ]);
    return { referrals: open.rows, summary: counts.rows[0] };
  });
}

export async function referralDetail(crmUser, referralId) {
  return withCrmContext(crmUser, async (sql) => {
    const [ref, events] = await Promise.all([
      sql(
        `SELECT r.*, d.full_name AS doctor_name, sl.name AS service_line_name,
                u.full_name AS responsible_name
           FROM crm.doctor_referrals r
           LEFT JOIN crm.doctors d ON d.id = r.referring_doctor_id
           LEFT JOIN crm.service_lines sl ON sl.id = r.service_line_id
           LEFT JOIN crm.users u ON u.id = r.responsible_executive_id
          WHERE r.id = $1 AND r.deleted_at IS NULL`,
        [referralId],
      ),
      sql(
        `SELECT e.status, e.occurred_at, e.notes, e.lost_reason, e.source,
                u.full_name AS recorded_by_name
           FROM crm.referral_journey_events e
           LEFT JOIN crm.users u ON u.id = e.recorded_by
          WHERE e.referral_id = $1 ORDER BY e.occurred_at DESC`,
        [referralId],
      ),
    ]);
    if (!ref.rows[0]) throw new Error("Referral not found, or not yours");
    return { referral: ref.rows[0], journey: events.rows };
  });
}

/** The service lines the referral form offers as chips. */
export async function serviceLines(crmUser) {
  return withCrmContext(crmUser, async (sql) => {
    const { rows } = await sql(
      `SELECT id, name, code FROM crm.service_lines
        WHERE deleted_at IS NULL AND is_active ORDER BY sort_order, name`,
    );
    return rows;
  });
}
