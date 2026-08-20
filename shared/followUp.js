const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const clean = (v) => {
  const s = String(v ?? "").slice(0, 10);
  return ISO_DATE.test(s) ? s : "";
};

export function effectiveFollowUpDate(row) {
  if (!row) return "";
  return (
    clean(row.follow_up_date) ||
    clean(row.biomarkers?.followup) ||
    clean(row.healthray_follow_up?.date) ||
    ""
  );
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
