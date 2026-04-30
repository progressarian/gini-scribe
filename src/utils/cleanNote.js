// Strip HealthRay id prefixes from notes. Handles:
//   - bare "healthray:<id>" or pipe-joined "healthray_appt:…|healthray_record:…|…"
//   - "<healthray ids> — detail" form (returns the trailing detail)
// Returns null when nothing meaningful remains.
export function cleanNote(notes) {
  if (!notes) return null;
  const trimmed = String(notes).trim();
  if (!trimmed) return null;
  // Matches a single "healthray*:<id>" segment (with optional _suffix and any
  // value up to the next pipe / dash separator / end of string).
  const idTokenRe = /healthray(?:_[a-z]+)?:[^|\s]+/gi;
  // Strip pipe-joined groups of these tokens as a single unit (with surrounding
  // pipes/whitespace).
  let cleaned = trimmed
    .replace(
      /(?:^|\s|·)\s*(?:healthray(?:_[a-z]+)?:[^|\s]+)(?:\s*\|\s*healthray(?:_[a-z]+)?:[^|\s]+)*/gi,
      "",
    )
    .replace(idTokenRe, "")
    .replace(/\s*[—–-]+\s*/g, " — ")
    .replace(/^\s*[—–-]+\s*|\s*[—–-]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || null;
}
