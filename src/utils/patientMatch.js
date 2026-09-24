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

export function normalizePatientId(id) {
  if (!id) return "";
  return String(id)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}
export function patientIdsMatch(a, b) {
  const na = normalizePatientId(a);
  const nb = normalizePatientId(b);
  if (!na || !nb) return false;
  return na === nb;
}
export function patientNamesMatch(a, b) {
  const aa = stripTitles(a).toLowerCase();
  const bb = stripTitles(b).toLowerCase();
  if (!aa || !bb || aa.length < 3 || bb.length < 3) return false;
  const rp = aa.split(/\s+/);
  const sp = bb.split(/\s+/);
  return rp.some((x) => x.length > 2 && sp.some((y) => y.includes(x) || x.includes(y)));
}
