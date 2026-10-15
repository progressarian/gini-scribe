export const OPD_BUCKETS = {
  new: "New",
  follow_up: "Follow-up",
  other: "Other OPD",
  tele: "Tele",
  lab_only: "Lab-only",
};

export const OPD_TYPE_SETS = {
  opd: ["new", "follow_up", "other"],
  new: ["new"],
  follow_up: ["follow_up"],
  other: ["other"],
  tele: ["tele"],
  lab_only: ["lab_only"],
  all: ["new", "follow_up", "other", "tele", "lab_only"],
};

export const typeIncludes = (type, bucket) =>
  (OPD_TYPE_SETS[type] || OPD_TYPE_SETS.opd).includes(bucket);

export const OPD_TYPE_OPTIONS = [
  { value: "opd", label: "Doctor OPD (New + Follow-up + Other)" },
  { value: "new", label: "New patients" },
  { value: "follow_up", label: "Follow-ups" },
  { value: "other", label: "Other OPD" },
  { value: "tele", label: "Tele" },
  { value: "lab_only", label: "Lab-only" },
  { value: "all", label: "All appointments" },
];

export const OPD_STATES = {
  attended: "Completed",
  not_closed: "Not closed in HealthRay",
  no_show: "No-show",
  cancelled: "Cancelled",
  not_updated: "Not updated",
  booked: "Booked",
};

export const OPD_STATUS_OPTIONS = [
  { value: "came", label: "Came (completed + not closed)" },
  { value: "repeat", label: "Patients who came more than once" },
  { value: "not_closed", label: "Not closed in HealthRay" },
  { value: "no_show", label: "No-show" },
  { value: "cancelled", label: "Cancelled" },
  { value: "not_updated", label: "Not updated" },
  { value: "booked", label: "Booked ahead" },
  { value: "all", label: "Any status" },
];

export const OPD_SORTS = [
  "date_desc",
  "date_asc",
  "patient_asc",
  "patient_desc",
  "doctor_asc",
  "doctor_desc",
];

export const OPD_PAGE_SIZES = [10, 25, 50, 100];

export const opdSummaryFileName = (month) => `OPD-summary-${month}.xlsx`;
