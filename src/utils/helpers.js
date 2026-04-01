/** Shared utility functions */

export const toggleChip = (arr, setFn, val) => {
  setFn(arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val]);
};

export const fmtDate = (d) => {
  try {
    const s = String(d);
    const dt = s.length === 10 ? new Date(s + "T12:00:00") : new Date(s);
    return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
  } catch (err) {
    return "";
  }
};

/**
 * Compute new lab reports since last visit from patientFullData.
 */
export const getNewReportsSinceLastVisit = (patientFullData) => {
  if (!patientFullData?.lab_results?.length || !patientFullData?.consultations?.length) return [];
  const sortedCons = [...patientFullData.consultations].sort((a, b) => {
    const d = new Date(b.visit_date) - new Date(a.visit_date);
    return d !== 0 ? d : new Date(b.created_at) - new Date(a.created_at);
  });
  const lastVisit = sortedCons[0];
  const lastVisitDate = lastVisit?.visit_date ? String(lastVisit.visit_date).slice(0, 10) : null;
  if (!lastVisitDate) return [];
  return patientFullData.lab_results.filter((l) => {
    if (!l.test_date) return false;
    const labDate = String(l.test_date).slice(0, 10);
    return labDate > lastVisitDate;
  });
};
