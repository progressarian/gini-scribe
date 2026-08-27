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
  patientBlocks: {
    all: ["patient-blocks"],
    status: (patientIds) => ["patient-blocks", "status", patientIds],
    list: (params) => ["patient-blocks", "list", params || null],
    history: (patientId) => ["patient-blocks", "history", String(patientId)],
  },
  flow: {
    all: ["flow"],
    visits: (date, status) => ["flow", "visits", date, status || null],
    visit: (id) => ["flow", "visit", String(id)],
    activeVisit: (patientDbId, fileNo) => [
      "flow",
      "active-visit",
      patientDbId || null,
      fileNo || null,
    ],
    queue: (role, date) => ["flow", "queue", role, date],
    visitTypes: () => ["flow", "visit-types"],
    stepCatalog: () => ["flow", "step-catalog"],
    template: (visitType) => ["flow", "template", visitType],
    staff: (role) => ["flow", "staff", role || null],
    reports: (start, end) => ["flow", "reports", start, end],
    appointments: (date, q, doctor) => ["flow", "appointments", date, q || null, doctor || null],
  },
  home: {
    all: ["home"],
    stats: (date) => ["home", "stats", date],
  },
  ghm: {
    all: ["ghm"],
    doctors: () => ["ghm", "doctors"],
    ccAgents: () => ["ghm", "cc-agents"],
    list: (params) => ["ghm", "list", params],
    biomarkers: (patientIds) => ["ghm", "biomarkers", patientIds],
    lastMo: (patientIds) => ["ghm", "last-mo", patientIds],
    slotCounts: (dates) => ["ghm", "slot-counts", dates],
    categoryCounts: (date) => ["ghm", "category-counts", date || null],
    attemptCounts: (appointmentIds) => ["ghm", "attempt-counts", appointmentIds],
    activeCalls: (appointmentIds) => ["ghm", "active-calls", appointmentIds],
    callAttempts: (appointmentId) => ["ghm", "call-attempts", String(appointmentId)],
    changes: (appointmentId) => ["ghm", "changes", String(appointmentId)],
    availability: (doctor, date) => ["ghm", "availability", doctor || null, date || null],
    conflicts: (date) => ["ghm", "conflicts", date],
    patientByFileNo: (fileNo) => ["ghm", "patient-by-file-no", fileNo || null],
    patientByPhone: (phone) => ["ghm", "patient-by-phone", phone || null],
  },
  analytics: {
    all: ["analytics"],
    meta: () => ["analytics", "meta"],
    section: (id, cohort = null) => ["analytics", "section", String(id), cohort || "all"],
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
