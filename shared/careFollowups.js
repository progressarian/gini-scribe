export const FOLLOWUP_STATUSES = [
  { value: "open", label: "Open" },
  { value: "booked", label: "Booked" },
  { value: "done", label: "Done" },
  { value: "not_available", label: "Not available here" },
  { value: "declined", label: "Patient declined" },
  { value: "closed", label: "Closed" },
];

export const FOLLOWUP_STATUS_LABEL = Object.fromEntries(
  FOLLOWUP_STATUSES.map((s) => [s.value, s.label]),
);

export const ACTIVE_STATUSES = ["open", "booked"];

export const FOLLOWUP_KIND_LABEL = {
  consultant: "Consultant",
  specialty: "Department / specialty",
  mo: "Medical officer",
  chief: "Chief",
  other: "Other",
};

export const REFERRAL_KINDS = ["consultant", "specialty", "mo", "chief", "other"];

export const FOLLOWUP_KIND_GROUPS = {
  consultant: ["consultant", "mo", "chief"],
  specialty: ["specialty"],
};

export const AVAILABILITY_LABEL = {
  in_house: "✓ Available",
  outsourced: "↗ Outsourced",
  not_available: "✕ Not at GHM",
  unknown: "? Check",
};

export const SOURCE_LABEL = {
  gf_referral: "Floor referral",
  rx_referral: "Consultation referral",
  hr_note_referral: "Referral in HealthRay note",
};

export const NOT_AVAILABLE_REASONS = [
  "No such specialist at GHM",
  "Test not done at GHM",
  "Outsourced — patient prefers outside",
];

export const CLOSE_OUTCOMES = [
  { value: "not_available", label: "Not available here" },
  { value: "declined", label: "Patient declined" },
  { value: "closed", label: "Done elsewhere / no longer needed" },
];

export const REASON_MIN = 3;
export const REASON_MAX = 300;
export const UNREACHABLE_AFTER = 3;
