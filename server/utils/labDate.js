// Normalises lab-result date strings (whatever the AI emits, or whatever the
// upstream extractor wrote) into a YYYY-MM-DD ISO date. Falls back to a
// caller-supplied date for "today" / blank inputs so every lab row ends up
// anchored to a real visit date.
//
// Accepted inputs:
//   YYYY-MM-DD           → passthrough
//   DD/MM/YYYY DD-MM-YYYY DD/MM/YY DD-MM-YY  (Indian convention)
//   "1 May 2026" / "5TH MARCH 2023" / "6th Nov 2023"
//   "today" / "date today" / "" / null  → fallbackISO
export function parseLabDate(raw, fallbackISO) {
  const fb = fallbackISO || null;
  if (raw == null) return fb;
  let s = String(raw).trim();
  if (!s) return fb;
  // Strip wrapping parentheses (the AI sometimes returns "(18/06/2024)")
  if (s.startsWith("(") && s.endsWith(")")) s = s.slice(1, -1).trim();
  const lower = s.toLowerCase();
  if (lower === "today" || lower === "date today" || lower === "observation today") return fb;

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    let [, dd, mm, yy] = dmy;
    if (yy.length === 2) yy = (parseInt(yy, 10) > 50 ? "19" : "20") + yy;
    const iso = `${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? fb : iso;
  }

  const cleaned = s.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return fb;
}
