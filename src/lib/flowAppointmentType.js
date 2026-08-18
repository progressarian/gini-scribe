// Map a GHM/OPD appointment row onto the flow check-in's four patient types.
// Shared so the picker's chip and the type the form selects can never disagree.
//
// The visit_type values are HealthRay's, not ours. Over the last 60 days:
//   Follow-Up (3774) · OPD (2545) · New Patient (762) · Investigation (382) ·
//   Tele (173). Anything unrecognised falls through to the OPD handling.
//
// ⚠️ `is_walkin` is deliberately NOT consulted. It reads like the walk-in axis
// but doesn't behave like one: HealthRay sets it on 6702 of 7636 bookings
// (88%), 6481 of which have a real OBT-booked time slot. Trusting it put 85% of
// a day's list on a walk-in type — and because FU_WALK budgets 90 min against
// FU_APPT's 120, every one of those follow-ups would have been handed an ETA
// half an hour short, plus the walk-in journey template. Reception's own record
// settles it: across 1304 check-ins in 30 days they chose FU_WALK zero times
// and NEW_WALK twice. A row in `appointments` is a booking, so the classifier
// always returns an appointment type; the two walk-in buttons stay one click
// away for the genuine case.
const RE_FOLLOWUP = /follow|f\/?u|review/i;
const RE_NEW = /^\s*new\b/i;
const RE_INVESTIGATION = /investigat|lab|test/i;
const RE_TELE = /tele|video|phone/i;

// Reception can override every one of these — they only set the initial state.
export function classifyAppointment(a = {}) {
  const vt = a.visit_type || "";

  if (RE_TELE.test(vt)) {
    // A teleconsult isn't a physical arrival. It stays pickable (patients do
    // turn up in person), but the chip warns before reception picks one.
    return {
      typeKey: "fu_appt",
      testsAvailable: true,
      ambiguous: false,
      chip: { label: "TELE", cls: "fb-amb" },
    };
  }
  if (RE_INVESTIGATION.test(vt)) {
    // Tests-only visit by an existing patient (GHM defaults its doctor to
    // "Dr. Hospital Admin"). They come to GIVE samples, so reports are NOT
    // ready — that's the FU_APPT_TESTS benchmark rather than plain FU_APPT.
    return {
      typeKey: "fu_appt",
      testsAvailable: false,
      ambiguous: false,
      chip: { label: "TESTS", cls: "fb-lv" },
    };
  }
  if (RE_FOLLOWUP.test(vt)) {
    return {
      typeKey: "fu_appt",
      testsAvailable: true,
      ambiguous: false,
      chip: { label: "FU", cls: "fb-blu" },
    };
  }
  if (RE_NEW.test(vt)) {
    return {
      typeKey: "new_appt",
      testsAvailable: true,
      ambiguous: false,
      chip: { label: "NEW", cls: "fb-tl" },
    };
  }
  // "OPD" and friends say nothing about new-vs-follow-up — it's the generic
  // type HealthRay and our own flow-created appointments both use. Guess from
  // the booking alone, but flag it so the caller can settle it from the
  // patient's consultation history once that has loaded.
  return {
    typeKey: "fu_appt",
    testsAvailable: true,
    ambiguous: true,
    chip: { label: "OPD", cls: "fb-ink" },
  };
}
