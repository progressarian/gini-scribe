const WORD_DOSES = [
  [/^(od|once daily|once a day|daily|hs|at night|bedtime|qhs)$/i, 1],
  [/^(bd|bid|twice daily|twice a day)$/i, 2],
  [/^(tds|tid|thrice daily|three times a day)$/i, 3],
  [/^(qid|qds|four times a day)$/i, 4],
];

const DOSE_PART = /^(\d+(?:\.\d+)?|½|1\/2)$/;

const partValue = (part) => (part === "½" || part === "1/2" ? 0.5 : Number(part));

export function dosesPerDay(frequency) {
  const text = String(frequency ?? "").trim();
  if (!text) return null;
  for (const [pattern, doses] of WORD_DOSES) if (pattern.test(text)) return doses;
  const parts = text.split(/\s*-\s*/);
  if (parts.length >= 3 && parts.length <= 4 && parts.every((p) => DOSE_PART.test(p))) {
    const total = parts.reduce((sum, p) => sum + partValue(p), 0);
    return total > 0 ? total : null;
  }
  return null;
}

const DAYS_PER = { day: 1, week: 7, month: 30 };

export function durationDays(duration) {
  const match = /^(\d{1,3})\s*(day|week|month)s?$/i.exec(String(duration ?? "").trim());
  if (!match) return null;
  const days = Number(match[1]) * DAYS_PER[match[2].toLowerCase()];
  return days > 0 && days <= 365 ? days : null;
}

export function suggestedUnits({ frequency, duration }) {
  const perDay = dosesPerDay(frequency);
  const days = durationDays(duration);
  if (!perDay || !days) return null;
  return Math.ceil(perDay * days);
}
