import pool from "../../config/db.js";

export const templatesEnabled = () =>
  String(process.env.SLOT_TEMPLATES || "on").toLowerCase() !== "off";

export async function activeTemplates(doctorIds, dateISO, { client = pool } = {}) {
  const found = new Map();
  if (!templatesEnabled() || !doctorIds.length) return found;
  const { rows } = await client.query(
    `SELECT DISTINCT ON (t.doctor_id) t.id, t.doctor_id, t.effective_from::text, t.partial_last,
            COALESCE((to_jsonb(t) ->> 'clears')::boolean, FALSE) AS clears
       FROM doctor_slot_templates t
      WHERE t.doctor_id = ANY($1::int[]) AND t.status = 'active' AND t.effective_from <= $2::date
      ORDER BY t.doctor_id, t.effective_from DESC`,
    [doctorIds, dateISO],
  );
  for (const t of await withRules(
    client,
    rows.filter((r) => !r.clears),
  ))
    found.set(t.doctorId, t);
  return found;
}

async function withRules(client, rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [hours, breaks] = await Promise.all([
    client.query(
      `SELECT template_id, weekday, start_time::text AS start, end_time::text AS end, slot_minutes,
              (to_jsonb(h) ->> 'cap_new')::int AS cap_new,
              (to_jsonb(h) ->> 'cap_followup')::int AS cap_followup,
              (to_jsonb(h) ->> 'cap_walkin')::int AS cap_walkin
         FROM doctor_slot_template_hours h WHERE template_id = ANY($1::int[])
        ORDER BY weekday, start_time`,
      [ids],
    ),
    client.query(
      `SELECT template_id, weekday, name, start_time::text AS start, end_time::text AS end
         FROM doctor_slot_template_breaks WHERE template_id = ANY($1::int[])
        ORDER BY start_time, id`,
      [ids],
    ),
  ]);
  const hhmm = (t) => String(t).slice(0, 5);
  return rows.map((r) => ({
    id: r.id,
    doctorId: r.doctor_id,
    effectiveFrom: r.effective_from,
    partialLast: r.partial_last,
    hours: hours.rows
      .filter((h) => h.template_id === r.id)
      .map((h) => ({
        weekday: h.weekday,
        start: hhmm(h.start),
        end: hhmm(h.end),
        slotMinutes: h.slot_minutes,
        ...(h.cap_new != null || h.cap_followup != null || h.cap_walkin != null
          ? { capNew: h.cap_new, capFollowup: h.cap_followup, capWalkin: h.cap_walkin }
          : {}),
      })),
    breaks: breaks.rows
      .filter((b) => b.template_id === r.id)
      .map((b) => ({ weekday: b.weekday, name: b.name, start: hhmm(b.start), end: hhmm(b.end) })),
  }));
}

export async function templateVersions(doctorId, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT t.id, t.doctor_id, t.effective_from::text, t.partial_last, t.status, t.note,
            COALESCE((to_jsonb(t) ->> 'clears')::boolean, FALSE) AS clears,
            t.created_at, t.withdrawn_at, c.name AS created_by_name, w.name AS withdrawn_by_name
       FROM doctor_slot_templates t
       LEFT JOIN doctors c ON c.id = t.created_by
       LEFT JOIN doctors w ON w.id = t.withdrawn_by
      WHERE t.doctor_id = $1
      ORDER BY t.effective_from DESC, t.created_at DESC`,
    [doctorId],
  );
  const rules = new Map((await withRules(client, rows)).map((t) => [t.id, t]));
  return rows.map((r) => ({
    ...rules.get(r.id),
    clears: r.clears,
    status: r.status,
    note: r.note,
    createdAt: r.created_at,
    createdBy: r.created_by_name,
    withdrawnAt: r.withdrawn_at,
    withdrawnBy: r.withdrawn_by_name,
  }));
}
