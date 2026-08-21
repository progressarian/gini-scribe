// Start hour (0-23) of an appointment slot label, across every format the
// table holds: HealthRay sheet ranges ("05. 1-2PM", "02. 10-11AM",
// "06. 2:30-3PM"), plain 24h times ("13:00"), catalog labels ("1 PM to
// 1:30 PM") and single times ("9:30 AM"). Returns null when unparseable.
const to24 = (h, min, ap) => {
  let hh = h;
  if (ap === "pm" && hh < 12) hh += 12;
  if (ap === "am" && hh === 12) hh = 0;
  return hh + min / 60;
};

export const slotStartHour = (slot) => {
  const s = String(slot || "")
    .trim()
    .replace(/^\d+\.\s*/, "");
  if (!s) return null;

  const range = s.match(
    /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|–)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i,
  );
  if (range) {
    const [, h1, m1, ap1, h2, m2, ap2] = range;
    const startAp = (ap1 || "").toLowerCase();
    const endAp = (ap2 || "").toLowerCase();
    if (startAp) {
      const start = to24(+h1, +(m1 || 0), startAp);
      return Number.isFinite(start) ? Math.floor(start) : null;
    }
    if (endAp) {
      // Only the end carries AM/PM ("1-2PM", "11-12PM") — walk back from the
      // end by the range's own length so "11-12PM" reads as 11 AM, not 11 PM.
      const end = to24(+h2, +(m2 || 0), endAp);
      const raw1 = +h1 + +(m1 || 0) / 60;
      const raw2 = +h2 + +(m2 || 0) / 60;
      const span = raw1 < raw2 ? raw2 - raw1 : raw2 + 12 - raw1;
      const start = end - span;
      return start >= 0 && start < 24 ? Math.floor(start) : null;
    }
  }

  const single = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!single) return null;
  const h = to24(+single[1], +(single[2] || 0), (single[3] || "").toLowerCase());
  return h >= 0 && h < 24 ? Math.floor(h) : null;
};

// Start hour of an arrival window label ("2 PM to 3 PM") — the bucket key the
// slot counts are grouped under.
export const arrivalRangeHour = (label) => slotStartHour(label);
