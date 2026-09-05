// The provider HealthRay books a samples-only registration under. It is a real
// row in `doctors` — role 'consultant', which is why the flow sync used to
// resolve it and hand the visit a consultant nobody would ever consult.
//
// Already treated as the lab-only marker in src/lib/flowAppointmentType.js,
// components/opd/TriageViewV3.jsx, components/visit/VisitHistoryPanel.jsx,
// routes/opd.js and routes/ghm-appointments.js. Named here so Gini Flow does
// not become the sixth copy.
export const LAB_ONLY_DOCTOR = "Dr. Hospital Admin";

export const isLabOnlyDoctor = (name) =>
  (name || "").trim().toLowerCase() === LAB_ONLY_DOCTOR.toLowerCase();
