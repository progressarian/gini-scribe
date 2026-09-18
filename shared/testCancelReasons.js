export const TEST_CANCEL_REASONS = [
  { value: "refunded", label: "Refunded" },
  { value: "patient_declined", label: "Patient declined" },
  { value: "doctor_cancelled", label: "Doctor cancelled it" },
  { value: "billed_by_mistake", label: "Billed / added by mistake" },
  { value: "duplicate", label: "Duplicate" },
  { value: "other", label: "Other (note required)" },
];

export const SYNC_CANCEL_REASONS = [
  { value: "refunded_in_healthray", label: "Refunded in HealthRay" },
  { value: "cancelled_in_healthray", label: "Cancelled in HealthRay" },
  { value: "removed_from_bill", label: "Removed from the HealthRay bill" },
];

export const TEST_CANCEL_REASON_VALUES = TEST_CANCEL_REASONS.map((r) => r.value);

export const NOTE_REQUIRED_CANCEL_REASON = "other";

export const REFUND_REASON = "refunded";

export const CANCELLABLE_ORDER_STATUSES = ["ordered", "payment_pending", "paid"];

export const testCancelReasonLabel = (v) =>
  [...TEST_CANCEL_REASONS, ...SYNC_CANCEL_REASONS].find((r) => r.value === v)?.label || v || "";
