import pool from "../../config/db.js";
import { SCHEDULED_ROLES } from "../../../shared/staffRoles.js";
import { activeTemplates } from "./templateStore.js";
import { bookingsOutsideTemplate } from "./bookingImpact.js";
import { insertTemplateVersion } from "./templateWrites.js";

export { APPLY_BATCH } from "../../../shared/slotTemplates.js";

const rulesKey = (t) =>
  JSON.stringify({
    partialLast: t.partialLast || "drop",
    hours: [...t.hours]
      .map((h) => [
        h.weekday,
        h.start,
        h.end,
        Number(h.slotMinutes),
        h.capNew ?? null,
        h.capFollowup ?? null,
        h.capWalkin ?? null,
      ])
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])),
    breaks: [...(t.breaks || [])]
      .map((b) => [b.weekday ?? -1, b.start, b.end, String(b.name).trim()])
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[3].localeCompare(b[3])),
  });

export async function scheduledDoctors(doctorIds, { client = pool } = {}) {
  const { rows } = await client.query(
    `SELECT id, name, role, specialty FROM doctors
      WHERE is_active AND role = ANY($1) AND ($2::int[] IS NULL OR id = ANY($2))
      ORDER BY name`,
    [SCHEDULED_ROLES, doctorIds],
  );
  return rows;
}

const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const prettyDay = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

async function planFor(doctorIds, template, from, until, client) {
  const key = rulesKey(template);
  const after = until ? shiftDay(until, 1) : null;
  const [atFrom, atAfter, before, inside] = await Promise.all([
    activeTemplates(doctorIds, from, { client }),
    after ? activeTemplates(doctorIds, after, { client }) : new Map(),
    after ? activeTemplates(doctorIds, shiftDay(from, -1), { client }) : new Map(),
    after
      ? client.query(
          `SELECT doctor_id, min(effective_from)::text AS starts
             FROM doctor_slot_templates
            WHERE doctor_id = ANY($1) AND status = 'active'
              AND effective_from > $2::date AND effective_from <= $3::date
            GROUP BY doctor_id`,
          [doctorIds, from, until],
        )
      : { rows: [] },
  ]);
  const insideStart = new Map(inside.rows.map((r) => [r.doctor_id, r.starts]));
  const plans = new Map();
  for (const id of doctorIds) {
    const cur = atFrom.get(id);
    const sameStart = !!cur && cur.effectiveFrom === from && rulesKey(cur) === key;
    let restore = null;
    let conflict = null;
    if (after) {
      const back = atAfter.get(id);
      const restoreExists = !!back && back.effectiveFrom === after;
      if (insideStart.has(id))
        conflict = `Has a schedule change starting ${prettyDay(insideStart.get(id))}, inside this period. Withdraw it on their Schedule tab or untick this doctor.`;
      else if (!restoreExists) {
        restore = back && back.effectiveFrom < from ? back : before.get(id) || null;
        if (!restore) conflict = "Has no earlier schedule to go back to after the end date.";
      }
      plans.set(id, { unchanged: sameStart && restoreExists, conflict, restore, after });
    } else plans.set(id, { unchanged: sameStart, conflict: null, restore: null, after: null });
  }
  return plans;
}

export async function previewApply(doctors, template, effectiveFrom, until = null) {
  const plans = await planFor(
    doctors.map((d) => d.id),
    template,
    effectiveFrom,
    until,
    pool,
  );
  const out = [];
  for (const d of doctors) {
    const plan = plans.get(d.id);
    const impact = plan.unchanged
      ? { affected: [], unreadable: 0, until: null }
      : await bookingsOutsideTemplate(d.id, template, effectiveFrom, {
          endExclusive: plan.after,
        });
    out.push({
      doctor_id: d.id,
      doctor_name: d.name,
      unchanged: plan.unchanged,
      conflict: plan.conflict,
      ...impact,
    });
  }
  return out;
}

export async function applyBatch(
  doctors,
  template,
  effectiveFrom,
  { note, actorId, until = null },
) {
  const plans = await planFor(
    doctors.map((d) => d.id),
    template,
    effectiveFrom,
    until,
    pool,
  );
  const saved = [];
  const skipped = [];
  for (const d of doctors) {
    const plan = plans.get(d.id);
    if (plan.unchanged) {
      skipped.push(d.id);
      continue;
    }
    if (plan.conflict)
      return {
        saved,
        skipped,
        failed: { doctor_id: d.id, doctor_name: d.name, error: plan.conflict },
      };
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await insertTemplateVersion(client, d.id, template, {
        effectiveFrom,
        note: until ? note || `Until ${prettyDay(until)}` : note,
        actorId,
      });
      if (plan.restore)
        await insertTemplateVersion(client, d.id, plan.restore, {
          effectiveFrom: plan.after,
          note: `Back to the usual schedule after ${prettyDay(until)}`,
          actorId,
        });
      await client.query("COMMIT");
      saved.push(d.id);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      return {
        saved,
        skipped,
        failed: {
          doctor_id: d.id,
          doctor_name: d.name,
          error: e.status ? e.message : "Could not save this doctor's schedule.",
        },
      };
    } finally {
      client.release();
    }
  }
  return { saved, skipped, failed: null };
}
