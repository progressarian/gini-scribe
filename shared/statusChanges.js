export const STATUS_CHANGE_KINDS = [
  { value: "booked", label: "Booked", color: "green" },
  { value: "cancelled", label: "Cancelled", color: "red" },
  { value: "rescheduled", label: "Rescheduled", color: "blue" },
  { value: "not_connected", label: "Not Connected", color: "amber" },
];

export const changeKindLabel = (v) => STATUS_CHANGE_KINDS.find((k) => k.value === v)?.label || "";
