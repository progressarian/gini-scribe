import pool from "../../config/db.js";
import { SCHEDULED_ROLES } from "../../../shared/staffRoles.js";
import { activeTemplates } from "./templateStore.js";
import { bookingsOutsideTemplate } from "./bookingImpact.js";
import {
  clearsReady,
  insertClearVersion,
  insertTemplateVersion,
  laterVersions,
  withdrawLaterVersions,
} from "./templateWrites.js";

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

async function inEffectOn(doctorIds, date, client) {
  const { rows } = await client.query(
    `SELECT DISTINCT ON (doctor_id) doctor_id, effective_from::text,
            COALESCE((to_jsonb(t) ->> 'clears')::boolean, FALSE) AS clears
       FROM doctor_slot_templates t
      WHERE doctor_id = ANY($1::int[]) AND status = 'active' AND effective_from <= $2::date
      ORDER BY doctor_id, effective_from DESC`,
    [doctorIds, date],
  );
  return new Map(rows.map((r) => [r.doctor_id, r]));
}

async function planFor(doctorIds, template, from, until, client) {
  const key = rulesKey(template);
  const after = until ? shiftDay(until, 1) : null;
  const [atFrom, later, rawAfter, rulesAfter, canClear] = await Promise.all([
    activeTemplates(doctorIds, from, { client }),
    laterVersions(doctorIds, from, until, { client }),
    after ? inEffectOn(doctorIds, after, client) : new Map(),
    after ? activeTemplates(doctorIds, after, { client }) : new Map(),
    after ? clearsReady() : false,
  ]);
  const plans = new Map();
  for (const id of doctorIds) {
    const cur = atFrom.get(id);
    const replaces = later
      .filter((v) => v.doctor_id === id)
      .map((v) => ({ effectiveFrom: v.effective_from, clears: v.clears }));
    const sameStart =
      !!cur && cur.effectiveFrom === from && rulesKey(cur) === key && !replaces.length;
    let restore = null;
    let restoreClear = false;
    let conflict = null;
    let restoreExists = true;
    if (after) {
      const back = rawAfter.get(id);
      restoreExists = !!back && back.effective_from === after;
      if (!restoreExists) {
        if (!back) conflict = "Has no earlier schedule to go back to after the end date.";
        else if (back.clears) {
          if (canClear) restoreClear = true;
          else
            conflict =
              "Its schedule is cleared after the end date; run the clear-schedule update first.";
        } else restore = rulesAfter.get(id) || null;
      }
    }
    plans.set(id, {
      unchanged: sameStart && restoreExists,
      conflict,
      restore,
      restoreClear,
      replaces,
      after,
    });
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
      replaces: plan.replaces,
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
      await withdrawLaterVersions(client, d.id, effectiveFrom, until, actorId);
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
      if (plan.restoreClear)
        await insertClearVersion(
          client,
          d.id,
          plan.after,
          `Schedule cleared again after ${prettyDay(until)}`,
          actorId,
        );
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
