// Extracts a grade/marker string (e.g. "G3bA3", "moderate NPDR")
// from a diagnosis row. Prefers the manually-set key_value column;
// otherwise parses the Healthray-synced notes payload of the form
// "healthray:<id> — <grade>". Mirrors extractHRDetail in
// src/components/visit/VisitDiagnoses.jsx.
export function extractDiagnosisGrade(dx) {
  if (!dx) return null;
  if (dx.key_value && String(dx.key_value).trim()) return String(dx.key_value).trim();
  const notes = dx.notes;
  if (!notes) return null;
  const m = String(notes).match(/^healthray:[\w-]+\s*[—–-]+\s*(.+)$/i);
  return m ? m[1].trim() : null;
}
