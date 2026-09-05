import pool from "../../config/db.js";
import { parseClaudeJson } from "../extraction.js";
import { searchMedicines } from "./prescription.js";
import { stripFormPrefix } from "../../../src/lib/medName.js";
import { WHEN_TO_TAKE_SLOT, MED_SLOT_KEYS } from "../../../shared/giniflowMedTiming.js";

// Reads a pasted prescription and offers it back as draft rows.
//
// docs/gini-flow/27-RX-PASTE-PLAN.md. Six medicines typed by hand is six trips
// through the search box, the dose field, the frequency picker and the timing
// chips — for a list the consultant often already has as text.
//
// THIS EXTRACTS, IT DOES NOT AUTHOR, the same property planExtract.js states and
// for the same reason. Nothing here writes: the endpoint returns a proposal, the
// review table fills, and the consultant presses Add. A dose the text does not
// state comes back empty for them to fill — never guessed, and never normalised
// (`60+500 mg` is a real strength in this hospital's data; "correcting" it would
// change a prescription).
//
// Two passes, cheapest first. Pass 1 is a tokeniser over the line shapes this
// hospital already writes and costs nothing; only what it cannot read reaches
// the model.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MAX_PASTE_CHARS = 6000;
const MAX_LINES = 40;

// §3.2 of the plan: the short forms the pickers and DOSES_PER_DAY are keyed on,
// with the prose the hospital actually writes folded onto them. 58,066 rows say
// "OD" and 5,050 say "Once daily"; they mean the same thing and the form offers
// only the first.
const FREQUENCY_SYNONYMS = new Map([
  ["od", "OD"],
  ["once daily", "OD"],
  ["once a day", "OD"],
  ["one daily", "OD"],
  ["qd", "OD"],
  ["hs", "OD"],
  ["bd", "BD"],
  ["bid", "BD"],
  ["twice daily", "BD"],
  ["twice a day", "BD"],
  ["tds", "TDS"],
  ["tid", "TDS"],
  ["thrice daily", "TDS"],
  ["three times a day", "TDS"],
  ["qid", "QID"],
  ["four times a day", "QID"],
  ["sos", "SOS"],
  ["prn", "SOS"],
  ["as needed", "SOS"],
  ["if needed", "SOS"],
  ["weekly", "Weekly"],
  ["once a week", "Weekly"],
  ["fortnightly", "Fortnightly"],
  ["once in 15 days", "Fortnightly"],
  ["once in a fortnight", "Fortnightly"],
]);

// The 1-0-1 idiom, which nothing in the repo parses today — the only occurrences
// are literals in demo.js. Each slot is a dose count across the day.
const PATTERN_RE =
  /(?:^|\s)([01½.\d]+)\s*-\s*([01½.\d]+)\s*-\s*([01½.\d]+)(?:\s*-\s*([01½.\d]+))?(?=\s|$)/;
const PATTERN_FREQUENCY = { 1: "OD", 2: "BD", 3: "TDS", 4: "QID" };

// Strength as written. Deliberately permissive about what follows the number —
// `60,000 IU`, `0.4+0.5 mg`, `10/20 mg` and `60K` are all real values here.
const DOSE_RE =
  /(?:^|\s)(\d[\d.,]*(?:\s*[+/]\s*\d[\d.,]*)*\s*(?:mcg|mg|gm|g|ml|iu|units?|k|%)\b|\d[\d.,]*\s*[+/]\s*\d[\d.,]*)/i;

const DURATION_RE =
  /(?:\bx\s*|\bfor\s+)(\d+)\s*(day|days|week|weeks|month|months|d|w|m)\b|\b(\d+)\s*(day|days|week|weeks|month|months)\b/i;

// Longest first, so "before breakfast" is not consumed by "breakfast".
const TIMING_PHRASES = [...WHEN_TO_TAKE_SLOT.entries()]
  .concat([
    ["with breakfast", "with_breakfast"],
    ["with lunch", "with_lunch"],
    ["with dinner", "with_dinner"],
    ["with meals", "with_meals"],
    ["after meals", "with_meals"],
    ["before meals", "before_breakfast"],
    ["with food", "with_meals"],
    ["after food", "with_meals"],
    ["before food", "before_breakfast"],
    ["empty stomach", "fasting"],
    ["bedtime", "bedtime"],
    ["night", "bedtime"],
    ["evening", "evening"],
    ["morning", "after_breakfast"],
  ])
  .sort((a, b) => b[0].length - a[0].length);

const FREQ_PHRASES = [...FREQUENCY_SYNONYMS.entries()].sort((a, b) => b[0].length - a[0].length);

// A line that is prose rather than a prescription must not become a medicine.
// "review after 2 weeks" left the tokens "review after" behind, and both are
// words about the visit, not a drug — so a name made only of these is rejected.
const NOT_A_NAME = new Set([
  "review",
  "follow",
  "followup",
  "up",
  "after",
  "before",
  "continue",
  "stop",
  "all",
  "other",
  "others",
  "medicine",
  "medicines",
  "same",
  "next",
  "visit",
  "and",
  "with",
  "take",
  "daily",
  "please",
  "advice",
  "advised",
  "plan",
  "note",
  "rx",
  "the",
  "for",
]);

const CLOCK_RE =
  /(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/i;

const clean = (s) =>
  String(s || "")
    .replace(/\s+/g, " ")
    .trim();

const normaliseDuration = (m) => {
  if (!m) return null;
  const n = m[1] || m[3];
  const unitRaw = (m[2] || m[4] || "").toLowerCase();
  if (!n) return null;
  const unit = unitRaw.startsWith("w")
    ? "week"
    : unitRaw.startsWith("mo") || unitRaw === "m"
      ? "month"
      : "day";
  return `${n} ${unit}${Number(n) === 1 ? "" : "s"}`;
};

const toClock = (m) => {
  if (!m) return null;
  if (m[4] !== undefined) return `${String(m[4]).padStart(2, "0")}:${m[5]}`;
  let h = Number(m[1]);
  const min = m[2] || "00";
  const mer = (m[3] || "").toLowerCase();
  if (mer === "pm" && h !== 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${min}`;
};

// One line -> one proposed row, or null when the line is not a medicine.
//
// Everything recognisable is stripped out in a fixed order and whatever survives
// is the name. Order matters twice: frequency runs BEFORE duration, or "once in
// 15 days" loses its "15 days" to the duration rule and leaves "once in" glued
// to the drug; and the clock is taken before the name, or "8 PM after dinner"
// makes the medicine "Urimax D 8 PM".
export function parseLine(rawLine) {
  const line = clean(rawLine).replace(/^[-•*\d]+[.)]?\s*/, "");
  if (!line || line.length < 3) return null;

  let rest = line;
  const cut = (re) => {
    const m = rest.match(re);
    if (m) rest = clean(rest.replace(m[0], " "));
    return m;
  };

  // The clock is still lifted out of the line — leaving it in made the medicine
  // "Urimax D 8 PM" — but it is no longer written to time_of_day. That column is
  // set on 3 of 124,921 active medications and cannot describe a BD dose. The
  // hospital writes "8 PM after dinner" in the timing text, so it goes there.
  const clockMatch = cut(CLOCK_RE);
  const clockText = clockMatch ? clean(clockMatch[0]) : null;

  // Every frequency mention, not just the first: "SOS as needed" says it twice
  // and leaving one behind put "SOS" in the medicine's name.
  let frequency = null;
  for (const [phrase, short] of FREQ_PHRASES) {
    const re = new RegExp(`(?:^|\\s)${phrase}(?=\\s|$)`, "ig");
    if (re.test(rest)) {
      frequency = frequency || short;
      rest = clean(rest.replace(new RegExp(`(?:^|\\s)${phrase}(?=\\s|$)`, "ig"), " "));
    }
  }

  const patternMatch = cut(PATTERN_RE);
  if (!frequency && patternMatch) {
    const slots = [patternMatch[1], patternMatch[2], patternMatch[3], patternMatch[4]]
      .filter((v) => v !== undefined)
      .map((v) => (v === "½" ? 0.5 : Number(v)));
    const active = slots.filter((n) => n > 0).length;
    frequency = PATTERN_FREQUENCY[active] || null;
  }

  const durationMatch = cut(DURATION_RE);

  let timing = null;
  let timingCategory = null;
  for (const [phrase, slot] of TIMING_PHRASES) {
    const re = new RegExp(
      `(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`,
      "ig",
    );
    if (re.test(rest)) {
      if (!timing) {
        timing = phrase;
        timingCategory = MED_SLOT_KEYS.includes(slot) ? slot : null;
      }
      rest = clean(rest.replace(re, " "));
    }
  }

  const doseMatch = rest.match(DOSE_RE);
  const dose = doseMatch ? clean(doseMatch[1]) : null;
  if (doseMatch) rest = clean(rest.replace(doseMatch[0], " "));

  const { name } = stripFormPrefix(clean(rest).replace(/[,;:.]+$/, ""));
  const medicineName = clean(name);
  if (!medicineName || !/[a-z]/i.test(medicineName)) return null;
  // A bare instruction ("stop montair", "continue all") is not an addition. Out
  // of scope for this pass — plan §9.2 — and must not become a new medicine.
  if (/^(stop|continue|pause|hold|omit|discontinue|review|follow)\b/i.test(medicineName))
    return null;
  // Prose leaves only words about the visit behind. A real name has at least one
  // token that is none of them.
  const tokens = medicineName.toLowerCase().split(/\s+/);
  if (!tokens.some((t) => t.length >= 3 && !NOT_A_NAME.has(t.replace(/[^a-z]/g, "")))) return null;
  // A brand is a few words. Anything longer is a sentence that happens to
  // contain a drug — "Patient should take Atchol forty mg at night and Glycomet
  // five hundred twice a day" was being collapsed into ONE row named after the
  // whole phrase. Handing it to the model instead is the only honest answer:
  // pass 1 cannot tell where one medicine ends and the next begins.
  if (tokens.length > 5) return null;

  return {
    medicineName,
    dose,
    frequency,
    timing: [clockText, timing].filter(Boolean).join(" ") || null,
    timingCategory,
    duration: normaliseDuration(durationMatch),
    source: "parsed",
  };
}

const SYSTEM = `You are a parser for a hospital's OPD software. You are given lines from a prescription that a rule-based parser could not read, and the patient's active medicines.

Return ONLY valid JSON, no backticks, no prose:
{
  "items": [{"medicineName": "...", "dose": "...", "frequency": "...", "timing": "...", "duration": "...", "reason": "..."}],
  "unreadable": ["the line exactly as given", ...]
}

Rules, all of them strict:
- Extract ONLY what a line states. Never add a medicine, dose, frequency, timing or duration the line does not name, however clinically sensible it would be.
- A field the line does not state must be "" — an empty string. NEVER guess a dose. An empty dose is correct and the consultant will fill it.
- Copy the dose EXACTLY as written, including forms like "60+500 mg", "60,000 IU", "10/20 mg". Do not convert, round or tidy it.
- "frequency" must be one of: OD, BD, TDS, QID, SOS, Weekly, Fortnightly — or "" if the line does not say. "1-0-1" means BD, "1-0-0" means OD, "1-1-1" means TDS.
- "timing" is the line's own wording for when to take it ("after lunch", "8 PM", "empty stomach"), or "".
- "reason" only when the line gives one ("for bp", "for sugar"). Never invent an indication from the drug name.
- A line that is an instruction about an existing medicine (stop, continue, pause, hold) is NOT an item. Put it in "unreadable".
- A line you cannot confidently read as one medicine goes in "unreadable", copied exactly.
- A line you DID read items from must NOT also appear in "unreadable". One sentence naming two medicines is two items and nothing unreadable.`;

async function askModel(lines, activeMeds) {
  if (!ANTHROPIC_KEY || !lines.length) return { items: [], unreadable: lines };

  const userText = [
    `PATIENT'S ACTIVE MEDICINES:\n${activeMeds.length ? activeMeds.join("\n") : "(none on record)"}`,
    `LINES TO READ:\n${lines.join("\n")}`,
  ].join("\n\n");

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM,
      messages: [{ role: "user", content: userText }],
    }),
    // A model that never answers must not hold the consultant's screen. The
    // lines come back as unreadable and they type those few by hand.
    signal: AbortSignal.timeout(20_000),
  }).catch(() => null);

  if (!resp?.ok) return { items: [], unreadable: lines, modelFailed: true };

  const json = await resp.json().catch(() => null);
  const { data } = parseClaudeJson(json?.content?.[0]?.text || "");
  if (!data) return { items: [], unreadable: lines, modelFailed: true };

  const items = (data.items || [])
    .filter((i) => i && clean(i.medicineName))
    .map((i) => ({
      medicineName: clean(i.medicineName),
      dose: clean(i.dose) || null,
      frequency: clean(i.frequency) || null,
      timing: clean(i.timing) || null,
      timingCategory: WHEN_TO_TAKE_SLOT.get(clean(i.timing).toLowerCase()) || null,
      duration: clean(i.duration) || null,
      reason: clean(i.reason) || null,
      source: "model",
    }));

  // Belt and braces on the rule above: drop any "unreadable" line that plainly
  // produced one of the items. Telling the consultant to add by hand a line the
  // model just read for them is worse than saying nothing.
  const named = items.map((i) => i.medicineName.toLowerCase());
  const unreadable = (data.unreadable || [])
    .map(clean)
    .filter(Boolean)
    .filter((line) => !named.some((n) => line.toLowerCase().includes(n)));

  return { items, unreadable };
}

// The catalogue is the authority, not the parser. An exact hit fills the row; a
// near-miss never does — the same rule planExtract applies to test names, and
// here the cost of guessing is the wrong drug.
// "Glycomet 1000" and the catalogue's "GLYCOMET 1000mg" are the same medicine —
// the strength is written with its unit on one side and without it on the other.
// Comparing with the trailing unit removed closes that gap WITHOUT loosening the
// rule that matters: the digits must still be identical, so "Glycomet 1000"
// never reaches "Glycomet 500".
const matchKey = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\s*(mg|mcg|gm|g|ml|iu|units?)\b/g, "")
    .replace(/[^a-z0-9]/g, "");

async function resolve(item, db) {
  let hits = await searchMedicines(item.medicineName, db).catch(() => []);
  const wanted = matchKey(item.medicineName);
  const sameKey = hits.filter((h) => matchKey(h.name) === wanted);
  const exact =
    hits.find((h) => h.name.toLowerCase() === item.medicineName.toLowerCase()) ||
    // Only when it is unambiguous. Two catalogue rows collapsing to one key is
    // a choice for the consultant, not for this.
    (sameKey.length === 1 ? sameKey[0] : null);
  if (!exact) {
    // The catalogue search is a substring match, so "Fenofibrate 145" misses
    // "Fenofibrate 145mg" and the consultant is offered nothing at all. Fall
    // back to the brand root purely to populate the choices — this still never
    // picks one, it only stops the row being a dead end.
    if (!hits.length) {
      const root = item.medicineName.split(/\s+/)[0];
      if (root && root.length >= 3) hits = await searchMedicines(root, db).catch(() => []);
    }
    return {
      ...item,
      matched: false,
      composition: null,
      drugClass: null,
      timesPrescribed: 0,
      candidates: hits.slice(0, 5).map((h) => h.name),
    };
  }
  return {
    ...item,
    medicineName: exact.name,
    matched: true,
    composition: exact.composition,
    drugClass: exact.drugClass,
    timesPrescribed: exact.timesPrescribed,
    // Plan §4.3: prescribed here before is a safe fill; a formulary row nobody
    // has ever used is a suggestion worth a second look, not an error.
    firstTimeHere: exact.timesPrescribed === 0,
    candidates: [],
  };
}

export async function parsePaste(visitId, text, db = pool) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw Object.assign(new Error("Paste the prescription first — there is nothing to read yet"), {
      status: 400,
    });
  }

  const lines = raw
    .slice(0, MAX_PASTE_CHARS)
    .split(/\r?\n|(?<=\))\s*;\s*/)
    .map(clean)
    .filter(Boolean)
    .slice(0, MAX_LINES);

  const parsed = [];
  const leftover = [];
  for (const line of lines) {
    const hit = parseLine(line);
    if (hit) parsed.push(hit);
    else leftover.push(line);
  }

  const { rows: meds } = await db.query(
    `SELECT m.name, m.dose, m.frequency
       FROM medications m
       JOIN giniflow_visits v ON v.patient_id = m.patient_id
      WHERE v.id = $1 AND m.is_active = true
      ORDER BY m.name`,
    [visitId],
  );
  const activeMeds = meds.map((m) => `${m.name} — ${m.dose || "?"} ${m.frequency || ""}`.trim());

  const fromModel = await askModel(leftover, activeMeds);
  const all = [...parsed, ...fromModel.items];

  // Resolved in parallel: a six-line paste is six catalogue lookups and the
  // consultant is watching the panel.
  const items = await Promise.all(all.map((i) => resolve(i, db)));

  return {
    items,
    unreadable: fromModel.unreadable || [],
    usedModel: fromModel.items.length > 0 || !!fromModel.modelFailed,
    modelFailed: !!fromModel.modelFailed,
    counts: {
      read: items.length,
      matched: items.filter((i) => i.matched).length,
      needsBrand: items.filter((i) => !i.matched).length,
      unreadable: (fromModel.unreadable || []).length,
    },
  };
}
