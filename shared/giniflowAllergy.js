// The three allergy states, shared by every screen that shows or asks.
//
// Lifted from `giniflow_referrals` (19-REFERRALS-STATION-PLAN.md), where the
// model was first built and where its reasoning is written down: "not asked" is
// a clinical state, not an absent value. A blank allergy field reads as "none"
// to whoever picks the chart up next, and that is the one misreading this
// system must never cause.
//
// NULL and "not_known" mean the same thing — nobody has checked — reached by
// never opening the question or by answering it honestly.

// Nobody has checked. NULL in the column resolves to this before it leaves the
// server, so no screen has to decide what an absent answer means.
export const ALLERGY_NOT_ASKED = "not_known";

export const ALLERGY_STATES = [ALLERGY_NOT_ASKED, "none_known", "known"];

export const ALLERGY_OPTIONS = [
  { value: "not_known", icon: "⚠", label: "Not asked", sub: "nobody has checked", tone: "amb" },
  { value: "none_known", icon: "✓", label: "None known", sub: "I asked the patient", tone: "grn" },
  { value: "known", icon: "⛔", label: "Known allergy", sub: "name it below", tone: "red" },
];

// More than one allergy is normal, and the column holds one string, so the list
// is comma-separated. Split and join in one place: every screen shows the same
// list, and a note typed before this existed still reads as a single entry.
export const parseAllergyNote = (note) =>
  (note || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

export const formatAllergyNote = (list) => (list || []).join(", ");

// One sentence, used on the patient header, the MO brief and the referral
// letter, so the same patient is never described two ways.
export const allergyLine = ({ allergy_status: status, allergy_note: note } = {}) => {
  if (status === "known") return { tone: "red", text: note || "Known allergy — not named" };
  if (status === "none_known") return { tone: "grn", text: "None known — asked" };
  return { tone: "amb", text: "Not recorded anywhere — ask the patient" };
};

export const allergyKnown = (patient) => patient?.allergy_status === "known";
