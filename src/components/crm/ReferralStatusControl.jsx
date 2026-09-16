import { useState } from "react";
import api from "../../services/api.js";
import { REFERRAL_STATUSES, attributionStatusMeta } from "../../../shared/crmVocab.js";

// Move a referral along the funnel (brief §7).
//
// Manual for now — Scribe automation is Phase 2 — so the control shows the next
// few steps rather than all fourteen statuses, because a rep on a phone should
// be choosing between "contacted" and "no-show", not scrolling a list.
//
// `lost` is the only status that demands a reason, and the reason box appears
// before the save rather than after: §7 calls it mandatory because "lost, no
// reason" turns a leakage report into a list of shrugs.

// The ordinary path forward from each state. Everything can also be lost.
const NEXT = {
  new: ["contact_attempted", "contacted"],
  contact_attempted: ["contacted", "no_show"],
  contacted: ["appointment_booked", "consulted"],
  appointment_booked: ["consulted", "no_show"],
  no_show: ["contacted", "appointment_booked"],
  consulted: ["investigation", "admission_advised", "closed"],
  investigation: ["admission_advised", "consulted", "closed"],
  admission_advised: ["admitted", "closed"],
  admitted: ["procedure_completed", "discharged"],
  procedure_completed: ["discharged"],
  discharged: ["follow_up", "closed"],
  follow_up: ["closed"],
};

const label = (v) => REFERRAL_STATUSES.find((s) => s.value === v)?.label || v;

export default function ReferralStatusControl({ referral, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState("");
  const [err, setErr] = useState(null);

  const status = referral.status;
  const next = NEXT[status] || [];
  const terminal = status === "closed" || status === "lost";
  const attr = attributionStatusMeta(referral.attribution_status);

  const move = async (to, reason) => {
    setBusy(true);
    setErr(null);
    try {
      await api.post(`/api/crm/referrals/${referral.id}/status`, {
        status: to,
        lost_reason: reason,
      });
      setLostOpen(false);
      setLostReason("");
      await onChanged?.();
    } catch (e) {
      setErr(e?.response?.data?.error || "Could not update");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="refc">
      <div className="refc__head">
        <span className="refc__now">{label(status)}</span>
        {attr && <span className={`d360__tag d360__tag--${attr.tone}`}>{attr.label}</span>}
        {referral.lost_reason && <span className="rep__hint">— {referral.lost_reason}</span>}
      </div>

      {err && <div className="rep__err">{err}</div>}

      {!terminal && (
        <div className="rep__chips">
          {next.map((s) => (
            <button key={s} className="rep__chip" disabled={busy} onClick={() => move(s)}>
              {label(s)}
            </button>
          ))}
          <button
            className="rep__chip rep__chip--gap"
            disabled={busy}
            onClick={() => setLostOpen((v) => !v)}
          >
            Lost
          </button>
        </div>
      )}

      {lostOpen && (
        <div className="rep__gap">
          <input
            className="rep__input"
            value={lostReason}
            onChange={(e) => setLostReason(e.target.value)}
            placeholder="Why was it lost? (required)"
            autoFocus
          />
          <button
            className="rep__btn rep__btn--sm"
            disabled={busy || !lostReason.trim()}
            onClick={() => move("lost", lostReason.trim())}
          >
            Save
          </button>
          <button
            className="rep__btn rep__btn--sm rep__btn--ghost"
            onClick={() => setLostOpen(false)}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
