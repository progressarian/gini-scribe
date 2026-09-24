export function cleanNote(notes) {
  if (!notes) return null;
  const trimmed = String(notes).trim();
  if (!trimmed) return null;
  const idTokenRe = /healthray(?:_[a-z]+)?:[^|\s]+/gi;

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
