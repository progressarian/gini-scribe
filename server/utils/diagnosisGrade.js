export function extractDiagnosisGrade(dx) {
  if (!dx) return null;
  if (dx.key_value && String(dx.key_value).trim()) return String(dx.key_value).trim();
  const notes = dx.notes;
  if (!notes) return null;
  const m = String(notes).match(/^healthray:[\w-]+\s*[—–-]+\s*(.+)$/i);
  return m ? m[1].trim() : null;
}
