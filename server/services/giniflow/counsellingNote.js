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

function lineFor(medicine) {
  const label = nameOf(medicine);
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
