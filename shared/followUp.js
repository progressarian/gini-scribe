const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v) => {
  const s = String(v ?? "").slice(0, 10);
  return ISO_DATE.test(s) ? s : "";
};

export function datedFollowUp(fu) {
  return fu && clean(fu.date) ? fu : null;
}

export function effectiveFollowUpDate(row) {
  if (!row) return "";
  return (
    clean(row.follow_up_date) ||
    clean(row.biomarkers?.followup) ||
    clean(row.healthray_follow_up?.date) ||
    ""
  );
}

const TIMING_INTERVAL = /^\d{1,2}\s*(day|week|month|year)s?$/i;

export function followUpTiming(v) {
  const s = String(v ?? "").trim();
  return TIMING_INTERVAL.test(s) ? s : "";
}

const addMonths = (d, n) => {
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
};

export function followUpDueDate(fromDate, timing) {
  const from = clean(fromDate);
  const match = followUpTiming(timing)
    .toLowerCase()
    .match(/^(\d{1,2})\s*(day|week|month|year)/);
  if (!from || !match) return "";
  const n = Number(match[1]);
  const d = new Date(`${from}T00:00:00Z`);
  if (match[2] === "day") d.setUTCDate(d.getUTCDate() + n);
  else if (match[2] === "week") d.setUTCDate(d.getUTCDate() + 7 * n);
  else addMonths(d, match[2] === "month" ? n : 12 * n);
  return d.toISOString().slice(0, 10);
}

export function effectiveFollowUp(row) {
  const date = effectiveFollowUpDate(row);
  const hr = row?.healthray_follow_up || {};
  const timing = hr.timing || "";
  const notes = hr.notes || "";
  if (!date && !timing && !notes) return null;
  return { date, timing, notes };
}

export function pickNextVisit(candidates, today = new Date().toISOString().slice(0, 10)) {
  const list = (candidates || []).filter(Boolean);
  const dated = list
    .map((c) => ({ ...c, date: effectiveFollowUpDate(c) || clean(c.date) }))
    .filter((c) => c.date);
  if (dated.length) {
    const upcoming = dated
      .filter((c) => c.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (upcoming.length) return upcoming[0];
    return dated.sort((a, b) => b.date.localeCompare(a.date))[0];
  }
  return list.find((c) => c.notes || c.timing || c.instructions || c.duration) || null;
}
