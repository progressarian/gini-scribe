// Helpers for the `days_of_week` column on `medications`.
//
// AddMedicationModal stores per-medication weekday selections two ways:
//   1. As an INTEGER[] in `days_of_week` (0=Sun … 6=Sat) — used by the
//      patient app to decide which days the dose is due.
//   2. As a "· Mon, Wed" suffix on the `frequency` string — so the existing
//      doctor-facing UI renders the days naturally without schema awareness.
//
// Auto-extraction flows (HealthRay sync, Paste Clinical Notes) historically
// dropped both. These helpers let those flows infer the correct day(s) from
// either explicit text in the frequency / timing or — as a sensible default —
// the weekday of the prescription date.
//
// All functions are pure and dependency-free.

export const INT_TO_WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_TO_INT = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

// Loose match for any frequency that warrants picking a specific weekday.
export function isWeeklyFrequency(freq) {
  if (!freq) return false;
  const f = String(freq).toLowerCase();
  return (
    /\bonce\s*weekly\b/.test(f) ||
    /\bweekly\b/.test(f) ||
    /\bonce\s+a\s+week\b/.test(f) ||
    /\bonce\s+in\s+14\s+days\b/.test(f) ||
    /\bfortnight/.test(f) ||
    /\bevery\s+14\s+days\b/.test(f) ||
    /\bevery\s+7\s+days\b/.test(f)
  );
}

// Pull weekday names out of arbitrary free text. Recognises both the canonical
// "· Mon, Wed" suffix used by the app and natural-language mentions like
// "every Sunday", "on Monday", "Tues & Thurs".
export function extractWeekdaysFromText(text) {
  if (!text) return [];
  const found = new Set();
  const re =
    /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    const n = WEEKDAY_TO_INT[key];
    if (typeof n === "number") found.add(n);
  }
  return [...found].sort((a, b) => a - b);
}

// Parse a frequency that may already carry a "· Mon, Wed" suffix.
//   "Once weekly · Mon, Wed" → { base: "Once weekly", days: [1, 3] }
//   "Once weekly"            → { base: "Once weekly", days: [] }
export function parseFrequencyWithDays(raw) {
  const s = String(raw || "");
  const m = s.match(/^(.+?)\s*·\s*(.+)$/);
  if (!m) return { base: s, days: [] };
  return { base: m[1].trim(), days: extractWeekdaysFromText(m[2]) };
}

// 0=Sun … 6=Sat. Works for "YYYY-MM-DD" or Date-like inputs. Returns null when
// the input can't be parsed.
export function weekdayOfDate(dateLike) {
  if (!dateLike) return null;
  const d =
    dateLike instanceof Date ? dateLike : new Date(`${String(dateLike).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCDay();
}

// Format an INT[] back as "Mon, Wed".
export function formatDaysSuffix(days) {
  if (!Array.isArray(days) || !days.length) return "";
  return days
    .map((n) => INT_TO_WEEKDAY[n])
    .filter(Boolean)
    .join(", ");
}

// Top-level enrichment used by HealthRay sync + clinical-bulk save.
// Given a parsed medication and the prescription date, returns the medication
// with `frequency` normalised to include "· Mon, Wed" and `days_of_week` set
// when applicable. Non-weekly meds are returned untouched.
export function enrichMedWithDays(med, fallbackDate) {
  if (!med || typeof med !== "object") return med;
  const out = { ...med };

  // Prefer explicitly provided days_of_week (AI may emit it directly).
  let days = Array.isArray(med.days_of_week)
    ? med.days_of_week.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : [];

  const { base, days: suffixDays } = parseFrequencyWithDays(med.frequency);
  if (!days.length && suffixDays.length) days = suffixDays;

  // Look for inline mentions in frequency or timing text.
  if (!days.length) {
    const inline = [
      ...extractWeekdaysFromText(base),
      ...extractWeekdaysFromText(med.timing),
      ...extractWeekdaysFromText(med.when_to_take),
    ];
    if (inline.length) days = [...new Set(inline)].sort((a, b) => a - b);
  }

  const weekly = isWeeklyFrequency(base) || isWeeklyFrequency(med.frequency);

  // Fall back to the weekday of the prescription date for weekly meds with no
  // explicit day. Skip for fortnightly — the day is genuinely ambiguous there.
  if (!days.length && weekly && !/fortnight|14\s*days/i.test(med.frequency || "")) {
    const w = weekdayOfDate(fallbackDate);
    if (w != null) days = [w];
  }

  if (days.length) {
    out.days_of_week = days;
    const suffix = formatDaysSuffix(days);
    out.frequency = suffix ? `${base} · ${suffix}` : base;
  } else {
    out.days_of_week = null;
    out.frequency = med.frequency || null;
  }

  return out;
}
