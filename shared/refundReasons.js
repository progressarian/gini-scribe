export const REFUND_REASONS = [
  { value: "long_wait", label: "Long waiting time" },
  { value: "doctor_cancelled", label: "Doctor cancelled the test" },
  { value: "station_unavailable", label: "Machine / station not available" },
  { value: "patient_declined", label: "Patient declined" },
  { value: "billed_by_mistake", label: "Billed by mistake / duplicate" },
  { value: "other", label: "Other — write your own reason" },
];

export const REFUND_REASON_VALUES = REFUND_REASONS.map((r) => r.value);

export const NOTE_REQUIRED_REFUND_REASON = "other";

export const refundReasonLabel = (value) =>
  REFUND_REASONS.find((r) => r.value === value)?.label || value || "";

export function refundReasonText(value, note) {
  const said = typeof note === "string" ? note.trim() : "";
  if (value === NOTE_REQUIRED_REFUND_REASON) return said;
  const label = refundReasonLabel(value);
  return said ? `${label} — ${said}` : label;
}
