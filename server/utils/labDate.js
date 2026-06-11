// Today's date as YYYY-MM-DD (local clinic time).
export function todayISO() {
  return new Date().toISOString().split("T")[0];
}

// True when an ISO date string is strictly AFTER today. Lab results can never be
// dated in the future — a future date means the extractor (Claude vision)
// misread / hallucinated the year, so we must not anchor a row to it.
export function isFutureISO(iso, today = todayISO()) {
  return !!iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && iso > today;
}

// Resolve a raw date string to YYYY-MM-DD, or null if unparseable. Pure parsing,
// no future-date guard (that is applied by parseLabDate).
function resolveISO(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Strip wrapping parentheses (the AI sometimes returns "(18/06/2024)")
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  const lower = s.toLowerCase();
  if (lower === "today" || lower === "date today" || lower === "observation today") return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    let [, dd, mm, yy] = dmy;
    if (yy.length === 2) yy = (parseInt(yy, 10) > 50 ? "19" : "20") + yy;
    const iso = `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : iso;
  }

  const cleaned = s.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

// Normalises lab-result date strings (whatever the AI emits, or whatever the
// upstream extractor wrote) into a YYYY-MM-DD ISO date. Falls back to a
// caller-supplied date for "today" / blank / future inputs so every lab row ends
// up anchored to a real, non-future visit date.
//
// FUTURE-DATE GUARD: a parsed date later than today is rejected (the report was
// misread) and we fall back to fallbackISO; the fallback itself is also rejected
// if it is in the future, in which case this returns null and the caller skips
// the row. Use parseLabDateChecked() when you need to know a future date was
// dropped (to warn the user).
//
// Accepted inputs:
//   YYYY-MM-DD           → passthrough
//   DD/MM/YYYY DD-MM-YYYY DD/MM/YY DD-MM-YY  (Indian convention)
//   "1 May 2026" / "5TH MARCH 2023" / "6th Nov 2023"
//   "today" / "date today" / "" / null  → fallbackISO
export function parseLabDate(raw, fallbackISO) {
  return parseLabDateChecked(raw, fallbackISO).date;
}

// Same as parseLabDate but returns { date, futureDropped }. futureDropped is true
// when the raw input parsed to a real but future-dated value that we refused to
// store — lets callers surface a warning.
export function parseLabDateChecked(raw, fallbackISO, today = todayISO()) {
  const fb = fallbackISO && !isFutureISO(fallbackISO, today) ? fallbackISO : null;
  const resolved = resolveISO(raw);
  if (resolved && isFutureISO(resolved, today)) {
    return { date: fb, futureDropped: true };
  }
  return { date: resolved ?? fb, futureDropped: false };
}
