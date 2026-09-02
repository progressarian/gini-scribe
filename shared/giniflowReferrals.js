// The referral vocabulary — specialties, urgencies and the letter's own statuses.
//
// docs/gini-flow/19-REFERRALS-STATION-PLAN.md §5. Two prototypes disagree on the
// specialty list: `gini-doctor-v3`'s Care-plan chips name Dietitian, Bariatric
// consult and Podiatry; `gini-stations`' create form names Gastroenterology,
// Neurology, Orthopaedics, Dermatology, Bariatric Surgery and Endocrinology.
// Neither can be hard-coded on one screen, so the union lives here and both read
// it — the card's emoji, the consultant's chip and the printed letter then
// cannot disagree about what a specialty is called.
//
// Shape follows shared/patientCategories.js; the icon-with-value pairing follows
// CATEGORY_META in shared/giniflowStatus.js.
export const SPECIALTIES = [
  { value: "cardiology", label: "Cardiology", icon: "❤️" },
  { value: "nephrology", label: "Nephrology", icon: "🫘" },
  { value: "ophthalmology", label: "Ophthalmology", icon: "👁" },
  { value: "gastroenterology", label: "Gastroenterology", icon: "🍽" },
  { value: "neurology", label: "Neurology", icon: "🧠" },
  { value: "orthopaedics", label: "Orthopaedics", icon: "🦴" },
  { value: "dermatology", label: "Dermatology", icon: "🧴" },
  { value: "endocrinology", label: "Endocrinology", icon: "🧬" },
  { value: "bariatric_surgery", label: "Bariatric Surgery", icon: "🔪" },
  { value: "bariatric_consult", label: "Bariatric consult", icon: "⚖️" },
  { value: "dietitian", label: "Dietitian", icon: "🥗" },
  { value: "podiatry", label: "Podiatry", icon: "🦶" },
  { value: "other", label: "Other", icon: "↗" },
];

// The six the consultant's Care plan offers as one-tap chips. The rest are
// reachable from the station's create form — a chip row long enough to wrap
// three times is not a decision aid.
export const CHIP_SPECIALTIES = [
  "cardiology",
  "ophthalmology",
  "nephrology",
  "dietitian",
  "bariatric_consult",
  "podiatry",
];

export const SPECIALTY_VALUES = SPECIALTIES.map((s) => s.value);

export const specialtyMeta = (v) => SPECIALTIES.find((s) => s.value === v) || null;
export const specialtyLabel = (v) => specialtyMeta(v)?.label || v || "";
export const specialtyIcon = (v) => specialtyMeta(v)?.icon || "↗";
export const isValidSpecialty = (v) => SPECIALTY_VALUES.includes(v);

// The prototype's own wording, kept verbatim: "within 48 hrs" is the instruction
// the desk acts on, and "Urgent" alone is not.
export const URGENCIES = [
  { value: "routine", label: "Routine (within 2 weeks)", short: "Routine", tone: "ink" },
  { value: "soon", label: "Soon (within 1 week)", short: "Soon", tone: "amb" },
  { value: "urgent", label: "Urgent (within 48 hrs)", short: "Urgent", tone: "red" },
  { value: "emergency", label: "Emergency", short: "Emergency", tone: "red" },
];

export const URGENCY_VALUES = URGENCIES.map((u) => u.value);

export const urgencyMeta = (v) => URGENCIES.find((u) => u.value === v) || URGENCIES[0];

// Ordering the station's list. A referral has no SLA — a specialist appointment
// three weeks out is not a bottleneck a coordinator can clear — so urgency and
// age are the whole sort (§2).
export const URGENCY_RANK = { emergency: 0, urgent: 1, soon: 2, routine: 3 };

// The letter's journey, not the patient's: `appointment_booked` means somebody
// else's clinic gave a slot. Gini books nothing.
export const REFERRAL_STATUSES = [
  { value: "created", label: "Created", tone: "ink" },
  { value: "letter_generated", label: "Letter generated", tone: "grn" },
  { value: "appointment_booked", label: "Appointment pending", tone: "amb" },
  { value: "completed", label: "Completed", tone: "grn" },
];

export const REFERRAL_STATUS_VALUES = REFERRAL_STATUSES.map((s) => s.value);

export const referralStatusMeta = (v) =>
  REFERRAL_STATUSES.find((s) => s.value === v) || REFERRAL_STATUSES[0];
