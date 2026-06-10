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

// Statuses that mean "this booking still occupies a slot" — must match the
// existing availability endpoint so counts agree everywhere.
const ACTIVE_BOOKING_SQL = "status NOT IN ('cancelled','no_show')";

// Statuses that mean "already done / in progress" — excluded from the
// reassignment list. Wider + case-insensitive: opd.js uses 'seen','in_visit'…
const DONE_OR_INPROGRESS = ["cancelled", "no_show", "completed", "seen", "in_visit", "checkedin"];

const DEFAULT_OFF_WEEKDAYS = [0]; // Sunday

// Times are "HH:MM[:SS]" strings. Work in minutes-since-midnight and support
// OVERNIGHT windows (end <= start ⇒ the window wraps past midnight, e.g. a
// 17:00–01:00 night shift). A slot belongs to a window if its START time falls
// inside [start, end) — using the start avoids the midnight-end (00:00) edge.
const toMin = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};
// Is clock-minute `m` inside [start, end)? end<=start means it wraps midnight.
// inclusiveEnd lets lunch bounds include the exact end time.
const inWindowMin = (start, end, m, inclusiveEnd = false) => {
  if (start == null || end == null || m == null) return true; // unbounded
  let s = start,
    e = end,
    t = m;
  if (e <= s) e += 1440; // overnight
  if (t < s) t += 1440;
  return inclusiveEnd ? t >= s && t <= e : t >= s && t < e;
};
const inWorkingHours = (p, sStart) =>
  inWindowMin(toMin(p.workStart), toMin(p.workEnd), toMin(sStart));
const inLunch = (p, sStart) =>
  !!(
    p.lunchStart &&
    p.lunchEnd &&
    inWindowMin(toMin(p.lunchStart), toMin(p.lunchEnd), toMin(sStart))
  );

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
  const p = r.rows[0] || {};
  return {
    offWeekdays: p.off_weekdays ?? DEFAULT_OFF_WEEKDAYS,
    workStart: p.work_start ?? null, // null = all day
    workEnd: p.work_end ?? null,
    lunchStart: p.lunch_start ?? null,
    lunchEnd: p.lunch_end ?? null,
  };
}

/**
 * Is a doctor available for a specific date + slot?
 * @returns {Promise<{available:boolean, reason?:string, detail?:string,
 *                     capacity?:number, booked?:number}>}
 *   reason ∈ 'unknown_doctor'|'day_off'|'clinic_holiday'|'not_working'|
 *            'break'|'leave'|'holiday'|'emergency'|'manual_block'|'full'
 */
export async function isSlotAvailable(doctorId, dateISO, slotLabel, { client = pool } = {}) {
  const doctor = await resolveDoctor(doctorId, { client });
  if (!doctor) return { available: false, reason: "unknown_doctor" };

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
    `SELECT type, reason FROM doctor_unavailability
      WHERE doctor_id=$1 AND status='active'
        AND $2::date BETWEEN start_date AND end_date
        AND (slot_labels IS NULL OR $3 = ANY(slot_labels))
      ORDER BY (type='emergency') DESC LIMIT 1`,
    [doctorId, dateISO, slotLabel],
  );
  if (unav.rows.length)
    return { available: false, reason: unav.rows[0].type, detail: unav.rows[0].reason || null };

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
  const doctor = await resolveDoctor(doctorId, { client });
  if (!doctor) return [];

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
      `SELECT type, slot_labels FROM doctor_unavailability
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
  const unavFor = (label) =>
    unav.rows.find((u) => u.slot_labels == null || u.slot_labels.includes(label));

  return catalog.rows.map((s) => {
    const c = cfgMap[s.label];
    const capacity = c?.total_capacity ?? null;
    const b = bookedMap[s.label] || 0;
    let blocked_by = null;
    if (dayOff) blocked_by = "day_off";
    else if (isHoliday) blocked_by = "clinic_holiday";
    else if (!inWorkingHours(profile, s.start_time)) blocked_by = "not_working";
    else if (inLunch(profile, s.start_time)) blocked_by = "break";
    else if (unavFor(s.label)) blocked_by = unavFor(s.label).type;
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
  { excludeDoctorId = null, role = null, specialty = null, client = pool } = {},
) {
  const docs = await client.query(
    `SELECT id, name, role, specialty FROM doctors
      WHERE is_active AND lower(role) IN ('consultant','mo')
        AND ($1::int IS NULL OR id <> $1) ORDER BY name`,
    [excludeDoctorId],
  );

  const out = [];
  for (const d of docs.rows) {
    const a = await isSlotAvailable(d.id, dateISO, slotLabel, { client });
    if (!a.available) continue;
    out.push({
      doctor_id: d.id,
      doctor_name: d.name,
      role: d.role,
      specialty: d.specialty,
      free_capacity: a.capacity == null ? Infinity : a.capacity - (a.booked ?? 0),
      same_specialty: !!(specialty && d.specialty && d.specialty === specialty),
      same_role: !!(role && d.role && d.role === role),
    });
  }

  out.sort(
    (x, y) =>
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
        AND ($5::text[] IS NULL OR a.time_slot = ANY($5))
      ORDER BY a.appointment_date, a.time_slot`,
    [doctor.names, startDate, endDate, DONE_OR_INPROGRESS, slotLabels],
  );
  return rows;
}

export { DONE_OR_INPROGRESS };
