import pool from "../../config/db.js";
import { ATTEMPT_OUTCOMES } from "../../../shared/callStatuses.js";
import { ACTIVE_STATUSES, CLOSE_OUTCOMES } from "../../../shared/careFollowups.js";
import { markDeskBookedAtGhm } from "./deskReferral.js";

const fail = (status, message) => Object.assign(new Error(message), { status });

async function withItem(id, ctx, db, work) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT * FROM care_followups WHERE id = $1 FOR UPDATE`, [
      id,
    ]);
    if (!rows.length) throw fail(404, "Follow-up not found");
    const result = await work(client, rows[0]);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const event = (client, id, ctx, fields) =>
  client.query(
    `INSERT INTO care_followup_events
       (followup_id, kind, call_status, from_status, to_status, note, actor_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      fields.kind,
      fields.callStatus ?? null,
      fields.from ?? null,
      fields.to ?? null,
      fields.note ?? null,
      ctx.actorId ?? null,
    ],
  );

const refuseClosed = (item) => {
  if (!ACTIVE_STATUSES.includes(item.status)) {
    throw fail(409, "This follow-up is already closed — reopen it first");
  }
};

export function logCall(id, { call_status, note = null }, ctx = {}, db = pool) {
  if (!ATTEMPT_OUTCOMES.some((o) => o.value === call_status)) {
    throw fail(400, "Choose how the call went");
  }
  return withItem(id, ctx, db, async (client, item) => {
    refuseClosed(item);
    await client.query(
      `UPDATE care_followups
          SET attempts = attempts + 1, last_call_status = $2, last_call_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [id, call_status],
    );
    await event(client, id, ctx, { kind: "call", callStatus: call_status, note });
    return { id, attempts: item.attempts + 1, lastCall: call_status };
  });
}

export function closeWith(id, { status, reason }, ctx = {}, db = pool) {
  if (!CLOSE_OUTCOMES.some((o) => o.value === status)) throw fail(400, "Choose an outcome");
  return withItem(id, ctx, db, async (client, item) => {
    refuseClosed(item);
    await client.query(
      `UPDATE care_followups SET status = $2, outcome_reason = $3, updated_at = NOW() WHERE id = $1`,
      [id, status, reason],
    );
    await event(client, id, ctx, { kind: "status", from: item.status, to: status, note: reason });
    return { id, status };
  });
}

export function markBooked(id, { appointment_id }, ctx = {}, db = pool) {
  return withItem(id, ctx, db, async (client, item) => {
    refuseClosed(item);
    const { rows } = await client.query(
      `SELECT id, patient_id, appointment_date::text AS day, time_slot, doctor_name, status,
              appointment_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date AS upcoming
         FROM appointments WHERE id = $1`,
      [appointment_id],
    );
    const appt = rows[0];
    if (!appt) throw fail(404, "That booking was not found");
    if (appt.patient_id !== item.patient_id) {
      throw fail(400, "That booking is for a different patient");
    }
    if (appt.status === "cancelled") throw fail(409, "That booking is cancelled");
    if (!appt.upcoming) throw fail(400, "That booking is in the past");
    await client.query(
      `UPDATE care_followups
          SET status = 'booked', booked_appointment_id = $2, outcome_reason = NULL, updated_at = NOW()
        WHERE id = $1`,
      [id, appt.id],
    );
    const note = `${appt.doctor_name || "Booked"} · ${appt.day}${appt.time_slot ? ` ${appt.time_slot}` : ""}`;
    await event(client, id, ctx, { kind: "booked", from: item.status, to: "booked", note });
    if (item.source === "gf_referral") await markDeskBookedAtGhm(client, item.source_key, appt);
    return { id, status: "booked", appointmentId: appt.id };
  });
}

export function reopen(id, { reason }, ctx = {}, db = pool) {
  return withItem(id, ctx, db, async (client, item) => {
    if (ACTIVE_STATUSES.includes(item.status)) throw fail(409, "This follow-up is already open");
    await client.query(
      `UPDATE care_followups
          SET status = 'open', outcome_reason = NULL, booked_appointment_id = NULL, updated_at = NOW()
        WHERE id = $1`,
      [id],
    );
    await event(client, id, ctx, { kind: "status", from: item.status, to: "open", note: reason });
    return { id, status: "open" };
  });
}
