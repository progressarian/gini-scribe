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
    appointmentsRange: (start, end) => ["opd", "appointments-range", start, end],
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
    appointments: (date) => ["companion", "appointments", date],
  },
  patient: {
    all: ["patient"],
    full: (id) => ["patient", "full", String(id)],
  },
  messages: {
    all: ["messages"],
    thread: (patientId, role = null, doctor = null) => [
      "messages",
      "thread",
      String(patientId),
      role || null,
      doctor || null,
    ],
    // Conversation-centric keys (2026-04-23 rebuild)
    conversations: (kind) => ["conversations", String(kind || "doctor")],
    conversation: (conversationId) => ["conversation", String(conversationId)],
    conversationMessages: (conversationId) => ["conversation", String(conversationId), "messages"],
  },
};
