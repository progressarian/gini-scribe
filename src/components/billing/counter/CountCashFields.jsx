import { useId } from "react";
import { rupees } from "../format";
import { cashTyped } from "../staff/staffText";
import { NOTES } from "./counterForm";

export default function CountCashFields({ count, action }) {
  const id = useId();
  const byNotesId = `${id}-bynotes`;
  const messageId = `${id}-countmsg`;
  const { counted, note, notes, byNotes, countedAmount, countedError, countWarning } = count;
  return (
    <>
      <div className="bc-head__row">
        <label className="bc-field">
          <span className="bc-field__lbl">Counted cash</span>
          <input
            className="bc-field__in"
            inputMode="decimal"
            value={byNotes ? countedAmount.toFixed(2) : counted}
            readOnly={byNotes}
            aria-describedby={byNotes ? byNotesId : messageId}
            aria-invalid={countedError && counted ? true : undefined}
            onChange={(e) => count.setCounted(cashTyped(e.target.value))}
          />
        </label>
        <label className="bc-field">
          <span className="bc-field__lbl">Note</span>
          <input
            className="bc-field__in"
            maxLength={280}
            value={note}
            onChange={(e) => count.setNote(e.target.value)}
          />
        </label>
        <span className="bc-hint" aria-label="Difference">
          Difference {rupees(count.difference)}
        </span>
        {!byNotes && counted && countedError ? (
          <span className="bc-err" id={messageId} role="alert">
            {countedError}
          </span>
        ) : countWarning ? (
          <span className="bc-hint bc-warn" id={messageId} role="status">
            {countWarning}
          </span>
        ) : null}
        {action}
      </div>
      <details className="bc-notes" open={byNotes || undefined}>
        <summary>Count by notes (optional)</summary>
        <div className="bc-notes__grid" role="group" aria-label="Note count">
          {NOTES.map((value) => (
            <label key={value} className="bc-field">
              <span className="bc-field__lbl">₹{value} notes</span>
              <input
                className="bc-field__in"
                inputMode="numeric"
                value={notes[value] ?? ""}
                onChange={(e) =>
                  count.setNotes({ [value]: e.target.value.replace(/\D/g, "").slice(0, 6) })
                }
              />
            </label>
          ))}
          <label className="bc-field">
            <span className="bc-field__lbl">Coins (₹)</span>
            <input
              className="bc-field__in"
              inputMode="decimal"
              value={notes.coins ?? ""}
              onChange={(e) => count.setNotes({ coins: cashTyped(e.target.value) })}
            />
          </label>
        </div>
        {byNotes && (
          <div className="bc-hint" id={byNotesId}>
            The counted cash is the note count: {rupees(countedAmount)}.{" "}
            <button type="button" className="bc-linkbtn" onClick={count.clearNotes}>
              Clear the note count
            </button>
          </div>
        )}
      </details>
    </>
  );
}
