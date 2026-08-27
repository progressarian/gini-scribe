// Why a patient was blocked. A reason code is mandatory on every block so the
// record is never free text alone — see docs/PATIENT_BLOCKLIST_PLAN.md §3.2.
export const BLOCK_REASONS = [
  { value: "abusive_behaviour", label: "Abusive / threatening behaviour" },
  { value: "repeated_no_show", label: "Repeated no-shows" },
  { value: "payment_dispute", label: "Payment dispute" },
  { value: "fraud_or_misuse", label: "Fraud or misuse of services" },
  { value: "patient_request", label: "Patient asked to stop contact" },
  { value: "other", label: "Other (note required)" },
];

export const BLOCK_REASON_VALUES = BLOCK_REASONS.map((r) => r.value);

// The one code that cannot stand on its own — it says nothing without the note.
export const NOTE_REQUIRED_REASON = "other";

export const blockReasonMeta = (v) => BLOCK_REASONS.find((r) => r.value === v) || null;
export const blockReasonLabel = (v) => blockReasonMeta(v)?.label || v || "";

export const isValidBlockReason = (v) => BLOCK_REASON_VALUES.includes(v);

// Actions recorded in patient_block_log.
export const BLOCK_ACTIONS = {
  BLOCK: "block",
  UNBLOCK: "unblock",
  OVERRIDE_BOOKING: "override_booking",
  OVERRIDE_WRITE: "override_write",
  SYNCED_WHILE_BLOCKED: "synced_while_blocked",
};
