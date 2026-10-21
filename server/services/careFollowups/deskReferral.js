import pool from "../../config/db.js";

export const DESK_KEY_PREFIX = "gf:";

export const deskReferralId = (sourceKey) =>
  String(sourceKey || "").startsWith(DESK_KEY_PREFIX)
    ? sourceKey.slice(DESK_KEY_PREFIX.length)
    : null;

export async function markDeskBookedAtGhm(db = pool, sourceKey, { day, doctor_name, time_slot }) {
  const id = deskReferralId(sourceKey);
  if (!id || !day) return 0;
  const note = [`Booked at GHM with ${doctor_name || "GHM"}`, time_slot]
    .filter(Boolean)
    .join(" · ");
  const { rowCount } = await db.query(
    `UPDATE giniflow_referrals
        SET status = 'appointment_booked', appointment_date = $2::date,
            appointment_note = $3, updated_at = NOW()
      WHERE id = $1::uuid AND status IN ('created', 'letter_generated')`,
    [id, day, note],
  );
  return rowCount;
}
