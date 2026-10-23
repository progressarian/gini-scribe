import { useEffect, useId, useRef, useState } from "react";
import { CAP_MAX, PATIENT_TYPES, PATIENT_TYPE_LABELS } from "../../../shared/slotCapacity";

const toText = (caps) =>
  Object.fromEntries(PATIENT_TYPES.map((t) => [t, caps?.[t] == null ? "" : String(caps[t])]));

const badNumber = (v) => v !== "" && !(/^\d+$/.test(v) && Number(v) <= CAP_MAX);

const step = (value, by) => {
  if (value === "" || badNumber(value)) return by > 0 ? "1" : value;
  return String(Math.min(CAP_MAX, Math.max(0, Number(value) + by)));
};

const slots = (n) => `${n} slot${n === 1 ? "" : "s"}`;

export default function SlotLimitsPanel({
  title,
  context,
  note,
  caps,
  scopes,
  needsReason = false,
  busy = false,
  applyLabel,
  resetLabel,
  onApply,
  onReset,
  onCancel,
}) {
  const [values, setValues] = useState(toText(caps));
  const [scope, setScope] = useState(scopes?.[0]?.[0] ?? null);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const first = useRef(null);
  const id = useId();

  useEffect(() => {
    first.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  const invalid = PATIENT_TYPES.some((t) => badNumber(values[t]));
  const missingReason = needsReason && !reason.trim();
  const chosen = scopes?.find(([key]) => key === scope);
  const submitLabel = applyLabel || (chosen ? `Apply to ${slots(chosen[2])}` : "Apply");
  const set = (t, value) => setValues((v) => ({ ...v, [t]: value }));

  const submit = (e) => {
    e.preventDefault();
    setTouched(true);
    if (busy || invalid || missingReason) return;
    onApply({
      caps: Object.fromEntries(
        PATIENT_TYPES.map((t) => [t, values[t] === "" ? null : Number(values[t])]),
      ),
      scope,
      reason: reason.trim(),
    });
  };

  return (
    <div className="docmgmt-modal-bg" onClick={() => !busy && onCancel()}>
      <form
        className="docmgmt-modal docmgmt-limitmodal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        noValidate
      >
        <header className="docmgmt-limithead">
          <div>
            <h2 id={`${id}-title`}>
              <span className="docmgmt-visually-hidden">Patients per slot · </span>
              {title}
            </h2>
            {context && <p className="docmgmt-limitcontext">{context}</p>}
            {note && <p className="docmgmt-hint">{note}</p>}
          </div>
          <button
            type="button"
            className="docmgmt-iconbtn"
            aria-label="Close"
            disabled={busy}
            onClick={onCancel}
          >
            ✕
          </button>
        </header>

        <section className="docmgmt-limitsection" aria-labelledby={`${id}-caps`}>
          <h3 id={`${id}-caps`} className="docmgmt-limitlabel">
            Patients this slot can take
          </h3>
          <div className="docmgmt-limitgrid">
            {PATIENT_TYPES.map((t, i) => {
              const label = PATIENT_TYPE_LABELS[t];
              const bad = badNumber(values[t]);
              return (
                <div key={t} className={`docmgmt-limitbox${bad ? " is-bad" : ""}`}>
                  <label htmlFor={`${id}-${t}`}>{label}</label>
                  <div className="docmgmt-stepper">
                    <button
                      type="button"
                      aria-label={`Fewer ${label.toLowerCase()}`}
                      disabled={values[t] === "" || values[t] === "0"}
                      onClick={() => set(t, step(values[t], -1))}
                    >
                      −
                    </button>
                    <input
                      id={`${id}-${t}`}
                      ref={i === 0 ? first : undefined}
                      type="number"
                      min="0"
                      max={CAP_MAX}
                      inputMode="numeric"
                      placeholder="—"
                      value={values[t]}
                      aria-invalid={bad || undefined}
                      aria-describedby={bad ? `${id}-${t}-err` : undefined}
                      onChange={(e) => set(t, e.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={`More ${label.toLowerCase()}`}
                      disabled={values[t] === String(CAP_MAX)}
                      onClick={() => set(t, step(values[t], 1))}
                    >
                      +
                    </button>
                  </div>
                  {values[t] !== "" && !bad ? (
                    <button type="button" className="docmgmt-linkbtn" onClick={() => set(t, "")}>
                      Set no limit
                    </button>
                  ) : (
                    <span className="docmgmt-limitstate">{bad ? "" : "No limit"}</span>
                  )}
                  {bad && (
                    <span className="docmgmt-fielderr" id={`${id}-${t}-err`}>
                      0 to {CAP_MAX}, whole number
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <p className="docmgmt-hint">Empty means no limit. 0 means none of that type.</p>
        </section>

        {scopes && (
          <fieldset className="docmgmt-limitsection docmgmt-scopes">
            <legend className="docmgmt-limitlabel">Apply to</legend>
            <div className="docmgmt-scopegrid">
              {scopes.map(([key, label, count]) => (
                <label key={key} className={`docmgmt-scope${scope === key ? " is-on" : ""}`}>
                  <input
                    type="radio"
                    name={`${id}-scope`}
                    checked={scope === key}
                    onChange={() => setScope(key)}
                  />
                  <span>
                    <strong>{label}</strong>
                    <small>{slots(count)}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {needsReason && (
          <section className="docmgmt-limitsection">
            <label className="docmgmt-limitlabel" htmlFor={`${id}-reason`}>
              Reason (required)
            </label>
            <input
              id={`${id}-reason`}
              className="docmgmt-limitreason"
              value={reason}
              maxLength={300}
              placeholder="e.g. Doctor leaves early for a conference"
              aria-invalid={(touched && missingReason) || undefined}
              aria-describedby={touched && missingReason ? `${id}-reason-err` : undefined}
              onChange={(e) => setReason(e.target.value)}
            />
            {touched && missingReason && (
              <span className="docmgmt-fielderr" id={`${id}-reason-err`}>
                Say why this date is different.
              </span>
            )}
          </section>
        )}

        <footer className="docmgmt-modal-actions docmgmt-limitfoot">
          {onReset && (
            <button type="button" disabled={busy} onClick={() => onReset(scope)}>
              {resetLabel}
            </button>
          )}
          <div className="spacer" />
          <button type="button" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="docmgmt-primary" disabled={busy || invalid}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
