// Medicine-card timing slots — the day's dosing rhythm, in render order.
//
// Shared because two sides need the same list: the card groups by it, and any
// form that records a medicine has to offer it. Two copies would be two chances
// to file a dose under a slot the card does not draw.
//
// Extracted from services/giniflow/medicineCard.js, unchanged.

export const MED_SLOTS = [
  // "Fasting" and "Any time" are slots because `when_to_take` says them and
  // means them. Folding either into "Timing not set" would tell a patient
  // nobody had decided when to take a medicine somebody had decided about.
  { key: "fasting", label: "🌅 Empty stomach" },
  { key: "before_breakfast", label: "🍳 Before breakfast" },
  { key: "with_breakfast", label: "🥘 With breakfast" },
  { key: "after_breakfast", label: "🍽 After breakfast" },
  { key: "before_lunch", label: "🍛 Before lunch" },
  { key: "with_lunch", label: "🥘 With lunch" },
  { key: "after_lunch", label: "🍽 After lunch" },
  { key: "evening", label: "🌇 Evening" },
  { key: "before_dinner", label: "🍲 Before dinner" },
  { key: "with_dinner", label: "🥘 With dinner" },
  { key: "after_dinner", label: "🍽 After dinner" },
  { key: "bedtime", label: "🌙 At bedtime" },
  { key: "with_meals", label: "🍽 With meals" },
  { key: "any_time", label: "🕐 Any time" },
  { key: "weekly", label: "📅 Weekly" },
  { key: "fortnightly", label: "📅 Fortnightly" },
  { key: "sos", label: "🔔 As needed" },
];

export const UNSLOTTED = { key: "unslotted", label: "⏰ Timing not set" };

export const MED_SLOT_KEYS = MED_SLOTS.map((s) => s.key);

export const SLOT_ORDER = new Map(MED_SLOTS.map((s, i) => [s.key, i]));

export const WHEN_TO_TAKE_SLOT = new Map([
  ["fasting", "fasting"],
  ["before breakfast", "before_breakfast"],
  ["after breakfast", "after_breakfast"],
  ["before lunch", "before_lunch"],
  ["after lunch", "after_lunch"],
  ["before dinner", "before_dinner"],
  ["after dinner", "after_dinner"],
  ["at bedtime", "bedtime"],
  ["sos only", "sos"],
  ["any time", "any_time"],
  // NOT exhaustive, deliberately. The Postgres enum carries an eleventh value,
  // "With milk" (25 active rows), which the Zod vocabulary in schemas/index.js
  // does not list and which names an instruction rather than a time. It is left
  // unmapped so those rows read "Timing not set", which is what the data says:
  // nobody recorded when. healthray/parser.js already routes new "with milk"
  // text into `instructions` instead.
]);

// How many doses a frequency means, and the slots a consultant almost always
// picks for it. BD is two timings, not one — the form offers that many and
// fills these in, so the common case is a click and the unusual one is an edit.
export const DOSES_PER_DAY = {
  OD: 1,
  BD: 2,
  TDS: 3,
  QID: 4,
  SOS: 1,
  Weekly: 1,
  Fortnightly: 1,
};

export const DEFAULT_TIMINGS = {
  OD: ["after_breakfast"],
  BD: ["after_breakfast", "after_dinner"],
  TDS: ["after_breakfast", "after_lunch", "after_dinner"],
  QID: ["after_breakfast", "after_lunch", "evening", "after_dinner"],
  SOS: ["sos"],
  Weekly: ["after_breakfast"],
  Fortnightly: ["after_breakfast"],
};

export const dosesFor = (frequency) =>
  DOSES_PER_DAY[String(frequency || "").toUpperCase()] ?? DOSES_PER_DAY[frequency] ?? 1;

// The draft's slot keys -> the `when_to_take` enum medications stores. Slots the
// enum has no value for (with_breakfast, evening, with_meals...) are left out
// rather than bent into a neighbouring one: a wrong time is worse than none.
export const SLOT_TO_WHEN_TO_TAKE = new Map([
  ["fasting", "Fasting"],
  ["before_breakfast", "Before breakfast"],
  ["after_breakfast", "After breakfast"],
  ["before_lunch", "Before lunch"],
  ["after_lunch", "After lunch"],
  ["before_dinner", "Before dinner"],
  ["after_dinner", "After dinner"],
  ["bedtime", "At bedtime"],
  ["sos", "SOS only"],
  ["any_time", "Any time"],
]);

export const whenToTakeFor = (slots) => [
  ...new Set((slots || []).map((s) => SLOT_TO_WHEN_TO_TAKE.get(s)).filter(Boolean)),
];
