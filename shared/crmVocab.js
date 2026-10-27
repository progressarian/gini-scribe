// The Doctor Growth CRM vocabularies — priority bands, relationship stages,
// visit and referral kinds, the patient journey, and the growth team's roles.
//
// docs/CRM_PLAN.md. These began life as 16 Postgres enums, which is not the
// house rule: shared/giniflowReferrals.js states it — TEXT columns with a
// trailing comment plus a shared vocabulary here, so a vocabulary can grow
// without a migration. A CRM whose stage list cannot change without DDL is
// exactly the CRM nobody updates. Converted while the tables were still empty.
//
// Every list here is mirrored by a CHECK constraint in
// server/migrations/2026-09-16_crm_phase1.sql. Adding a value means editing
// both — the CHECK is the integrity floor, this file is what the UI renders.
//
// Shape follows shared/giniflowReferrals.js: {value, label} with optional
// `short`, `icon` and `tone` where a screen needs them.

// ---- Growth team roles -------------------------------------------------
// Distinct from shared/permissions.js ROLES, which gate Scribe routes and
// pages. These gate CRM *rows* through RLS, and the database reads them from
// crm.users. A person has both: a Scribe role to reach the page, a CRM role
// to decide which doctors come back.
export const CRM_ROLES = [
  { value: "ceo_admin", label: "CEO / Admin", short: "Admin" },
  { value: "head_of_growth", label: "Head of Growth", short: "Head" },
  { value: "growth_manager", label: "Growth Manager", short: "Manager" },
  { value: "growth_executive", label: "Growth Executive", short: "Executive" },
  { value: "clinical_team", label: "Clinical Team", short: "Clinical" },
  { value: "operations", label: "Operations", short: "Ops" },
];
export const CRM_ROLE_VALUES = CRM_ROLES.map((r) => r.value);

// ---- Doctor segmentation ----------------------------------------------
export const DOCTOR_PRIORITIES = [
  { value: "A", label: "A — High value", short: "A", tone: "red" },
  { value: "B", label: "B — Meaningful potential", short: "B", tone: "amb" },
  { value: "C", label: "C — Lower frequency", short: "C", tone: "ink" },
  { value: "unclassified", label: "Unclassified", short: "—", tone: "ink" },
];
export const DOCTOR_PRIORITY_VALUES = DOCTOR_PRIORITIES.map((p) => p.value);

// The relationship ladder, in order. Dormant and Lost are off-ladder states a
// doctor can fall into from anywhere, so they sort last rather than eighth.
export const RELATIONSHIP_STAGES = [
  { value: "prospect", label: "Prospect", rank: 0 },
  { value: "contacted", label: "Contacted", rank: 1 },
  { value: "met", label: "Met", rank: 2 },
  { value: "engaged", label: "Engaged", rank: 3 },
  { value: "trial_referrer", label: "Trial Referrer", rank: 4 },
  { value: "active_referrer", label: "Active Referrer", rank: 5 },
  { value: "high_value_referrer", label: "High-Value Referrer", rank: 6 },
  { value: "dormant", label: "Dormant", rank: 90 },
  { value: "lost", label: "Lost", rank: 99 },
];
export const RELATIONSHIP_STAGE_VALUES = RELATIONSHIP_STAGES.map((s) => s.value);
export const stageRank = (v) =>
  RELATIONSHIP_STAGES.find((s) => s.value === v)?.rank ?? RELATIONSHIP_STAGES.length;

// ---- Visits ------------------------------------------------------------
export const VISIT_TYPES = [
  { value: "in_person", label: "In person", icon: "🚶" },
  { value: "phone", label: "Phone call", icon: "📞" },
  { value: "whatsapp", label: "WhatsApp", icon: "💬" },
  { value: "video", label: "Video call", icon: "📹" },
  { value: "event", label: "At an event", icon: "🎪" },
  { value: "other", label: "Other", icon: "•" },
];
export const VISIT_TYPE_VALUES = VISIT_TYPES.map((v) => v.value);

export const VISIT_OUTCOMES = [
  { value: "positive", label: "Positive", tone: "grn" },
  { value: "neutral", label: "Neutral", tone: "ink" },
  { value: "negative", label: "Negative", tone: "red" },
  { value: "doctor_unavailable", label: "Doctor unavailable", tone: "amb" },
  { value: "rescheduled", label: "Rescheduled", tone: "amb" },
];
export const VISIT_OUTCOME_VALUES = VISIT_OUTCOMES.map((v) => v.value);

export const VISIT_SOURCES = [
  { value: "app", label: "Logged in the app" },
  { value: "sheet", label: "From sheet" },
];
export const VISIT_SOURCE_VALUES = VISIT_SOURCES.map((v) => v.value);

export const VISIT_SHEET_STATUSES = [
  { value: "completed", label: "Completed" },
  { value: "doctor_unavailable", label: "Doctor unavailable" },
  { value: "not_visited", label: "Not visited" },
];
export const VISIT_SHEET_STATUS_VALUES = VISIT_SHEET_STATUSES.map((v) => v.value);

export const VISIT_FORM_STATUSES = VISIT_SHEET_STATUSES.filter((s) => s.value !== "not_visited");
export const VISIT_FORM_STATUS_VALUES = VISIT_FORM_STATUSES.map((v) => v.value);

export const DOCTOR_SPECIALTIES = [
  { value: "General Physician", aliases: ["mbbs", "gp", "general physician"] },
  { value: "Physician", aliases: ["md phy", "md physician", "md medicine", "physician"] },
  { value: "Gynaecology", aliases: ["md gynae", "gynae", "gynaecologist", "obgyn", "ms gynae"] },
  { value: "General Surgery", aliases: ["ms surg", "ms surgery", "surgeon", "general surgeon"] },
  { value: "Pediatrics", aliases: ["pedia", "pediatrician", "paediatrics", "md pedia"] },
  { value: "Orthopedics", aliases: ["ortho", "orthopaedics", "ms ortho"] },
  { value: "Cardiology", aliases: ["cardio", "cardiologist", "dm cardio"] },
  { value: "Endocrinology / Diabetes", aliases: ["endo", "diabetologist", "endocrinologist"] },
  { value: "Nephrology", aliases: ["nephro", "nephrologist"] },
  { value: "Ayurveda (BAMS)", aliases: ["bams", "ayurveda"] },
  { value: "Homeopathy (BHMS)", aliases: ["bhms", "homeopathy"] },
  { value: "RMP", aliases: ["rmp"] },
  { value: "Physiotherapy", aliases: ["mpt", "bpt", "physio", "physiotherapist"] },
  { value: "Dentist", aliases: ["bds", "mds", "dental"] },
];
export const DOCTOR_SPECIALTY_VALUES = DOCTOR_SPECIALTIES.map((s) => s.value);

export function specialtyFromList(raw) {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9/() ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return (
    DOCTOR_SPECIALTIES.find((s) => s.value.toLowerCase() === text || s.aliases.includes(text))
      ?.value ?? null
  );
}

export const DOCTOR_REMOVAL_REASONS = [
  { value: "duplicate", label: "Duplicate of another doctor" },
  { value: "left", label: "Retired or moved away" },
  { value: "not_a_doctor", label: "Not a doctor (chemist, list error)" },
  { value: "not_interested", label: "Not interested in working with us" },
  { value: "other", label: "Other" },
];
export const DOCTOR_REMOVAL_REASON_VALUES = DOCTOR_REMOVAL_REASONS.map((r) => r.value);

export const REMOVAL_STATUSES = [
  { value: "pending", label: "Waiting for admin", tone: "amb" },
  { value: "approved", label: "Removed", tone: "red" },
  { value: "rejected", label: "Rejected", tone: "ink" },
  { value: "cancelled", label: "Cancelled", tone: "ink" },
];
export const REMOVAL_STATUS_VALUES = REMOVAL_STATUSES.map((s) => s.value);

export const VISIT_ROW_STATES = [
  { value: "ready", label: "Ready", tone: "ok" },
  { value: "already_logged", label: "Already logged", tone: "dup" },
  { value: "failed", label: "Failed", tone: "err" },
  { value: "not_visited", label: "Not visited", tone: "dup" },
  { value: "not_filled", label: "Not filled", tone: "dup" },
  { value: "imported", label: "Imported", tone: "ok" },
  { value: "undone", label: "Undone", tone: "dup" },
];
export const VISIT_ROW_STATE_VALUES = VISIT_ROW_STATES.map((v) => v.value);

// Derived by crm.v_doctor_visit_due from the cadence policy, not stored.
export const VISIT_DUE_STATES = [
  { value: "ok", label: "On track", tone: "grn" },
  { value: "upcoming", label: "Due soon", tone: "ink" },
  { value: "due", label: "Due", tone: "amb" },
  { value: "overdue", label: "Overdue", tone: "red" },
  { value: "never_visited", label: "Never visited", tone: "red" },
];
export const VISIT_DUE_STATE_VALUES = VISIT_DUE_STATES.map((v) => v.value);

// ---- Inbound referrals -------------------------------------------------
// Where we learned of the referral. Not to be confused with
// shared/giniflowReferrals.js, which is the opposite direction: a Gini doctor
// referring a patient OUT to an external specialist.
export const REFERRAL_SOURCES = [
  { value: "direct_doctor", label: "Direct from doctor" },
  { value: "phone", label: "Phone" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "gini_scribe", label: "Gini Scribe" },
  { value: "opd", label: "OPD" },
  { value: "emergency", label: "Emergency" },
  { value: "ipd", label: "IPD" },
  { value: "website", label: "Website" },
  { value: "patient_self_report", label: "Patient told us" },
  { value: "growth_executive", label: "Growth executive" },
  { value: "other", label: "Other" },
];
export const REFERRAL_SOURCE_VALUES = REFERRAL_SOURCES.map((s) => s.value);

// What the patient said at registration. `none_self` is a real answer — a
// walk-in who nobody referred — and is why an ABSENT row means something
// different: nobody was asked. Absent rows are the attribution-unknown queue.
export const REFERRAL_ANSWER_TYPES = [
  { value: "doctor", label: "A doctor referred me" },
  { value: "free_text", label: "Someone else" },
  { value: "none_self", label: "Came on my own" },
];
export const REFERRAL_ANSWER_TYPE_VALUES = REFERRAL_ANSWER_TYPES.map((a) => a.value);

// Claimed is a rep's word for it; verified is confirmed at registration or by
// journey match. Dashboards must never add the two together.
export const ATTRIBUTION_STATUSES = [
  { value: "claimed", label: "Claimed", short: "Claimed", tone: "amb" },
  { value: "verified", label: "Verified", short: "Verified", tone: "grn" },
  { value: "disputed", label: "Disputed", short: "Disputed", tone: "red" },
  { value: "rejected", label: "Rejected", short: "Rejected", tone: "ink" },
];
export const ATTRIBUTION_STATUS_VALUES = ATTRIBUTION_STATUSES.map((a) => a.value);

export const URGENCIES = [
  { value: "routine", label: "Routine" },
  { value: "soon", label: "Soon" },
  { value: "urgent", label: "Urgent" },
  { value: "emergency", label: "Emergency" },
];
export const URGENCY_VALUES = URGENCIES.map((u) => u.value);
export const URGENCY_RANK = { emergency: 0, urgent: 1, soon: 2, routine: 3 };

// ---- The referred patient's journey ------------------------------------
// In funnel order. `lost` requires a reason — enforced by a CHECK on both
// crm.doctor_referrals and crm.referral_journey_events, not by this file.
export const REFERRAL_STATUSES = [
  { value: "new", label: "New", rank: 0 },
  { value: "contact_attempted", label: "Contact attempted", rank: 1 },
  { value: "contacted", label: "Contacted", rank: 2 },
  { value: "appointment_booked", label: "Appointment booked", rank: 3 },
  { value: "no_show", label: "No-show", rank: 4 },
  { value: "consulted", label: "Consulted", rank: 5 },
  { value: "investigation", label: "Investigation", rank: 6 },
  { value: "admission_advised", label: "Admission advised", rank: 7 },
  { value: "admitted", label: "Admitted", rank: 8 },
  { value: "procedure_completed", label: "Procedure completed", rank: 9 },
  { value: "discharged", label: "Discharged", rank: 10 },
  { value: "follow_up", label: "Follow-up", rank: 11 },
  { value: "closed", label: "Closed", rank: 12 },
  { value: "lost", label: "Lost", rank: 99 },
];
export const REFERRAL_STATUS_VALUES = REFERRAL_STATUSES.map((s) => s.value);

// The statuses that count as a converted referral on the Doctor 360 and in
// crm.v_doctor_kpis. Kept here so the view and the UI cannot disagree.
export const CONVERTED_STATUSES = [
  "consulted",
  "admitted",
  "procedure_completed",
  "discharged",
  "follow_up",
  "closed",
];
export const ADMITTED_STATUSES = ["admitted", "procedure_completed", "discharged"];

// ---- Tasks, consent, revenue, import -----------------------------------
export const TASK_STATUSES = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];
export const TASK_STATUS_VALUES = TASK_STATUSES.map((t) => t.value);

export const TASK_KINDS = [
  { value: "follow_up_visit", label: "Follow-up visit" },
  { value: "promise", label: "Promise" },
  { value: "manual", label: "Task" },
];
export const TASK_KIND_VALUES = TASK_KINDS.map((k) => k.value);

export const TASK_PRIORITIES = [
  { value: "low", label: "Low", tone: "ink" },
  { value: "normal", label: "Normal", tone: "ink" },
  { value: "high", label: "High", tone: "amb" },
  { value: "critical", label: "Critical", tone: "red" },
];
export const TASK_PRIORITY_VALUES = TASK_PRIORITIES.map((t) => t.value);
export const TASK_PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };

// DPDP Act 2023: sending a discharge summary to a referring doctor is sharing
// health data with a third party, so every clinical communication is gated on
// a granted consent.
export const CONSENT_STATUSES = [
  { value: "granted", label: "Granted", tone: "grn" },
  { value: "denied", label: "Denied", tone: "red" },
  { value: "revoked", label: "Revoked", tone: "red" },
];
export const CONSENT_STATUS_VALUES = CONSENT_STATUSES.map((c) => c.value);

// Phase 1 revenue is ops-entered and must be labelled as such wherever it is
// shown. Phase 2 adds the scribe_billing writer.
export const REVENUE_SOURCES = [
  { value: "manual_ops", label: "Entered by ops", short: "Manual" },
  { value: "scribe_billing", label: "From Scribe billing", short: "Billing" },
];
export const REVENUE_SOURCE_VALUES = REVENUE_SOURCES.map((r) => r.value);

export const IMPORT_ROW_STATUSES = [
  { value: "pending", label: "Pending", tone: "ink" },
  { value: "created", label: "Created", tone: "grn" },
  { value: "updated", label: "Updated", tone: "grn" },
  { value: "skipped_duplicate", label: "Skipped — duplicate", tone: "amb" },
  { value: "error", label: "Error", tone: "red" },
];
export const IMPORT_ROW_STATUS_VALUES = IMPORT_ROW_STATUSES.map((i) => i.value);

// ---- Lookup helpers ----------------------------------------------------
const metaFinder = (list) => (v) => list.find((x) => x.value === v) || null;
const labeller = (list) => (v) => metaFinder(list)(v)?.label || v || "";

export const crmRoleLabel = labeller(CRM_ROLES);
export const doctorPriorityMeta = metaFinder(DOCTOR_PRIORITIES);
export const relationshipStageLabel = labeller(RELATIONSHIP_STAGES);
export const visitTypeMeta = metaFinder(VISIT_TYPES);
export const visitOutcomeMeta = metaFinder(VISIT_OUTCOMES);
export const visitDueStateMeta = metaFinder(VISIT_DUE_STATES);
export const referralSourceLabel = labeller(REFERRAL_SOURCES);
export const referralAnswerTypeLabel = labeller(REFERRAL_ANSWER_TYPES);
export const attributionStatusMeta = metaFinder(ATTRIBUTION_STATUSES);
export const referralStatusLabel = labeller(REFERRAL_STATUSES);
export const taskPriorityMeta = metaFinder(TASK_PRIORITIES);
export const revenueSourceMeta = metaFinder(REVENUE_SOURCES);
export const importRowStatusMeta = metaFinder(IMPORT_ROW_STATUSES);
export const urgencyLabel = labeller(URGENCIES);
export const removalReasonLabel = labeller(DOCTOR_REMOVAL_REASONS);
export const removalStatusMeta = metaFinder(REMOVAL_STATUSES);
export const taskKindLabel = labeller(TASK_KINDS);
