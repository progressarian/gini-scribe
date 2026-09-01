// The counselling note the pharmacist reads aloud at the counter.
//
// docs/gini-flow/16-PHARMACY-STATION-PLAN.md §5.1, brief §4.6.
//
// Pure — no database, no network. It takes the prescription rows and returns
// two paragraphs. Pure because it is the one thing at this station that is a
// language artefact rather than a query, and its output is worth being able to
// check without a floor.
//
// A TEMPLATE, not free text. Every sentence is composed from a `change_type`
// and the values already stored on the medicine, so the note cannot drift from
// what was actually prescribed. Nothing here translates a dosing instruction:
// where a medicine carries a clinical note it is quoted verbatim inside the
// Hindi sentence, exactly as the prototype does, because a machine-translated
// dose is a clinical risk and a quoted English phrase is not.
//
// HINDI FIRST. It is the language the sentence is read aloud in.

const CHANGE_TYPES = ["changed", "new", "stopped", "paused"];

const HINDI_NUMBER = ["कोई", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ", "दस"];

const ENGLISH_NUMBER = [
  "No",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
];

const clean = (value) => (typeof value === "string" ? value.trim() : "") || null;

// "Fenofibrate 145mg", not "Fenofibrate 145mg 145mg". Brand names in this
// formulary routinely carry the strength already, and a sentence read aloud
// that says the dose twice sounds like two doses.
const nameOf = (m) => {
  const name = clean(m.name);
  const dose = clean(m.dose);
  if (!dose) return name;
  if (!name) return dose;
  const strength = dose.match(/\d+(?:\.\d+)?/)?.[0];
  const already =
    name.toLowerCase().includes(dose.toLowerCase()) || (strength && name.includes(strength));
  return already ? name : `${name} ${dose}`;
};

const hindiCount = (n) => HINDI_NUMBER[n] || String(n);
const englishCount = (n) => ENGLISH_NUMBER[n] || String(n);

// One sentence per change, in both languages. `reason` is the consultant's own
// clinical note — quoted, never rewritten.
function lineFor(medicine) {
  const label = nameOf(medicine);
  // `buildCard` calls the consultant's clinical note `note`; the draft rows call
  // the same field `reason`. Either is the "why" this sentence quotes.
  const reason = clean(medicine.reason ?? medicine.note);
  const from = clean(medicine.previousDose);
  const to = clean(medicine.dose);
  const stopReason = clean(medicine.stopReason);

  switch (medicine.changeType) {
    case "new":
      return {
        hindi: `एक नई दवाई ${label} शुरू की गई है${reason ? ` — ${reason} के लिए` : ""}।`,
        english: `${label} started today${reason ? ` for ${reason}` : ""}.`,
      };
    case "changed":
      return {
        hindi:
          from && to
            ? `${clean(medicine.name)} की dose बदली गई है (${from} से ${to})।`
            : `${label} की dose बदली गई है।`,
        english:
          from && to
            ? `${clean(medicine.name)} dose changed from ${from} to ${to}.`
            : `${label} dose changed.`,
      };
    case "stopped":
      return {
        hindi: `${label} बंद कर दी गई है${stopReason ? ` — ${stopReason}` : ""}। अब यह दवाई नहीं लेनी है।`,
        english: `${label} stopped${stopReason ? ` — ${stopReason}` : ""}. Do not take it any more.`,
      };
    case "paused":
      return {
        hindi: `${label} फ़िलहाल रोक दी गई है — डॉक्टर के कहने पर ही दोबारा शुरू करें।`,
        english: `${label} paused for now — restart only when the doctor says so.`,
      };
    default:
      return null;
  }
}

// `medicines` is the shape `medicineCard.buildCard` and the prescription rows
// already use: { medicationId, name, dose, previousDose, changeType, reason,
// stopReason, external }. External medicines are excluded — the Gini pharmacy
// did not prescribe them and does not counsel on them.
export function buildCounsellingNote(medicines = []) {
  const changes = medicines
    .filter((m) => !m.external && CHANGE_TYPES.includes(m.changeType))
    .map((m) => {
      const line = lineFor(m);
      return line
        ? {
            medicationId: m.medicationId ?? null,
            name: clean(m.name),
            changeType: m.changeType,
            ...line,
          }
        : null;
    })
    .filter(Boolean);

  const continued = medicines.filter((m) => !m.external && m.changeType === "continued").length;

  if (!changes.length) {
    return {
      hasChanges: false,
      changes: [],
      hindi:
        continued > 0
          ? `आज की दवाइयाँ: आपकी दवाइयों में कोई बदलाव नहीं है। सभी ${hindiCount(continued)} दवाइयाँ पहले की तरह जारी रखें।`
          : "आज की दवाइयाँ: कोई बदलाव नहीं। दवाइयाँ पहले की तरह जारी रखें।",
      english:
        continued > 0
          ? `No changes today — continue all ${continued} medicine${continued === 1 ? "" : "s"} exactly as before.`
          : "No changes today — continue the medicines exactly as before.",
    };
  }

  const n = changes.length;
  const hindiHead = `आज की दवाइयाँ: आपकी दवाइयों में ${hindiCount(n)} बदलाव ${n === 1 ? "हुआ" : "हुए"} ${n === 1 ? "है" : "हैं"} —`;
  const englishHead = `${englishCount(n)} change${n === 1 ? "" : "s"} today —`;

  return {
    hasChanges: true,
    changes,
    hindi: [hindiHead, ...changes.map((c) => c.hindi)].join(" "),
    english: [englishHead, ...changes.map((c) => c.english)].join(" "),
  };
}
