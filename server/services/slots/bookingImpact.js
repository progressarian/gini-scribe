import pool from "../../config/db.js";
import { dayPlan } from "../../../shared/slotTemplates.js";
import { DONE_OR_INPROGRESS, resolveDoctor } from "../availability.js";
import { bookingMinute, homeIn, spansOf } from "./dayView.js";

export async function bookingsOutsideTemplate(
  doctorId,
  template,
  effectiveFrom,
  { client = pool, endExclusive = null } = {},
) {
  const doctor = await resolveDoctor(doctorId, { client });
  if (!doctor) return { affected: [], unreadable: 0, until: null };
  const until = endExclusive;
  const { rows } = await client.query(
    `SELECT a.id AS appointment_id, a.patient_id, a.patient_name, a.file_no,
            a.appointment_date::text, a.time_slot, a.status,
            a.healthray_id IS NOT NULL AS healthray
       FROM appointments a
      WHERE a.doctor_name = ANY($1)
        AND a.appointment_date >= $2::date
        AND ($3::date IS NULL OR a.appointment_date < $3::date)
        AND LOWER(COALESCE(a.status,'')) <> ALL($4)
      ORDER BY a.appointment_date, a.id`,
    [doctor.names, effectiveFrom, until, DONE_OR_INPROGRESS],
  );
  const plans = new Map();
  const planFor = (date) => {
    if (!plans.has(date)) {
      const plan = dayPlan(template, date);
      plans.set(date, { off: plan.off, spans: spansOf(plan) });
    }
    return plans.get(date);
  };
  const affected = [];
  let unreadable = 0;
  for (const r of rows) {
    const plan = planFor(r.appointment_date);
    let reason = null;
    if (plan.off) reason = "on a day off";
    else {
      const minute = bookingMinute(r.time_slot);
      if (minute == null) {
        unreadable += 1;
        continue;
      }
      const home = homeIn(plan.spans, minute);
      if (!home) reason = "outside working hours";
      else if (home.kind === "break") reason = `inside ${home.name}`;
    }
    if (reason) affected.push({ ...r, reason });
  }
  return { affected, unreadable, until };
}
