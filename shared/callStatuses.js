// The one vocabulary for "where is this patient's confirmation call at".
// The GHM sheet dropdown, the call-attempt log and the OBT dashboard tiles all
// read from here — they used to keep three private copies, so a status added
// for the callers was invisible to the tiles counting their work.
//
//   open        — the row still needs a call today
//   unreachable — the line was tried but nobody could be spoken to
export const CALL_STATUSES = [
  { value: "pending", label: "Not Called Yet", color: "gray", open: true, attempt: false },
  { value: "called", label: "Called / Spoke", color: "green" },
  { value: "not_picked", label: "Not Picked Up", color: "red", open: true },
  { value: "busy", label: "Busy", color: "amber", open: true, unreachable: true },
  { value: "switched_off", label: "Switched Off", color: "amber", open: true, unreachable: true },
  { value: "not_reachable", label: "Not Reachable", color: "amber", open: true, unreachable: true },
  { value: "wrong_number", label: "Wrong Number", color: "red", unreachable: true },
  { value: "call_later", label: "Will Call Later", color: "amber", open: true },
  { value: "rescheduled", label: "Rescheduled", color: "blue" },
  { value: "cancelled", label: "Cancelled Visit", color: "red" },
  { value: "no_call_needed", label: "No Call Needed", color: "gray", attempt: false },
];

// Outcomes a logged call attempt can carry: every status except the two that
// describe a call nobody has made.
export const ATTEMPT_OUTCOMES = CALL_STATUSES.filter((s) => s.attempt !== false);

// The other side of that line: statuses that describe a call nobody made, so
// there is no caller and no call date to record against them.
export const NO_ATTEMPT_STATUSES = CALL_STATUSES.filter((s) => s.attempt === false).map(
  (s) => s.value,
);

const valuesWhere = (flag) => CALL_STATUSES.filter((s) => s[flag]).map((s) => s.value);

export const OPEN_CALL_STATUSES = valuesWhere("open");
export const UNREACHABLE_STATUSES = valuesWhere("unreachable");

export const callLabel = (v) => CALL_STATUSES.find((s) => s.value === v)?.label || v || "";
export const callColor = (v) => CALL_STATUSES.find((s) => s.value === v)?.color || "gray";

// Postgres text[] literal for one of the sets above.
export const pgArray = (values) => `'{${values.join(",")}}'::text[]`;
