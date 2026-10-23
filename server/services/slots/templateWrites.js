import { validateTemplate } from "../../../shared/slotTemplates.js";
import { columnReady } from "./readiness.js";

export const clearsReady = columnReady("doctor_slot_templates", "clears");

const hasHourCaps = (h) => h.capNew != null || h.capFollowup != null || h.capWalkin != null;

export const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function insertTemplateVersion(
  client,
  doctorId,
  template,
  { effectiveFrom, note, actorId },
) {
  await client.query(
    `UPDATE doctor_slot_templates
        SET status = 'withdrawn', withdrawn_at = NOW(), withdrawn_by = $3
      WHERE doctor_id = $1 AND effective_from = $2::date AND status = 'active'`,
    [doctorId, effectiveFrom, actorId],
  );
  const { rows } = await client
    .query(
      `INSERT INTO doctor_slot_templates (doctor_id, effective_from, partial_last, note, created_by)
       VALUES ($1, $2::date, $3, $4, $5) RETURNING id`,
      [doctorId, effectiveFrom, template.partialLast || "drop", note, actorId],
    )
    .catch((e) => {
      if (e.code === "23505")
        throw Object.assign(
          new Error("Someone else saved this schedule at the same moment. Reload and try again."),
          { status: 409 },
        );
      throw e;
    });
  const id = rows[0].id;
  await client.query(
    template.hours.some(hasHourCaps)
      ? `INSERT INTO doctor_slot_template_hours
           (template_id, weekday, start_time, end_time, slot_minutes, cap_new, cap_followup, cap_walkin)
         SELECT $1, x.weekday, x.start::time, x."end"::time, x."slotMinutes",
                x."capNew", x."capFollowup", x."capWalkin"
           FROM jsonb_to_recordset($2::jsonb) AS x(weekday int, start text, "end" text,
                "slotMinutes" int, "capNew" int, "capFollowup" int, "capWalkin" int)`
      : `INSERT INTO doctor_slot_template_hours (template_id, weekday, start_time, end_time, slot_minutes)
         SELECT $1, x.weekday, x.start::time, x."end"::time, x."slotMinutes"
           FROM jsonb_to_recordset($2::jsonb) AS x(weekday int, start text, "end" text, "slotMinutes" int)`,
    [id, JSON.stringify(template.hours)],
  );
  await client.query(
    `INSERT INTO doctor_slot_template_breaks (template_id, weekday, name, start_time, end_time)
     SELECT $1, x.weekday, x.name, x.start::time, x."end"::time
       FROM jsonb_to_recordset($2::jsonb) AS x(weekday int, name text, start text, "end" text)`,
    [id, JSON.stringify(template.breaks || [])],
  );
  return id;
}

export const templateErrors = (template) => {
  const errors = validateTemplate(template);
  return errors.length
    ? Object.assign(new Error(errors[0].message), { status: 400, errors })
    : null;
};

export async function withdrawFutureVersion(client, doctorId, templateId, actorId) {
  const { rows } = await client.query(
    `UPDATE doctor_slot_templates
        SET status = 'withdrawn', withdrawn_at = NOW(), withdrawn_by = $3
      WHERE id = $1 AND doctor_id = $2 AND status = 'active' AND effective_from > $4::date
      RETURNING id`,
    [templateId, doctorId, actorId, istToday()],
  );
  if (!rows.length)
    throw Object.assign(
      new Error("Only a schedule that has not started yet can be withdrawn. Reload and try again."),
      { status: 409 },
    );
  return rows[0].id;
}

export async function clearScheduleFrom(client, doctorId, { effectiveFrom, actorId }) {
  const withdrawn = await client.query(
    `UPDATE doctor_slot_templates
        SET status = 'withdrawn', withdrawn_at = NOW(), withdrawn_by = $3
      WHERE doctor_id = $1 AND status = 'active' AND effective_from >= $2::date
      RETURNING clears`,
    [doctorId, effectiveFrom, actorId],
  );
  const before = await client.query(
    `SELECT clears FROM doctor_slot_templates
      WHERE doctor_id = $1 AND status = 'active' AND effective_from < $2::date
      ORDER BY effective_from DESC LIMIT 1`,
    [doctorId, effectiveFrom],
  );
  const stillScheduled = before.rows[0] && !before.rows[0].clears;
  const withdrewSchedule = withdrawn.rows.some((r) => !r.clears);
  if (!stillScheduled && !withdrewSchedule)
    throw Object.assign(new Error("There is no schedule to clear from that date."), {
      status: 409,
    });
  if (stillScheduled)
    await client.query(
      `INSERT INTO doctor_slot_templates (doctor_id, effective_from, clears, note, created_by)
       VALUES ($1, $2::date, TRUE, 'Schedule cleared', $3)`,
      [doctorId, effectiveFrom, actorId],
    );
  return { withdrawn: withdrawn.rows.filter((r) => !r.clears).length, cleared: true };
}
