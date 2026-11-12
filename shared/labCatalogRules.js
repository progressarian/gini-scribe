export const ALL_AGES = { min: 0, max: 36500 };

const overlaps = (a, b) => a.minAgeDays < b.maxAgeDays && b.minAgeDays < a.maxAgeDays;

export function overlappingRanges(ranges = []) {
  const live = ranges.filter((r) => !r.pregnant);
  const clashes = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      if (live[i].gender === live[j].gender && overlaps(live[i], live[j])) {
        clashes.push([live[i], live[j]]);
      }
    }
  }
  return clashes;
}

export function fieldIssues(field) {
  if (!field.active || field.type === "group") return [];
  const issues = [];
  if ((field.type === "numeric" || field.type === "calculated") && !field.unit && !field.noUnit) {
    issues.push({ code: "no_unit", text: "No unit — set one, or tick “no unit”" });
  }
  if (overlappingRanges(field.ranges).length) {
    issues.push({ code: "overlap", text: "Two ranges for the same sex overlap in age" });
  }
  for (const input of field.formula?.inputs || []) {
    if (!input.name) {
      issues.push({ code: "missing_input", text: `Formula uses a field that no longer exists` });
    } else if (!input.active) {
      issues.push({
        code: "inactive_input",
        text: `Formula uses ${input.name}, which is turned off`,
      });
    }
  }
  return issues;
}

export function ageText(days) {
  if (days == null) return "";
  if (days >= 365 && days % 365 < 2) return `${Math.round(days / 365.25)} y`;
  if (days >= 30 && days % 30 === 0) return `${days / 30} mo`;
  return `${days} d`;
}

export function ageBandText({ minAgeDays, maxAgeDays }) {
  const fromAll = minAgeDays <= ALL_AGES.min;
  const toAll = maxAgeDays >= ALL_AGES.max;
  if (fromAll && toAll) return "All ages";
  if (toAll) return `${ageText(minAgeDays)} and over`;
  if (fromAll) return `Up to ${ageText(maxAgeDays)}`;
  return `${ageText(minAgeDays)} – ${ageText(maxAgeDays)}`;
}

export function valueRangeText({ min, max, text }) {
  if (text) return text;
  if (min != null && max != null) return `${min} – ${max}`;
  if (max != null) return `< ${max}`;
  if (min != null) return `> ${min}`;
  return "—";
}

export const RANGE_GENDERS = ["Both", "Male", "Female"];
export const MAX_RANGES = 20;

const isNum = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const blank = (v) => v === null || v === undefined || v === "";

export function rangeProblems(ranges = []) {
  const problems = [];
  const add = (index, message) => problems.push({ index, message });
  if (ranges.length > MAX_RANGES) add(null, `Keep it to ${MAX_RANGES} ranges or fewer`);
  ranges.forEach((r, i) => {
    if (!RANGE_GENDERS.includes(r.gender)) add(i, "Choose Both, Male or Female");
    for (const key of ["min", "max", "minCritical", "maxCritical"]) {
      if (!blank(r[key]) && !isNum(r[key])) add(i, "Limits must be numbers");
    }
    const from = Number(r.minAgeDays);
    const to = Number(r.maxAgeDays);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > ALL_AGES.max) {
      add(i, "Ages must be between 0 and 100 years");
    } else if (from > to) {
      add(i, "The age “from” must not be after the age “to”");
    }
    if (blank(r.min) && blank(r.max) && !String(r.text ?? "").trim()) {
      add(i, "Enter a low or high limit, or what the report prints");
    }
    if (isNum(r.min) && isNum(r.max) && Number(r.min) > Number(r.max)) {
      add(i, "Low must not be above high");
    }
    if (isNum(r.minCritical) && isNum(r.min) && Number(r.minCritical) > Number(r.min)) {
      add(i, "Critical low must be at or below low");
    }
    if (isNum(r.maxCritical) && isNum(r.max) && Number(r.maxCritical) < Number(r.max)) {
      add(i, "Critical high must be at or above high");
    }
    if (String(r.text ?? "").length > 120) add(i, "Keep the printed text under 120 characters");
  });
  const live = ranges
    .map((r, index) => ({
      ...r,
      index,
      minAgeDays: Number(r.minAgeDays),
      maxAgeDays: Number(r.maxAgeDays),
    }))
    .filter((r) => !r.pregnant);
  for (const [a, b] of overlappingRanges(live)) {
    add(b.index, `Overlaps range ${a.index + 1} for ${a.gender} in age — narrow one of them`);
  }
  return problems;
}

export function daysFrom(amount, unit) {
  if (blank(amount)) return null;
  const n = Number(amount);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return Math.round(n * (unit === "y" ? 365 : unit === "mo" ? 30 : 1));
}

export function splitDays(days) {
  if (days == null) return { amount: "", unit: "y" };
  if (days % 365 === 0) return { amount: String(days / 365), unit: "y" };
  if (days % 30 === 0) return { amount: String(days / 30), unit: "mo" };
  return { amount: String(days), unit: "d" };
}
