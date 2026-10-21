export const HOLD_DECISIONS = [
  { value: "booked_ghm", label: "Booked at GHM" },
  { value: "booked_outside", label: "Booked outside" },
  { value: "declined", label: "Patient declined" },
  { value: "not_available", label: "Not available" },
  { value: "call_later", label: "Will call later" },
];

export const HOLD_DECISION_LABEL = Object.fromEntries(
  HOLD_DECISIONS.map((d) => [d.value, d.label]),
);

export const NOTE_REQUIRED_DECISIONS = ["declined", "call_later"];

export const HOLD_SOURCE_LABEL = {
  gf_referral: "Floor referral",
  rx_referral: "Consultation referral",
  hr_note_referral: "Referral in HealthRay note",
  echo_referral: "Echo referral",
};

export const HOLD_NOTE_MIN = 3;
export const HOLD_NOTE_MAX = 500;

export const AWAITING_COORDINATOR = "awaiting_coordinator";
