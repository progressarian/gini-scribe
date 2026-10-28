export function todayISO() {
  return new Date().toISOString().split("T")[0];
}
export function isFutureISO(iso, today = todayISO()) {
  return !!iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) && iso > today;
}
function resolveISO(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
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

export function collectNoteDates(rawText) {
  const found = new Set();
  if (!rawText) return found;
  const text = String(rawText);

  // 9/11/25, 06-04-2026, 31.07.2026
  for (const m of text.matchAll(/\b(\d{1,2})[./\-](\d{1,2})[./\-](\d{2,4})\b/g)) {
    const iso = resolveISO(`${m[1]}/${m[2]}/${m[3]}`);
    if (iso) found.add(iso);
  }
  // 24th DECEMBER 2024, 6 Nov 2023
  const MONTHS =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const re = new RegExp(
    `\\b(\\d{1,2})\\s*(?:st|nd|rd|th)?\\s+(${MONTHS})\\.?,?\\s+(\\d{4})\\b`,
    "gi",
  );
  for (const m of text.matchAll(re)) {
    const iso = resolveISO(`${m[1]} ${m[2]} ${m[3]}`);
    if (iso) found.add(iso);
  }
  return found;
}

export function parseLabDate(raw, fallbackISO) {
  return parseLabDateChecked(raw, fallbackISO).date;
}

export function parseLabDateChecked(raw, fallbackISO, today = todayISO()) {
  const fb = fallbackISO && !isFutureISO(fallbackISO, today) ? fallbackISO : null;
  const resolved = resolveISO(raw);
  if (resolved && isFutureISO(resolved, today)) {
    return { date: fb, futureDropped: true };
  }
  return { date: resolved ?? fb, futureDropped: false };
}
