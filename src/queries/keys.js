// Centralized query key factory. Every key starts with a stable namespace
// ("opd", "visit", "companion") so mutations can invalidate a whole family
// with a single prefix match: queryClient.invalidateQueries({ queryKey: qk.opd.all }).
//
// Rule: always go through this factory. Ad-hoc string keys at call sites
// lead to typos that silently skip cache invalidation.

export const qk = {
  opd: {
    all: ["opd"],
    appointments: (date) => ["opd", "appointments", date],
  },
  visit: {
    all: ["visit"],
    byPatient: (patientId, appointmentId) => [
      "visit",
      String(patientId),
      appointmentId ? String(appointmentId) : null,
    ],
    labCount: (patientId) => ["visit", String(patientId), "lab-count"],
  },
  companion: {
    all: ["companion"],
    patient: (id) => ["companion", "patient", String(id)],
    patients: (params) => ["companion", "patients", params],
  },
};
