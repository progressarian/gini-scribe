// Single source of truth for the patient-facing "when to take" vocabulary.
// `when_to_take` on a medication row stores one or more of these labels,
// joined by ", ". The legacy `timing` column is now a separate free-text
// consultant note and is no longer the source of truth for buckets.

export const WHEN_TO_TAKE_PILLS = [
  "Fasting",
  "Before breakfast",
  "After breakfast",
  "Before lunch",
  "After lunch",
  "Before dinner",
  "After dinner",
  "At bedtime",
  "With milk",
  "SOS only",
  "Any time",
];

// Print/print-card sections — one per pill, in patient-facing order.
// Labels are bilingual (Hindi + English) to match the printed med card.
export const TIME_SLOTS = [
  {
    key: "fasting",
    pill: "Fasting",
    label: "Khaali pet (Fasting)",
    emoji: "🌅",
    colorVar: "--teal",
    bgCls: "teal-lt",
  },
  {
    key: "before_breakfast",
    pill: "Before breakfast",
    label: "Naashte se pehle (Before Breakfast)",
    emoji: "🌄",
    colorVar: "--primary",
    bgCls: "pri-lt",
  },
  {
    key: "after_breakfast",
    pill: "After breakfast",
    label: "Naashte ke baad (After Breakfast)",
    emoji: "☕",
    colorVar: "--amber",
    bgCls: "amb-lt",
  },
  {
    key: "before_lunch",
    pill: "Before lunch",
    label: "Khaane se pehle (Before Lunch)",
    emoji: "🍽️",
    colorVar: "--t3",
    bgCls: "bg",
    border: true,
  },
  {
    key: "after_lunch",
    pill: "After lunch",
    label: "Khaane ke baad (After Lunch)",
    emoji: "🍛",
    colorVar: "--green",
    bgCls: "grn-lt",
  },
  {
    key: "before_dinner",
    pill: "Before dinner",
    label: "Dinner se pehle (Before Dinner)",
    emoji: "🌙",
    colorVar: "--t3",
    bgCls: "bg",
    border: true,
  },
  {
    key: "after_dinner",
    pill: "After dinner",
    label: "Dinner ke baad (After Dinner)",
    emoji: "🌆",
    colorVar: "--t3",
    bgCls: "bg",
    border: true,
  },
  {
    key: "at_bedtime",
    pill: "At bedtime",
    label: "Sone se pehle (At Bedtime)",
    emoji: "💤",
    colorVar: "--purple",
    bgCls: "pur-lt",
  },
  {
    key: "with_milk",
    pill: "With milk",
    label: "Doodh ke saath (With Milk)",
    emoji: "🥛",
    colorVar: "--primary",
    bgCls: "pri-lt",
  },
  {
    key: "sos_only",
    pill: "SOS only",
    label: "Zaroorat padne par (SOS only)",
    emoji: "🚨",
    colorVar: "--amber",
    bgCls: "amb-lt",
  },
  {
    key: "any_time",
    pill: "Any time",
    label: "Kabhi bhi (Any Time)",
    emoji: "🕒",
    colorVar: "--t3",
    bgCls: "bg",
    border: true,
  },
];

const PILL_TO_KEY = TIME_SLOTS.reduce((acc, s) => {
  acc[s.pill.toLowerCase()] = s.key;
  return acc;
}, {});

const PILL_SET = new Set(WHEN_TO_TAKE_PILLS.map((p) => p.toLowerCase()));

export function pillToSlotKey(pill) {
  if (!pill) return null;
  return PILL_TO_KEY[String(pill).trim().toLowerCase()] || null;
}

// Normalise whatever `when_to_take` comes in as — a Postgres text[] (the
// canonical shape), a JSON array, a comma-separated legacy string, or null —
// into a deduped array of canonical pill labels. Anything not in the
// vocabulary is dropped.
export function toWhenToTakeArray(value) {
  if (value == null) return [];
  let tokens = [];
  if (Array.isArray(value)) {
    tokens = value;
  } else if (typeof value === "string") {
    // Postgres text array literal "{a,b}" sneaks through some drivers; split
    // on comma after stripping braces. Plain comma-separated strings (legacy)
    // go through the same path.
    tokens = value.replace(/^\{|\}$/g, "").split(",");
  } else {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const raw of tokens) {
    const t = String(raw || "")
      .trim()
      .replace(/^"|"$/g, "");
    if (!t) continue;
    const canonical = WHEN_TO_TAKE_PILLS.find((p) => p.toLowerCase() === t.toLowerCase());
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

// Human-readable display string. Use this anywhere the old code did
// `med.when_to_take` with the assumption it was a string.
export function formatWhenToTake(value) {
  return toWhenToTakeArray(value).join(", ");
}

// Returns slot keys for the printable med card. Accepts a med object,
// a raw array, or a legacy string. When the med has no canonical pills
// but does have a free-text `timing` note, we try to bucket from that
// (e.g. "Empty stomach 30 min before breakfast" → Fasting) so the patient
// still sees the med in a meaningful section instead of "Any time".
export function getTimeSlots(med) {
  const raw = med && med.when_to_take != null ? med.when_to_take : med;
  const arr = toWhenToTakeArray(raw);
  const slots = new Set();
  for (const pill of arr) {
    const key = pillToSlotKey(pill);
    if (key) slots.add(key);
  }
  if (slots.size === 0 && med && typeof med.timing === "string" && med.timing) {
    const t = med.timing.toLowerCase();
    if (/empty stomach|fast/.test(t)) slots.add("fasting");
    else if (/before breakfast|pre[- ]?breakfast/.test(t)) slots.add("before_breakfast");
    else if (/after breakfast|post[- ]?breakfast|morning/.test(t)) slots.add("after_breakfast");
    else if (/before lunch/.test(t)) slots.add("before_lunch");
    else if (/after lunch|with lunch/.test(t)) slots.add("after_lunch");
    else if (/before dinner/.test(t)) slots.add("before_dinner");
    else if (/after dinner|after meal|with dinner|evening/.test(t)) slots.add("after_dinner");
    else if (/bedtime|at night|hs\b/.test(t)) slots.add("at_bedtime");
    else if (/with milk/.test(t)) slots.add("with_milk");
    else if (/sos|prn|as needed/.test(t)) slots.add("sos_only");
  }
  if (slots.size === 0) slots.add("any_time");
  return [...slots];
}

export function getTimeSlot(med) {
  return getTimeSlots(med)[0];
}

export function isValidPill(value) {
  return typeof value === "string" && PILL_SET.has(value.toLowerCase());
}
