import {
  dayPlan,
  formatTime,
  slotLabel,
  toClock,
  toMinutes,
} from "../../../shared/slotTemplates.js";
import { slotStartTime } from "../../../shared/slotHour.js";
import { capsOf, emptyCounts } from "../../../shared/slotCapacity.js";

const DAY = 1440;

export const bookingMinute = (timeSlot) => toMinutes(slotStartTime(timeSlot));

export const labelSpan = (label) => {
  const [from, to] = String(label || "").split(/\s+to\s+/i);
  const s = toMinutes(slotStartTime(from));
  const e = toMinutes(slotStartTime(to));
  if (s == null || e == null) return null;
  return { s, e: e <= s ? e + DAY : e };
};

const overlaps = (a, b) => [0, DAY, -DAY].some((shift) => b.s + shift < a.e && b.e + shift > a.s);

export const timeSpan = (start, end) => {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null) return null;
  return { s, e: e <= s ? e + DAY : e };
};

export const unavailabilityFor = (rows, span, label) => {
  const hits = rows.filter((u) => {
    if (u.start_time && u.end_time) {
      const t = timeSpan(u.start_time, u.end_time);
      return t ? overlaps(span, t) : false;
    }
    if (u.slot_labels == null) return true;
    return u.slot_labels.some((l) => {
      if (l === label) return true;
      const ls = labelSpan(l);
      return ls ? overlaps(span, ls) : false;
    });
  });
  return hits.find((u) => u.type === "emergency") || hits[0] || null;
};

const clock = (m) => `${toClock(m)}:00`;

export const spansOf = (plan) => [
  ...plan.slots.map((x) => ({ s: x.startMin, e: x.endMin, kind: "slot" })),
  ...plan.breaks.map((x) => ({ s: x.startMin, e: x.endMin, kind: "break", name: x.name })),
];

export const homeIn = (spans, minute) => {
  const inside = (m) => (x) => m >= x.s && m < x.e;
  return spans.find(inside(minute)) || spans.find(inside(minute + DAY)) || null;
};

export function templateDay({
  template,
  date,
  catalog = [],
  isHoliday = false,
  unavailability = [],
  overrides = [],
  bookings = [],
}) {
  const plan = dayPlan(template, date);
  const cfg = new Map(overrides.map((o) => [o.time_slot, o]));
  const readable = bookings.map((b) => ({ ...b, minute: bookingMinute(b.time_slot) }));
  const unreadable = readable.filter((b) => b.minute == null).reduce((n, b) => n + b.n, 0);
  const spans = spansOf(plan);
  const homeOf = (minute) => homeIn(spans, minute);
  const counted = new Map();
  for (const b of readable) {
    if (b.minute == null) continue;
    const home = homeOf(b.minute);
    if (!home) continue;
    const key = `${home.s}|${home.e}`;
    const c = counted.get(key) || { total: 0, ...emptyCounts() };
    c.total += b.n;
    if (b.patient_type) c[b.patient_type] += b.n;
    if (b.pending) c.pending += b.n;
    counted.set(key, c);
  }
  const tally = (s, e) => counted.get(`${s}|${e}`) || { total: 0, ...emptyCounts() };
  const count = (s, e) => tally(s, e).total;
  const typeCounts = (s, e) => {
    const { total, ...rest } = tally(s, e);
    return rest;
  };

  if (plan.off) {
    const byLabel = new Map(bookings.map((b) => [b.time_slot, b.n]));
    const slots = catalog.map((c) => ({
      slot_label: c.label,
      start_time: c.start_time,
      end_time: c.end_time,
      capacity: cfg.get(c.label)?.total_capacity ?? null,
      booked: byLabel.get(c.label) || 0,
      available: false,
      blocked_by: "day_off",
    }));
    const warnings = healthrayWarnings(readable, () => "on a day off");
    return { slots, warnings, unreadable, orphanOverrides: [], fromTemplate: true, off: true };
  }

  const rows = plan.slots.map((s) => {
    const c = cfg.get(s.label);
    const capacity = c?.total_capacity ?? null;
    const booked = count(s.startMin, s.endMin);
    const span = { s: s.startMin, e: s.endMin };
    const u = isHoliday ? null : unavailabilityFor(unavailability, span, s.label);
    let blocked_by = null;
    let detail = null;
    if (isHoliday) blocked_by = "clinic_holiday";
    else if (u) {
      blocked_by = u.type;
      detail = u.reason || null;
    } else if (c?.is_blocked) {
      blocked_by = "manual_block";
      detail = c.block_reason || null;
    } else if (capacity != null && booked >= capacity) blocked_by = "full";
    return {
      slot_label: s.label,
      start_time: clock(s.startMin),
      end_time: clock(s.endMin),
      start_min: s.startMin,
      capacity,
      booked,
      available: blocked_by === null,
      blocked_by,
      detail,
      caps: s.caps || capsOf(null),
      counts: typeCounts(s.startMin, s.endMin),
    };
  });

  const breakRows = plan.breaks.map((b) => {
    const label = slotLabel(b.startMin, b.endMin);
    const u = isHoliday
      ? null
      : unavailabilityFor(unavailability, { s: b.startMin, e: b.endMin }, label);
    const covering = u && (u.slot_labels == null && !u.start_time ? u : null);
    return {
      slot_label: label,
      start_time: clock(b.startMin),
      end_time: clock(b.endMin),
      start_min: b.startMin,
      capacity: null,
      booked: count(b.startMin, b.endMin),
      available: false,
      blocked_by: isHoliday ? "clinic_holiday" : covering ? covering.type : "break",
      detail: covering ? covering.reason || null : b.name,
    };
  });

  const slots = [...rows, ...breakRows].sort((a, b) => a.start_min - b.start_min);
  const labels = new Set(slots.map((s) => s.slot_label));
  const orphanOverrides = overrides
    .filter((o) => (o.is_blocked || o.total_capacity != null) && !labels.has(o.time_slot))
    .map((o) => ({
      time_slot: o.time_slot,
      is_blocked: !!o.is_blocked,
      total_capacity: o.total_capacity ?? null,
    }));

  const warnings = healthrayWarnings(readable, (minute) => {
    const home = homeOf(minute);
    if (!home) return "outside working hours";
    return home.kind === "break" ? `inside ${home.name}` : null;
  });

  return {
    slots: slots.map(({ start_min, ...rest }) => rest),
    warnings,
    unreadable,
    orphanOverrides,
    fromTemplate: true,
    off: false,
  };
}

function healthrayWarnings(readable, reasonFor) {
  const grouped = new Map();
  for (const b of readable) {
    if (!b.healthray || b.minute == null) continue;
    const reason = reasonFor(b.minute);
    if (!reason) continue;
    const key = `${b.minute}|${reason}`;
    const g = grouped.get(key) || {
      time: formatTime(b.minute),
      minute: b.minute,
      reason,
      count: 0,
    };
    g.count += b.n;
    grouped.set(key, g);
  }
  return [...grouped.values()]
    .sort((a, b) => a.minute - b.minute)
    .map(({ minute, ...w }) => ({
      ...w,
      message: `Booked in HealthRay at ${w.time} — ${w.reason}${w.count > 1 ? ` (${w.count} patients)` : ""}`,
    }));
}
