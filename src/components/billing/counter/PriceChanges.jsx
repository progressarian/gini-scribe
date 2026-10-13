import { fromPaise } from "../format";

export default function PriceChanges({ changes, onDismiss }) {
  if (!changes) return null;
  const { before, after, lines, blocked } = changes;
  return (
    <section className="bc-repriced" role="status" aria-label="Prices changed">
      <h3 className="bc-repriced__title">
        {blocked ? "Prices changed in Settings" : "Prices changed since this bill was made"}
      </h3>
      <p className="bc-repriced__sum">
        Patient pays <strong>{fromPaise(after.payable)}</strong> (was {fromPaise(before.payable)})
        {after.claim !== before.claim && (
          <>
            {" "}
            · claim <strong>{fromPaise(after.claim)}</strong> (was {fromPaise(before.claim)})
          </>
        )}
      </p>
      {lines.length > 0 && (
        <ul className="bc-repriced__list">
          {lines.map((line) => (
            <li key={line.id}>
              <span className="bc-repriced__name" title={line.name}>
                {line.name}
              </span>
              <span className="bc-repriced__amt">
                {fromPaise(line.before)} → {fromPaise(line.after)}
              </span>
              <span className="bc-repriced__why">{line.reasons.join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
      {blocked && <p className="bc-repriced__sum">{blocked}</p>}
      <button type="button" className="st-btn st-btn-g" onClick={onDismiss}>
        Got it
      </button>
    </section>
  );
}
