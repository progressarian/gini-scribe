// Patient identity matching utilities, used by companionStore +
// labStore when deciding whether an uploaded report belongs to the
// currently-selected patient.
//
// Rules (per product):
//   1. If the report's patient ID/UHID matches the selected patient's
//      file number, treat it as the same patient — even if the printed
//      NAME looks different (married-name change, truncated scan,
//      transliteration variants, etc.). The ID is the strong signal.
//   2. For name comparison, strip salutation prefixes (Mr/Mrs/Ms/Dr/
//      Shri/Smt...) before tokenizing so "Mr. Harish Kumar" matches
//      "Harish Kumar" without triggering a mismatch warning.

const TITLE_PREFIXES = new Set([
  "mr",
  "mrs",
  "ms",
  "miss",
  "dr",
  "doc",
  "doctor",
  "master",
  "mstr",
  "shri",
  "smt",
  "sri",
  "sh",
  "prof",
]);

// Strip leading salutation tokens like "Mr.", "Mrs.", "Dr." — repeat in
// case a name carries multiple titles (e.g. "Dr. Mrs. X"). Never drops
// the last token, so a bare "Dr" never becomes an empty string.
export function stripTitles(name) {
  if (!name) return "";
  const tokens = String(name).trim().split(/\s+/);
  while (tokens.length > 1) {
    const first = tokens[0].toLowerCase().replace(/[.,]/g, "");
    if (TITLE_PREFIXES.has(first)) {
      tokens.shift();
    } else {
      break;
    }
  }
  return tokens.join(" ");
}

// Normalize patient IDs for comparison — strip punctuation/whitespace
// and lowercase. Handles "P_123" vs "p123" vs "P-123".
export function normalizePatientId(id) {
  if (!id) return "";
  return String(id)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

// Strong-signal match: are these the same patient by ID?
export function patientIdsMatch(a, b) {
  const na = normalizePatientId(a);
  const nb = normalizePatientId(b);
  if (!na || !nb) return false;
  return na === nb;
}

// Fuzzy token-level name match after stripping titles. Two names match
// if any token of length > 2 from one name appears as a substring of a
// token in the other name. Permissive on purpose — handles first/last
// name variations, middle name presence/absence, etc.
export function patientNamesMatch(a, b) {
  const aa = stripTitles(a).toLowerCase();
  const bb = stripTitles(b).toLowerCase();
  if (!aa || !bb || aa.length < 3 || bb.length < 3) return false;
  const rp = aa.split(/\s+/);
  const sp = bb.split(/\s+/);
  return rp.some((x) => x.length > 2 && sp.some((y) => y.includes(x) || x.includes(y)));
}
