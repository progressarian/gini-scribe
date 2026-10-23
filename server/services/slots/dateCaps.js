import pool from "../../config/db.js";
import { dateCapsReady } from "./readiness.js";
import { istToday } from "./templateWrites.js";

const hhmm = (t) => String(t).slice(0, 5);

export async function dateCapsOn(doctorIds, dates, { client = pool } = {}) {
  const found = new Map();
  if (!doctorIds.length || !dates.length || !(await dateCapsReady(client))) return found;
  const { rows } = await client.query(
    `SELECT c.doctor_id, c.slot_date::text AS day, c.slot_start::text AS start, c.cap_new,
            c.cap_followup, c.cap_walkin, c.cap_within3, c.reason, c.created_at, d.name AS created_by
       FROM doctor_slot_date_caps c
       LEFT JOIN doctors d ON d.id = c.created_by
      WHERE c.doctor_id = ANY($1::int[]) AND c.slot_date = ANY($2::date[])
      ORDER BY c.slot_start`,
    [doctorIds, dates],
  );
  for (const r of rows) {
    const key = `${r.doctor_id}|${r.day}`;
    if (!found.has(key)) found.set(key, []);
    found.get(key).push({
      start: hhmm(r.start),
      capNew: r.cap_new,
      capFollowup: r.cap_followup,
      capWalkin: r.cap_walkin,
      capWithin3: r.cap_within3,
      reason: r.reason,
      createdBy: r.created_by,
      createdAt: r.created_at,
    });
  }
  return found;
}

const refusePast = (date) => {
  if (date < istToday())
    throw Object.assign(new Error("A past date can't be changed."), { status: 400 });
};

const needsMigration = () =>
  Object.assign(
    new Error(
      "Changing one date's limits needs a database update first. Ask an administrator to run the slot migration.",
    ),
    { status: 409 },
  );

export async function saveDateCaps(doctorId, date, { slots, reason }, actorId) {
  refusePast(date);
  if (!(await dateCapsReady())) throw needsMigration();
  const { rows } = await pool.query(
    `INSERT INTO doctor_slot_date_caps
       (doctor_id, slot_date, slot_start, cap_new, cap_followup, cap_walkin, cap_within3, reason, created_by)
     SELECT $1, $2::date, x.start::time, x."capNew", x."capFollowup", x."capWalkin", x."capWithin3", $4, $5
       FROM jsonb_to_recordset($3::jsonb) AS x(start text, "capNew" int, "capFollowup" int,
            "capWalkin" int, "capWithin3" int)
     ON CONFLICT (doctor_id, slot_date, slot_start) DO UPDATE
       SET cap_new = EXCLUDED.cap_new, cap_followup = EXCLUDED.cap_followup,
           cap_walkin = EXCLUDED.cap_walkin, cap_within3 = EXCLUDED.cap_within3,
           reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = NOW()
     RETURNING slot_start::text AS start`,
    [doctorId, date, JSON.stringify(slots), reason.trim(), actorId],
  );
  return rows.length;
}

export async function clearDateCap(doctorId, date, start) {
  refusePast(date);
  if (!(await dateCapsReady())) throw needsMigration();
  const { rowCount } = await pool.query(
    `DELETE FROM doctor_slot_date_caps
      WHERE doctor_id = $1 AND slot_date = $2::date AND slot_start = $3::time`,
    [doctorId, date, start],
  );
  if (!rowCount)
    throw Object.assign(new Error("This slot already uses the weekly numbers."), { status: 404 });
  return rowCount;
}
