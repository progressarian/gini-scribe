export const DEFAULT_OFF_WEEKDAYS = [0];

export const toMin = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};

export const inWindowMin = (start, end, m, inclusiveEnd = false) => {
  if (start == null || end == null || m == null) return true;
  let s = start,
    e = end,
    t = m;
  if (e <= s) e += 1440;
  if (t < s) t += 1440;
  return inclusiveEnd ? t >= s && t <= e : t >= s && t < e;
};

export const inWorkingHours = (p, sStart) =>
  inWindowMin(toMin(p.workStart), toMin(p.workEnd), toMin(sStart));

export const inLunch = (p, sStart) =>
  !!(
    p.lunchStart &&
    p.lunchEnd &&
    inWindowMin(toMin(p.lunchStart), toMin(p.lunchEnd), toMin(sStart))
  );

export const profileFromRow = (row) => {
  const p = row || {};
  return {
    offWeekdays: p.off_weekdays ?? DEFAULT_OFF_WEEKDAYS,
    workStart: p.work_start ?? null,
    workEnd: p.work_end ?? null,
    lunchStart: p.lunch_start ?? null,
    lunchEnd: p.lunch_end ?? null,
  };
};

export const profileSlotState = (profile, weekday, slotStart) => {
  if (profile.offWeekdays.includes(weekday)) return "day_off";
  if (!inWorkingHours(profile, slotStart)) return "not_working";
  if (inLunch(profile, slotStart)) return "break";
  return null;
};
