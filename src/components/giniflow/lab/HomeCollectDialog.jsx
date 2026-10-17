import { useEffect, useId, useRef, useState } from "react";
import useDismiss from "./useDismiss";
import { homeSampleText } from "../../../../shared/homeCollection.js";

const IST_OFFSET_MS = 330 * 60 * 1000;
const istNow = () => new Date(Date.now() + IST_OFFSET_MS).toISOString();
const istDay = () => istNow().slice(0, 10);
const istClock = () => istNow().slice(11, 16);

const rupees = (amount) => `₹${Number(amount || 0).toLocaleString("en-IN")}`;

export function HomeCollectionTag({ row }) {
  const site = row?.collectedAtSite;
  if (!row?.homeCollection && site !== "home") return null;
  const text = homeSampleText(site ? { site, by: row.collectedBy, at: row.collectedAt } : null);
  return <span className={`badge ${site === "ghm" ? "b-ink" : "b-home"}`}>{text}</span>;
}

export default function HomeCollectDialog({ target, busy, error, onHome, onGhm, onClose }) {
  const titleId = useId();
  const cardRef = useRef(null);
  const [time, setTime] = useState(istClock);
  const [alsoOthers, setAlsoOthers] = useState(true);
  const [timeError, setTimeError] = useState(null);
  useDismiss(true, onClose, cardRef);
  useEffect(() => {
    cardRef.current?.querySelector("input, button")?.focus();
  }, []);

  const markHome = () => {
    if (!/^\d{2}:\d{2}$/.test(time)) return setTimeError("Enter the time the sample was taken.");
    if (time > istClock()) return setTimeError("The collection time can't be in the future.");
    setTimeError(null);
    return onHome({
      collectedAt: new Date(`${istDay()}T${time}:00+05:30`).toISOString(),
      alsoOthers: target.others > 0 && alsoOthers,
    });
  };

  return (
    <div className="modal-back home-collect-back">
      <div
        className="modal-card home-collect"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h3 className="modal-title" id={titleId}>
          Start collection — {target.name}
        </h3>
        <p className="home-collect-who">
          {[target.fileNo, [target.age, (target.sex || "")[0]].filter(Boolean).join("")]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <p className="home-collect-tests">
          🔬 {target.tests.length ? target.tests.join(", ") : "No tests listed"}
        </p>
        {target.unpaid && (
          <p className="home-collect-pay" role="note">
            💰 Payment pending — collect {rupees(target.amount)} at the home and tell reception.
          </p>
        )}
        <label className="home-collect-field">
          <span>Collected at</span>
          <input
            type="time"
            value={time}
            max={istClock()}
            aria-invalid={!!timeError}
            aria-describedby={timeError ? `${titleId}-time` : undefined}
            onChange={(e) => setTime(e.target.value)}
          />
        </label>
        {timeError && (
          <p className="home-collect-error" id={`${titleId}-time`} role="alert">
            {timeError}
          </p>
        )}
        {target.others > 0 && (
          <label className="home-collect-check">
            <input
              type="checkbox"
              checked={alsoOthers}
              onChange={(e) => setAlsoOthers(e.target.checked)}
            />
            Also mark the other {target.others} sample{target.others === 1 ? "" : "s"} for this
            patient
          </label>
        )}
        {error && (
          <p className="home-collect-error" role="alert">
            {error}
          </p>
        )}
        <div className="home-collect-acts">
          <button type="button" className="st-btn st-btn-grn" disabled={busy} onClick={markHome}>
            {busy ? "Saving…" : "🏠 Collected at home"}
          </button>
          <button
            type="button"
            className="st-btn st-btn-g"
            disabled={busy || target.unpaid}
            title={target.unpaid ? "Payment comes first when the patient is at GHM" : undefined}
            onClick={onGhm}
          >
            🏥 Patient came to GHM
          </button>
          <button type="button" className="st-btn st-btn-g" disabled={busy} onClick={onClose}>
            Cancel
          </button>
        </div>
        {target.unpaid && (
          <p className="home-collect-hint">
            At GHM the payment is taken first, as for every other patient.
          </p>
        )}
      </div>
    </div>
  );
}
