import { CAP_KEYS, CAP_MAX, PATIENT_TYPES, capsOf } from "./slotCapacity.js";

export { CAP_MAX };

export const SLOT_MINUTES_MIN = 5;
export const SLOT_MINUTES_MAX = 240;
export const MAX_WINDOWS_PER_DAY = 4;
export const MAX_BREAKS_PER_DAY = 10;
export const BREAK_NAME_MAX = 40;
export const APPLY_BATCH = 10;
export const PARTIAL_LAST = ["drop", "short"];
export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DAY = 1440;

export const toMinutes = (time) => {
  const m = String(time ?? "").match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
};

export const toClock = (minutes) => {
  const m = ((minutes % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export const formatTime = (minutes) => {
  const m = ((minutes % DAY) + DAY) % DAY;
  const h24 = Math.floor(m / 60);
  const min = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? "AM" : "PM";
  return min ? `${h12}:${String(min).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
};

export const slotLabel = (start, end) => `${formatTime(start)} to ${formatTime(end)}`;

export const weekdayOf = (dateISO) => {
  const m = String(dateISO ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
};

const span = (start, end) => {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null || s === e) return null;
  return { s, e: e <= s ? e + DAY : e };
};

const windowsOn = (template, weekday) =>
  (template?.hours || [])
    .map((h, index) => ({ ...h, index, span: span(h.start, h.end) }))
    .filter((h) => Number(h.weekday) === weekday && h.span)
    .sort((a, b) => a.span.s - b.span.s);

const breaksOn = (template, weekday) =>
  (template?.breaks || [])
    .map((b, index) => ({ ...b, index, span: span(b.start, b.end) }))
    .filter((b) => (b.weekday == null || Number(b.weekday) === weekday) && b.span);

const placeIn = (window, brk) => {
  for (const shift of [0, DAY]) {
    const s = brk.span.s + shift;
    const e = brk.span.e + shift;
    if (e > window.span.s && s < window.span.e) return { s, e };
  }
  return null;
};

const subtract = (window, cuts) => {
  const sorted = cuts.slice().sort((a, b) => a.s - b.s);
  const free = [];
  let cursor = window.span.s;
  for (const c of sorted) {
    if (c.s > cursor) free.push({ s: cursor, e: Math.min(c.s, window.span.e) });
    cursor = Math.max(cursor, c.e);
    if (cursor >= window.span.e) break;
  }
  if (cursor < window.span.e) free.push({ s: cursor, e: window.span.e });
  return free.filter((f) => f.e > f.s);
};

const cut = (segment, minutes, partialLast) => {
  const out = [];
  for (let s = segment.s; s < segment.e; s += minutes) {
    const e = Math.min(s + minutes, segment.e);
    if (e - s < minutes && partialLast !== "short") break;
    out.push({ s, e });
  }
  return out;
};

const capsByStart = (rows) => new Map((rows || []).map((r) => [String(r.start).slice(0, 5), r]));

export function dayPlan(template, dateISO, { dateCaps = [] } = {}) {
  const weekday = weekdayOf(dateISO);
  const slotCaps = capsByStart(
    (template?.slotCaps || []).filter((c) => Number(c.weekday) === weekday),
  );
  const onDate = capsByStart(dateCaps);
  const windows = windowsOn(template, weekday);
  if (!windows.length) return { weekday, off: true, slots: [], breaks: [] };

  const partialLast = template?.partialLast === "short" ? "short" : "drop";
  const slots = [];
  const breaks = [];
  const seenBreak = new Set();

  windows.forEach((w, windowIndex) => {
    const minutes = Number(w.slotMinutes);
    const cuts = [];
    for (const b of breaksOn(template, weekday)) {
      const placed = placeIn(w, b);
      if (!placed) continue;
      cuts.push(placed);
      if (!seenBreak.has(b.index)) {
        seenBreak.add(b.index);
        breaks.push({
          name: b.name,
          start: toClock(placed.s),
          end: toClock(placed.e),
          startMin: placed.s,
          endMin: placed.e,
        });
      }
    }
    if (!(minutes >= SLOT_MINUTES_MIN && minutes <= SLOT_MINUTES_MAX)) return;
    for (const segment of subtract(w, cuts)) {
      for (const { s, e } of cut(segment, minutes, partialLast)) {
        const start = toClock(s);
        const own = onDate.get(start) || slotCaps.get(start);
        slots.push({
          start,
          end: toClock(e),
          startMin: s,
          endMin: e,
          label: slotLabel(s, e),
          windowIndex,
          nextDay: s >= DAY,
          caps: capsOf(own || w),
          capSource: onDate.has(start) ? "date" : slotCaps.has(start) ? "slot" : "hours",
        });
      }
    }
  });

  breaks.sort((a, b) => a.startMin - b.startMin);
  return { weekday, off: false, slots, breaks };
}

export const slotsFor = (template, dateISO) => dayPlan(template, dateISO).slots;

const range = (s, e) => `${formatTime(s)}–${formatTime(e)}`;

export function validateTemplate(template, { requireHours = true } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const hours = template?.hours || [];
  const breaks = template?.breaks || [];

  if (template?.partialLast != null && !PARTIAL_LAST.includes(template.partialLast))
    add("partialLast", "Choose whether a short last slot is dropped or kept.");

  if (requireHours && !hours.length) add("hours", "Add working hours for at least one day.");

  hours.forEach((h, i) => {
    const field = `hours.${i}`;
    const day = WEEKDAY_NAMES[h.weekday];
    if (!Number.isInteger(Number(h.weekday)) || !day) {
      add(`${field}.weekday`, "Pick a day of the week for these working hours.");
      return;
    }
    const s = toMinutes(h.start);
    const e = toMinutes(h.end);
    if (s == null) add(`${field}.start`, `Enter a start time for ${day}.`);
    if (e == null) add(`${field}.end`, `Enter an end time for ${day}.`);
    if (s != null && e != null && s === e)
      add(`${field}.end`, `${day}: start and end can't be the same time.`);
    capErrors(h, `${field}`, day, add);
    const minutes = Number(h.slotMinutes);
    if (!Number.isInteger(minutes) || minutes < SLOT_MINUTES_MIN || minutes > SLOT_MINUTES_MAX)
      add(
        `${field}.slotMinutes`,
        `${day}: slot length must be a whole number from ${SLOT_MINUTES_MIN} to ${SLOT_MINUTES_MAX} minutes.`,
      );
  });

  for (let weekday = 0; weekday < 7; weekday += 1) {
    const day = WEEKDAY_NAMES[weekday];
    const windows = windowsOn(template, weekday);
    if (windows.length > MAX_WINDOWS_PER_DAY)
      add(`hours.${windows[0].index}`, `${day}: at most ${MAX_WINDOWS_PER_DAY} working windows.`);
    for (let i = 1; i < windows.length; i += 1) {
      const prev = windows[i - 1];
      const cur = windows[i];
      if (cur.span.s < prev.span.e)
        add(
          `hours.${cur.index}`,
          `${day}: ${range(cur.span.s, cur.span.e)} overlaps ${range(prev.span.s, prev.span.e)}.`,
        );
    }
    const next = windowsOn(template, (weekday + 1) % 7);
    for (const w of windows) {
      if (w.span.e <= DAY) continue;
      const tail = w.span.e - DAY;
      const hit = next.find((n) => n.span.s < tail);
      if (hit)
        add(
          `hours.${hit.index}`,
          `${WEEKDAY_NAMES[(weekday + 1) % 7]}: ${range(hit.span.s, hit.span.e)} starts before ${day}'s overnight hours end at ${formatTime(tail)}.`,
        );
    }
  }

  breaks.forEach((b, i) => {
    const field = `breaks.${i}`;
    const name = String(b.name ?? "").trim();
    if (!name) add(`${field}.name`, "Give the break a name, e.g. Lunch.");
    else if (name.length > BREAK_NAME_MAX)
      add(`${field}.name`, `Keep the break name to ${BREAK_NAME_MAX} characters.`);
    const label = name || "The break";
    if (b.weekday != null && !WEEKDAY_NAMES[b.weekday]) {
      add(`${field}.weekday`, `${label}: pick a day, or every working day.`);
      return;
    }
    const s = toMinutes(b.start);
    const e = toMinutes(b.end);
    if (s == null) add(`${field}.start`, `${label}: enter a start time.`);
    if (e == null) add(`${field}.end`, `${label}: enter an end time.`);
    if (s == null || e == null) return;
    if (s === e) {
      add(`${field}.end`, `${label}: start and end can't be the same time.`);
      return;
    }
    const brk = { span: span(b.start, b.end) };
    const days = b.weekday == null ? [0, 1, 2, 3, 4, 5, 6] : [Number(b.weekday)];
    const working = days.filter((d) => windowsOn(template, d).length);
    if (!working.length) {
      add(
        `${field}.weekday`,
        b.weekday == null
          ? `${label}: there are no working days to put it on.`
          : `${label}: ${WEEKDAY_NAMES[b.weekday]} is a day off.`,
      );
      return;
    }
    const fits = (d) =>
      windowsOn(template, d).some((w) => {
        const p = placeIn(w, brk);
        return p && p.s >= w.span.s && p.e <= w.span.e;
      });
    const touches = (d) => windowsOn(template, d).some((w) => placeIn(w, brk));
    if (b.weekday != null) {
      if (fits(Number(b.weekday))) return;
      const w = windowsOn(template, Number(b.weekday)).find((x) => placeIn(x, brk));
      add(
        `${field}.end`,
        w
          ? `${label} (${range(brk.span.s, brk.span.e)}) runs outside the working hours ${range(w.span.s, w.span.e)}.`
          : `${label} (${range(brk.span.s, brk.span.e)}) is outside ${WEEKDAY_NAMES[b.weekday]}'s working hours.`,
      );
      return;
    }
    const straddles = working.filter((d) => touches(d) && !fits(d));
    if (straddles.length)
      add(
        `${field}.end`,
        `${label} (${range(brk.span.s, brk.span.e)}) runs past the working hours on ${straddles.map((d) => WEEKDAY_NAMES[d]).join(", ")}.`,
      );
    else if (!working.some(fits))
      add(
        `${field}.start`,
        `${label} (${range(brk.span.s, brk.span.e)}) is outside the working hours on every day.`,
      );
  });

  for (let weekday = 0; weekday < 7; weekday += 1) {
    if (breaksOn(template, weekday).length > MAX_BREAKS_PER_DAY)
      add("breaks", `${WEEKDAY_NAMES[weekday]}: at most ${MAX_BREAKS_PER_DAY} breaks.`);
  }

  if (!errors.length) {
    errors.push(...slotCapErrors(template));
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const windows = windowsOn(template, weekday);
      if (!windows.length) continue;
      const plan = dayPlanForWeekday(template, weekday);
      if (!plan.slots.length)
        add(
          `hours.${windows[0].index}`,
          `${WEEKDAY_NAMES[weekday]}: these hours and breaks leave no room for a full slot — shorten the slot length or the breaks.`,
        );
    }
  }

  return errors;
}

const CAP_NOUNS = {
  walkin: "walk-ins",
  new: "new patients",
  followup: "follow-ups",
  within3: "within-3-days patients",
};

function capErrors(row, field, where, add) {
  for (const type of PATIENT_TYPES) {
    const key = CAP_KEYS[type];
    const cap = row[key];
    if (cap != null && cap !== "" && !(Number.isInteger(Number(cap)) && cap >= 0 && cap <= CAP_MAX))
      add(
        `${field}.${key}`,
        `${where}: ${CAP_NOUNS[type]} per slot must be a whole number from 0 to ${CAP_MAX}, or blank for no limit.`,
      );
  }
}

export const MAX_SLOT_CAPS = 7 * 96;

export function slotCapErrors(template) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const rows = template?.slotCaps || [];
  if (rows.length > MAX_SLOT_CAPS) add("slotCaps", `At most ${MAX_SLOT_CAPS} slot limits.`);
  const seen = new Set();
  const startsOn = new Map();
  rows.forEach((c, i) => {
    const field = `slotCaps.${i}`;
    const day = WEEKDAY_NAMES[c.weekday];
    if (!day) return add(`${field}.weekday`, "Pick a day of the week for this slot.");
    const start = String(c.start ?? "").slice(0, 5);
    if (!startsOn.has(c.weekday))
      startsOn.set(
        c.weekday,
        new Set(dayPlanForWeekday(template, Number(c.weekday)).slots.map((x) => x.start)),
      );
    const where = `${day} ${toMinutes(start) == null ? start : formatTime(toMinutes(start))}`;
    if (!startsOn.get(c.weekday).has(start))
      return add(`${field}.start`, `${where} is not a slot any more — set its numbers again.`);
    const key = `${c.weekday}|${start}`;
    if (seen.has(key)) return add(`${field}.start`, `${where} has its numbers set twice.`);
    seen.add(key);
    capErrors(c, field, where, add);
  });
  return errors;
}

const REFERENCE_SUNDAY = Date.UTC(2026, 0, 4);

const dayPlanForWeekday = (template, weekday) =>
  dayPlan(template, new Date(REFERENCE_SUNDAY + weekday * 86400000).toISOString().slice(0, 10));
