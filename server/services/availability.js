// ============================================================================
// Availability resolver — the single source of truth for "is doctor D free at
// date+slot?". Booking, the GHM page, the OPD queue, and the patient app all
// ask the same question through these functions.
//
// Model: AVAILABLE BY DEFAULT. A doctor is available every working day, all
// slots, unless something says otherwise. The doctor_profile customizes the
// recurring picture (days off, working slots, lunch break); date-specific
// leave/holiday/break (doctor_unavailability) and clinic holidays are
// exceptions on specific dates.
//
// Layers (highest precedence first in the resolver):
//   day_off        weekday ∈ profile.off_weekdays (default {Sunday})
//   clinic_holiday clinic_holidays
//   not_working    profile.working_slots set and slot ∉ it
//   break          slot ∈ profile.lunch_slots (recurring)
//   leave/holiday/ doctor_unavailability (date-specific)
//   emergency/break
//   manual_block   appointment_slots.is_blocked
//   full           booked ≥ capacity (capacity only if set on appointment_slots)
// ============================================================================
import pool from "../config/db.js";
import { inLunch, inWorkingHours, profileFromRow } from "./slots/profileRules.js";
import { activeTemplates } from "./slots/templateStore.js";
import { approvalsReady } from "./slots/approvalStore.js";
import { overLimitFor, patientTypeSql } from "../../shared/slotCapacity.js";
import {
  bookingMinute,
  labelSpan,
  templateDay,
  timeSpan,
  unavailabilityFor,
} from "./slots/dayView.js";
import { toMinutes } from "../../shared/slotTemplates.js";

// Statuses that mean "this booking still occupies a slot" — must match the
// existing availability endpoint so counts agree everywhere.
const ACTIVE_BOOKING_SQL = "status NOT IN ('cancelled','no_show')";

// Statuses that mean "already done / in progress" — excluded from the
// reassignment list. Wider + case-insensitive: opd.js uses 'seen','in_visit'…
const DONE_OR_INPROGRESS = ["cancelled", "no_show", "completed", "seen", "in_visit", "checkedin"];

// Resolve a doctor row + the names it may appear under in legacy appointment
// rows (name + short_name). Returns null if not found.
export async function resolveDoctor(doctorId, { client = pool } = {}) {
  const r = await client.query(
    "SELECT id, name, short_name, role, specialty FROM doctors WHERE id=$1",
    [doctorId],
  );
  if (!r.rows.length) return null;
  const d = r.rows[0];
  return { ...d, names: [d.name, d.short_name].filter(Boolean) };
}

// Read a doctor's profile, falling back to the implicit defaults.
async function getProfile(doctorId, client) {
  const r = await client.query(
    "SELECT off_weekdays, work_start, work_end, lunch_start, lunch_end FROM doctor_profile WHERE doctor_id=$1",
    [doctorId],
  );
  return profileFromRow(r.rows[0]);
}

/**
 * Is a doctor available for a specific date + slot?
 * @returns {Promise<{available:boolean, reason?:string, detail?:string,
 *                     capacity?:number, booked?:number}>}
 *   reason ∈ 'unknown_doctor'|'day_off'|'clinic_holiday'|'not_working'|
 *            'break'|'leave'|'holiday'|'emergency'|'manual_block'|'full'
 */
async function loadDayContext(doctors, dateISO, client) {
  const ids = doctors.map((d) => d.id);
  const names = [...new Set(doctors.flatMap((d) => d.names))];
  const templates = await activeTemplates(ids, dateISO, { client });
  if (!templates.size) return { templates };
  const pendingSql = (await approvalsReady(client))
    ? `EXISTS (SELECT 1 FROM booking_approvals ba
                WHERE ba.appointment_id = a.id AND ba.status = 'pending')`
    : "FALSE";
  const [catalog, hol, unav, cfg, booked] = await Promise.all([
    client.query(
      "SELECT label, start_time::text, end_time::text FROM slot_catalog WHERE is_active ORDER BY sort_order",
    ),
    client.query("SELECT remarks FROM clinic_holidays WHERE holiday_date=$1", [dateISO]),
    client.query(
      `SELECT id, doctor_id, type, reason, slot_labels, start_time::text, end_time::text
         FROM doctor_unavailability
        WHERE doctor_id = ANY($1::int[]) AND status='active'
          AND $2::date BETWEEN start_date AND end_date`,
      [ids, dateISO],
    ),
    client.query(
      `SELECT doctor_name, time_slot, total_capacity, is_blocked, block_reason FROM appointment_slots
        WHERE doctor_name = ANY($1) AND slot_date=$2`,
      [names, dateISO],
    ),
    client.query(
      `SELECT a.doctor_name, a.time_slot, (a.healthray_id IS NOT NULL) AS healthray,
              ${patientTypeSql("a")} AS patient_type, ${pendingSql} AS pending, COUNT(*)::int n
         FROM appointments a
        WHERE a.doctor_name = ANY($1) AND a.appointment_date=$2 AND a.${ACTIVE_BOOKING_SQL}
        GROUP BY 1, 2, 3, 4, 5`,
      [names, dateISO],
    ),
  ]);
  return {
    templates,
    catalog: catalog.rows,
    isHoliday: hol.rows.length > 0,
    holidayRemark: hol.rows[0]?.remarks || null,
    unav: unav.rows,
    cfg: cfg.rows,
    booked: booked.rows,
  };
}

function dayFromContext(doctor, dateISO, ctx) {
  const template = ctx.templates.get(doctor.id);
  if (!template) return null;
  const mine = (rows) => rows.filter((r) => doctor.names.includes(r.doctor_name));
  return templateDay({
    template,
    date: dateISO,
    catalog: ctx.catalog,
    isHoliday: ctx.isHoliday,
    unavailability: ctx.unav.filter((u) => u.doctor_id === doctor.id),
    overrides: mine(ctx.cfg),
    bookings: mine(ctx.booked),
  });
}

export async function getDoctorDayView(doctorId, dateISO, { client = pool } = {}) {
  const doctor = await resolveDoctor(doctorId, { client });
  if (!doctor) return { slots: [], warnings: [], unreadable: 0, orphanOverrides: [] };
  const ctx = await loadDayContext([doctor], dateISO, client);
  const day = dayFromContext(doctor, dateISO, ctx);
  if (day) return { ...day, holidayRemark: ctx.holidayRemark };
  return {
    slots: await legacyDayAvailability(doctor, dateISO, client),
    warnings: [],
    unreadable: 0,
    orphanOverrides: [],
    fromTemplate: false,
  };
}

function slotVerdict(day, slotOrTime, holidayRemark) {
  if (day.off) return { available: false, reason: "day_off" };
  if (day.slots.length && day.slots.every((s) => s.blocked_by === "clinic_holiday"))
    return { available: false, reason: "clinic_holiday", detail: holidayRemark };
  const exact = day.slots.find((s) => s.slot_label === slotOrTime);
  const minute = exact ? toMinutes(exact.start_time) : bookingMinute(slotOrTime);
  if (minute == null) return { available: false, reason: "unknown_slot" };
  const span = (s) => {
    const a = toMinutes(s.start_time);
    const e = toMinutes(s.end_time);
    return { s: a, e: e <= a ? e + 1440 : e };
  };
  const hit =
    exact ||
    day.slots.find((s) => {
      const { s: a, e } = span(s);
      return [minute, minute + 1440].some((t) => t >= a && t < e);
    });
  if (!hit) return { available: false, reason: "not_working" };
  const base = {
    slot_label: hit.slot_label,
    capacity: hit.capacity,
    booked: hit.booked,
    caps: hit.caps,
    counts: hit.counts,
    time_off_id: hit.time_off_id ?? null,
  };
  if (hit.available) return { available: true, ...base };
  const detail = hit.blocked_by === "clinic_holiday" ? holidayRemark : hit.detail || null;
  return { available: false, reason: hit.blocked_by, detail, ...base };
}

export async function isSlotAvailable(doctorId, dateISO, slotLabel, { client = pool } = {}) {
  const doctor = await resolveDoctor(doctorId, { client });
  if (!doctor) return { available: false, reason: "unknown_doctor" };

  const ctx = await loadDayContext([doctor], dateISO, client);
  const day = dayFromContext(doctor, dateISO, ctx);
  if (day) return slotVerdict(day, slotLabel, ctx.holidayRemark);

  const weekday = (await client.query("SELECT EXTRACT(DOW FROM $1::date)::int AS w", [dateISO]))
    .rows[0].w;
  const profile = await getProfile(doctorId, client);

  if (profile.offWeekdays.includes(weekday)) return { available: false, reason: "day_off" };

  const hol = await client.query("SELECT remarks FROM clinic_holidays WHERE holiday_date=$1", [
    dateISO,
  ]);
  if (hol.rows.length)
    return { available: false, reason: "clinic_holiday", detail: hol.rows[0].remarks || null };

  const st = (
    await client.query("SELECT start_time, end_time FROM slot_catalog WHERE label=$1", [slotLabel])
  ).rows[0];
  if (!st) return { available: false, reason: "unknown_slot" };
  if (!inWorkingHours(profile, st.start_time)) return { available: false, reason: "not_working" };
  if (inLunch(profile, st.start_time)) return { available: false, reason: "break" };

  const unav = await client.query(
    `SELECT type, reason, slot_labels, start_time::text, end_time::text FROM doctor_unavailability
      WHERE doctor_id=$1 AND status='active'
        AND $2::date BETWEEN start_date AND end_date`,
    [doctorId, dateISO],
  );
  const hit = unavailabilityFor(unav.rows, timeSpan(st.start_time, st.end_time), slotLabel);
  if (hit) return { available: false, reason: hit.type, detail: hit.reason || null };

  const cfg = await client.query(
    `SELECT total_capacity, is_blocked, block_reason
       FROM appointment_slots
      WHERE doctor_name = ANY($1) AND slot_date=$2 AND time_slot=$3 LIMIT 1`,
    [doctor.names, dateISO, slotLabel],
  );
  if (cfg.rows[0]?.is_blocked)
    return { available: false, reason: "manual_block", detail: cfg.rows[0].block_reason || null };

  // No per-slot cap unless reception set one on appointment_slots ⇒ unlimited.
  const capacity = cfg.rows[0]?.total_capacity ?? null;
  const booked = (
    await client.query(
      `SELECT COUNT(*)::int AS n FROM appointments
        WHERE doctor_name = ANY($1) AND appointment_date=$2 AND time_slot=$3
          AND ${ACTIVE_BOOKING_SQL}`,
      [doctor.names, dateISO, slotLabel],
    )
  ).rows[0].n;
  if (capacity != null && booked >= capacity)
    return { available: false, reason: "full", capacity, booked };

  return { available: true, capacity, booked };
}

/**
 * Every catalog slot for a doctor on a date, annotated with availability.
 * Returns [{ slot_label, start_time, end_time, capacity, booked, available,
 *            blocked_by }].
 */
export async function getDoctorDayAvailability(doctorId, dateISO, { client = pool } = {}) {
  return (await getDoctorDayView(doctorId, dateISO, { client })).slots;
}

async function legacyDayAvailability(doctor, dateISO, client) {
  const doctorId = doctor.id;
  const weekday = (await client.query("SELECT EXTRACT(DOW FROM $1::date)::int AS w", [dateISO]))
    .rows[0].w;
  const profile = await getProfile(doctorId, client);
  const dayOff = profile.offWeekdays.includes(weekday);

  const [catalog, hol, unav, cfg, booked] = await Promise.all([
    client.query(
      "SELECT label, start_time, end_time FROM slot_catalog WHERE is_active ORDER BY sort_order",
    ),
    client.query("SELECT 1 FROM clinic_holidays WHERE holiday_date=$1", [dateISO]),
    client.query(
      `SELECT type, reason, slot_labels, start_time::text, end_time::text FROM doctor_unavailability
        WHERE doctor_id=$1 AND status='active' AND $2::date BETWEEN start_date AND end_date`,
      [doctorId, dateISO],
    ),
    client.query(
      `SELECT time_slot, total_capacity, is_blocked FROM appointment_slots
        WHERE doctor_name = ANY($1) AND slot_date=$2`,
      [doctor.names, dateISO],
    ),
    client.query(
      `SELECT time_slot, COUNT(*)::int n FROM appointments
        WHERE doctor_name = ANY($1) AND appointment_date=$2 AND ${ACTIVE_BOOKING_SQL}
        GROUP BY time_slot`,
      [doctor.names, dateISO],
    ),
  ]);

  const isHoliday = hol.rows.length > 0;
  const cfgMap = Object.fromEntries(cfg.rows.map((c) => [c.time_slot, c]));
  const bookedMap = Object.fromEntries(booked.rows.map((b) => [b.time_slot, b.n]));
  const unavFor = (s) => unavailabilityFor(unav.rows, timeSpan(s.start_time, s.end_time), s.label);

  return catalog.rows.map((s) => {
    const c = cfgMap[s.label];
    const capacity = c?.total_capacity ?? null;
    const b = bookedMap[s.label] || 0;
    let blocked_by = null;
    if (dayOff) blocked_by = "day_off";
    else if (isHoliday) blocked_by = "clinic_holiday";
    else if (!inWorkingHours(profile, s.start_time)) blocked_by = "not_working";
    else if (inLunch(profile, s.start_time)) blocked_by = "break";
    else if (unavFor(s)) blocked_by = unavFor(s).type;
    else if (c?.is_blocked) blocked_by = "manual_block";
    else if (capacity != null && b >= capacity) blocked_by = "full";
    return {
      slot_label: s.label,
      start_time: s.start_time,
      end_time: s.end_time,
      capacity,
      booked: b,
      available: blocked_by === null,
      blocked_by,
    };
  });
}

/**
 * Across all active doctors, who is available for date+slot. Ranked: same
 * specialty/role as the vacated doctor first, then most free capacity.
 */
export async function findAvailableDoctors(
  dateISO,
  slotLabel,
  { excludeDoctorId = null, role = null, specialty = null, patientType = null, client = pool } = {},
) {
  const docs = await client.query(
    `SELECT id, name, short_name, role, specialty FROM doctors
      WHERE is_active AND lower(role) IN ('consultant','mo')
        AND ($1::int IS NULL OR id <> $1) ORDER BY name`,
    [excludeDoctorId],
  );
  const doctors = docs.rows.map((d) => ({ ...d, names: [d.name, d.short_name].filter(Boolean) }));
  const ctx = await loadDayContext(doctors, dateISO, client);

  const out = [];
  for (const d of doctors) {
    const day = dayFromContext(d, dateISO, ctx);
    const a = day
      ? slotVerdict(day, slotLabel, ctx.holidayRemark)
      : await isSlotAvailable(d.id, dateISO, slotLabel, { client });
    if (!a.available) continue;
    out.push({
      doctor_id: d.id,
      doctor_name: d.name,
      role: d.role,
      specialty: d.specialty,
      free_capacity: a.capacity == null ? Infinity : a.capacity - (a.booked ?? 0),
      same_specialty: !!(specialty && d.specialty && d.specialty === specialty),
      same_role: !!(role && d.role && d.role === role),
      over_limit: patientType ? overLimitFor(a, patientType) : null,
    });
  }

  out.sort(
    (x, y) =>
      Number(!!x.over_limit) - Number(!!y.over_limit) ||
      Number(y.same_specialty) - Number(x.same_specialty) ||
      Number(y.same_role) - Number(x.same_role) ||
      y.free_capacity - x.free_capacity ||
      x.doctor_name.localeCompare(y.doctor_name),
  );
  // JSON can't carry Infinity — expose unlimited as null.
  return out.map((d) => ({
    ...d,
    free_capacity: d.free_capacity === Infinity ? null : d.free_capacity,
  }));
}

/**
 * Patients currently booked to a doctor inside an unavailability window.
 * Excludes done/in-progress statuses. Flags in_progress (active_visits).
 */
export async function getAffectedAssignments(
  doctorId,
  { startDate, endDate, slotLabels = null, client = pool } = {},
) {
  const doctor = await resolveDoctor(doctorId, { client });
  if (!doctor) return [];

  const { rows } = await client.query(
    `SELECT a.id AS appointment_id, a.patient_id, a.patient_name, a.file_no, a.phone,
            a.appointment_date, a.time_slot, a.status,
            EXISTS (
              SELECT 1 FROM active_visits av
               WHERE av.appointment_id = a.id AND av.status = 'in-progress'
            ) AS in_progress
       FROM appointments a
      WHERE a.doctor_name = ANY($1)
        AND a.appointment_date BETWEEN $2 AND $3
        AND LOWER(COALESCE(a.status,'')) <> ALL($4)
      ORDER BY a.appointment_date, a.time_slot`,
    [doctor.names, startDate, endDate, DONE_OR_INPROGRESS],
  );
  if (slotLabels == null) return rows;
  const spans = slotLabels.map(labelSpan).filter(Boolean);
  return rows.filter((r) => {
    if (slotLabels.includes(r.time_slot)) return true;
    const m = bookingMinute(r.time_slot);
    return m != null && spans.some(({ s, e }) => [m, m + 1440].some((t) => t >= s && t < e));
  });
}

export { DONE_OR_INPROGRESS };
