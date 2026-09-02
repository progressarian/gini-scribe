import { CHIP_SPECIALTIES, specialtyMeta, URGENCIES } from "../../../../shared/giniflowReferrals";
import {
  useVisitReferrals,
  useToggleReferralChip,
  useRemoveReferral,
} from "../../../queries/hooks/useGiniflowReferrals";

// The `↗ Referrals` care-block — gini-doctor-v3.html:903-913.
//
// This is where a referral is actually DECIDED, and it is the missing quarter of
// the Care plan: CarePlanSection said "treatment · diet · lifestyle · next
// visit" where the prototype says "treatment · diet · tests · referrals · next
// visit".
//
// Selecting a chip creates a `giniflow_referrals` row in `created` with the
// specialty and nothing else — the consultant names the department, the station
// fills in the doctor, hospital and phone later. Deselecting removes a row that
// is still `created`; a row past that has a letter behind it and is refused with
// a 409 the consultant can act on, surfaced as a toast rather than swallowed.
//
// The chips are per VISIT, not per patient: they are this consultation's
// decisions, which is why the row carries visit_id.

export default function ReferralChips({ visitId, readOnly, onToast }) {
  const { data: referrals = [] } = useVisitReferrals(visitId);
  const toggleOn = useToggleReferralChip();
  const toggleOff = useRemoveReferral();

  const busy = toggleOn.isPending || toggleOff.isPending;
  const bySpecialty = new Map(referrals.map((r) => [r.specialty, r]));

  const fail = (e) => onToast?.(e?.response?.data?.error || "That referral did not change");

  const toggle = (value) => {
    const existing = bySpecialty.get(value);
    const label = specialtyMeta(value)?.label || value;
    if (existing) {
      return toggleOff.mutate(existing.id, {
        onSuccess: () => onToast?.(`${label} referral removed`),
        onError: fail,
      });
    }
    return toggleOn.mutate(
      { visitId, specialty: value },
      {
        onSuccess: () =>
          onToast?.(`↗ ${label} referral added — the letter is written when you finalize`),
        onError: fail,
      },
    );
  };

  // Specialties raised from the station rather than a chip still belong to this
  // visit, so they are shown alongside — a consultant who cannot see a referral
  // on their own consultation would raise it a second time.
  const extra = referrals.map((r) => r.specialty).filter((s) => !CHIP_SPECIALTIES.includes(s));
  const values = [...CHIP_SPECIALTIES, ...extra];

  return (
    <div className="cp-refs">
      <span className="cp-lab" id="cp-ref-lab">
        ↗ Referrals
        <em> — where a patient leaves the Gini floor</em>
      </span>
      <div className="ref-chips" role="group" aria-labelledby="cp-ref-lab">
        {values.map((value) => {
          const meta = specialtyMeta(value);
          const row = bySpecialty.get(value);
          return (
            <button
              type="button"
              key={value}
              className={`rchip${row ? " sel" : ""}`}
              disabled={readOnly || busy}
              aria-pressed={!!row}
              onClick={() => toggle(value)}
            >
              <span aria-hidden="true">{meta?.icon || "↗"}</span> {meta?.label || value}
            </button>
          );
        })}
      </div>

      {referrals.length > 0 && (
        <ul className="cp-ref-list">
          {referrals.map((r) => (
            <li key={r.id}>
              <strong>
                {r.icon} {r.specialtyLabel}
              </strong>
              <span>
                {r.toDoctor ? ` · ${r.toDoctor}` : ""}
                {r.hospital ? ` · ${r.hospital}` : ""}
                {" · "}
                {r.letterUrl ? "letter ready" : "letter written on finalize"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Urgency is set at the station, not here: the consultant names the
          department, and the desk that chases the specialist owns how hard it
          chases. Naming the default keeps that from being a surprise. */}
      <div className="cp-ref-hint">
        Raised as <strong>{URGENCIES[0].label}</strong> — the referrals desk sets the urgency,
        doctor and hospital.
      </div>
    </div>
  );
}
