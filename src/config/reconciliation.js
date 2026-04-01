// Medicine reconciliation reason presets
export const RECON_REASONS = {
  stop: [
    "Duplication with Gini prescription",
    "Drug interaction",
    "Not clinically indicated",
    "Side effects reported",
    "Patient preference",
    "Not effective",
    "Replaced by better alternative",
    "Contraindicated",
    "Completed course",
  ],
  hold: [
    "Pending lab results",
    "Fasting / pre-procedure",
    "Temporary side effect",
    "Dose adjustment needed",
    "Drug interaction — temporary",
    "Patient preference",
    "Reassess at next visit",
  ],
};

// Rx feedback disagreement tags
export const DISAGREEMENT_TAGS = [
  "Different protocol for Indian patients",
  "Cost/affordability consideration",
  "Patient-specific factor AI missed",
  "Drug combination preference",
  "Dosage adjustment preference",
  "Outdated guideline reference",
  "AI overly cautious",
  "AI missed contraindication",
  "Other",
];
