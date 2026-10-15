export const TEST_CANCEL_REASONS = [
  { value: "refunded", label: "Refunded" },
  { value: "patient_declined", label: "Patient declined" },
  { value: "doctor_cancelled", label: "Doctor cancelled it" },
  { value: "station_unavailable", label: "Machine / station not available" },
  { value: "billed_by_mistake", label: "Billed / added by mistake" },
  { value: "duplicate", label: "Duplicate" },
  { value: "other", label: "Other — write your own reason" },
];

export const SYNC_CANCEL_REASONS = [
  { value: "refunded_in_healthray", label: "Refunded in HealthRay" },
  { value: "cancelled_in_healthray", label: "Cancelled in HealthRay" },
  { value: "removed_from_bill", label: "Removed from the HealthRay bill" },
  { value: "not_on_bill", label: "Not on the HealthRay bill" },
];

export const NOT_ON_BILL_REASON = "not_on_bill";

export const TEST_CANCEL_REASON_VALUES = TEST_CANCEL_REASONS.map((r) => r.value);

export const NOTE_REQUIRED_CANCEL_REASON = "other";

export const REFUND_REASON = "refunded";

export const REFUND_REASON_FOR_CANCEL = {
  doctor_cancelled: "doctor_cancelled",
  station_unavailable: "station_unavailable",
  patient_declined: "patient_declined",
  billed_by_mistake: "billed_by_mistake",
  duplicate: "billed_by_mistake",
  refunded: "other",
  other: "other",
};

export const CANCEL_LABEL_KEPT_IN_REFUND_NOTE = ["duplicate", "refunded"];

export const CANCELLABLE_ORDER_STATUSES = ["ordered", "payment_pending", "paid"];

export const testCancelReasonLabel = (v) =>
  v === "urgent_after_collection"
    ? "Urgent cancellation after collection"
    : [...TEST_CANCEL_REASONS, ...SYNC_CANCEL_REASONS].find((r) => r.value === v)?.label || v || "";

export const URGENT_CANCEL_REASONS = [
  { value: "patient_left", label: "Patient left (emergency)" },
  { value: "doctor_withdrew", label: "Doctor withdrew the test" },
  { value: "wrong_test", label: "Wrong test ordered" },
  { value: "duplicate", label: "Duplicate test" },
  { value: "sample_unusable", label: "Sample unusable — will not repeat" },
  { value: "other", label: "Other — write your own reason" },
];

export const URGENT_CANCEL_REASON_VALUES = URGENT_CANCEL_REASONS.map((r) => r.value);

export const URGENT_AFTER_COLLECTION = "urgent_after_collection";

export const urgentCancelReasonLabel = (v) =>
  URGENT_CANCEL_REASONS.find((r) => r.value === v)?.label || v || "";
