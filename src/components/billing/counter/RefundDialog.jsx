import { useEffect, useMemo, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useCreditableLines,
  useRefundPreview,
  useRefundRequest,
} from "../../../queries/hooks/useBilling";
import { NOTE_REQUIRED_REFUND_REASON, REFUND_REASONS } from "../../../../shared/refundReasons.js";
import { AS_PAID } from "../../../../shared/billingVocab.js";
import { errorOf, fromPaise, moneyTyped } from "../format";
import { PAYMENT_MODE_LABEL, refundLegsText } from "./lineText";

const REFUND_BY = [
  { value: AS_PAID, label: "As paid" },
  ...Object.entries(PAYMENT_MODE_LABEL).map(([value, label]) => ({ value, label })),
];

const quantityText = (value) => String(Number(value.toFixed(2)));

function usePreviewBody(body) {
  const [settled, setSettled] = useState(body);
  const key = JSON.stringify(body);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(body), 300);
    return () => clearTimeout(timer);
  }, [key]);
  return settled;
}

function PreviewText({ preview, error, loading }) {
  if (error) return <div className="bc-err">{error}</div>;
  if (!preview) return <div className="bc-hint">{loading ? "Working it out…" : ""}</div>;
  const { due, against_balance: against, legs } = preview.refund;
  return (
    <div className="bc-refund__preview" aria-label="What the patient gets back">
      {due > 0 ? (
        <strong>
          Patient gets back {fromPaise(due)} — {refundLegsText(legs, fromPaise)}
        </strong>
      ) : (
        <strong>Nothing is paid back in money.</strong>
      )}
      {against > 0 && (
        <div>{fromPaise(against)} reduces the balance still owed on this bill first.</div>
      )}
      {preview.tests_done.length > 0 && (
        <div className="bc-hint">
          {preview.tests_done.join(", ")} already done — the admin must write a reason to approve.
        </div>
      )}
    </div>
  );
}

const pickedFrom = (prefill) =>
  Object.fromEntries(
    (prefill?.lines || []).map((line) => [line.line_id, quantityText(Number(line.quantity))]),
  );

export default function RefundDialog({ bill, prefill = null, onClose, onSent }) {
  const { data: creditable, isLoading, error: loadError } = useCreditableLines(bill.id);
  const send = useRefundRequest();
  const [whole, setWhole] = useState(!prefill);
  const [picked, setPicked] = useState(() => pickedFrom(prefill));
  const [reason, setReason] = useState(prefill?.reason_code ?? "");
  const [note, setNote] = useState(prefill?.note ?? "");
  const [mode, setMode] = useState(AS_PAID);
  const [error, setError] = useState(null);

  const lines = creditable?.lines || [];
  const open = lines.filter((line) => line.left > 0 && !line.claim_cleared);
  const chosen = Object.entries(picked)
    .filter(([, typed]) => Number(typed) > 0)
    .map(([lineId, typed]) => ({ line_id: lineId, quantity: Number(typed) }));
  const tooMuch = Object.entries(picked).some(([lineId, typed]) => {
    const line = lines.find((l) => l.line_id === lineId);
    return line && Number(typed) > line.left;
  });

  const body = useMemo(
    () =>
      whole
        ? { bill_id: bill.id, whole_bill: true, mode }
        : chosen.length
          ? { bill_id: bill.id, lines: chosen, mode }
          : null,
    [whole, JSON.stringify(chosen), bill.id, mode],
  );
  const settled = usePreviewBody(body);
  const ready = open.length > 0 && !tooMuch && body && settled === body;
  const preview = useRefundPreview(settled, { enabled: open.length > 0 && !tooMuch && !!settled });
  const needsNote = reason === NOTE_REQUIRED_REFUND_REASON && !note.trim();
  const canSend = ready && !!reason && !needsNote && !!preview.data && !preview.isError;

  const toggle = (line, on) =>
    setPicked((current) => {
      const next = { ...current };
      if (on) next[line.line_id] = quantityText(line.left);
      else delete next[line.line_id];
      return next;
    });

  const submit = async () => {
    setError(null);
    try {
      await send.mutateAsync({
        billId: bill.id,
        visitId: bill.visit_id,
        ...(whole ? { whole_bill: true } : { lines: chosen }),
        reason_code: reason,
        requested_mode: mode,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onSent();
    } catch (e) {
      setError(errorOf(e, "The refund request could not be sent"));
    }
  };

  const message = (
    <div className="bc-refund">
      {isLoading && <div className="bc-hint">Loading the bill…</div>}
      {loadError && (
        <div className="bc-err">{errorOf(loadError, "The bill could not be read")}</div>
      )}
      {creditable && !open.length && (
        <div className="bc-hint">Nothing is left on this bill that can be refunded.</div>
      )}
      {open.length > 0 && (
        <>
          <fieldset className="bc-refund__set">
            <legend className="bc-field__lbl">What to refund</legend>
            <label className="bc-refund__choice">
              <input
                type="radio"
                name="refund-what"
                checked={whole}
                onChange={() => setWhole(true)}
              />
              <span>Whole bill</span>
            </label>
            <label className="bc-refund__choice">
              <input
                type="radio"
                name="refund-what"
                checked={!whole}
                onChange={() => setWhole(false)}
              />
              <span>Chosen lines</span>
            </label>
          </fieldset>

          {!whole && (
            <ul className="bc-refund__lines" aria-label="Lines to refund">
              {lines.map((line) => {
                const blocked = line.left <= 0 || line.claim_cleared;
                const on = picked[line.line_id] !== undefined;
                return (
                  <li key={line.line_id} className="bc-refund__line">
                    <label className="bc-refund__choice">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={blocked}
                        onChange={(e) => toggle(line, e.target.checked)}
                      />
                      <span>
                        {line.bill_name}
                        <span className="bc-head__meta">
                          {" "}
                          · {fromPaise(line.patient_payable)}
                          {line.left <= 0
                            ? " · already credited"
                            : line.claim_cleared
                              ? " · claim paid by the payer"
                              : line.credited_quantity > 0
                                ? ` · ${line.left} left`
                                : ""}
                        </span>
                      </span>
                    </label>
                    {on && line.quantity !== 1 && (
                      <label className="bc-field bc-refund__qty">
                        <span className="bc-field__lbl">Quantity (up to {line.left})</span>
                        <input
                          className="bc-field__in"
                          inputMode="decimal"
                          value={picked[line.line_id]}
                          onChange={(e) =>
                            setPicked({ ...picked, [line.line_id]: moneyTyped(e.target.value) })
                          }
                        />
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {tooMuch && <div className="bc-err">A quantity is more than is left to refund.</div>}

          <label className="bc-field">
            <span className="bc-field__lbl">Reason</span>
            <select
              className="bc-field__in"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              <option value="">Choose a reason…</option>
              {REFUND_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="bc-field">
            <span className="bc-field__lbl">
              {reason === NOTE_REQUIRED_REFUND_REASON ? "Reason in your words" : "Note (optional)"}
            </span>
            <textarea
              className="bc-field__in"
              rows={2}
              maxLength={1000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>

          <label className="bc-field">
            <span className="bc-field__lbl">Refund by</span>
            <select className="bc-field__in" value={mode} onChange={(e) => setMode(e.target.value)}>
              {REFUND_BY.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <PreviewText
            preview={body ? preview.data : null}
            loading={preview.isFetching || settled !== body}
            error={
              preview.isError ? errorOf(preview.error, "The refund could not be worked out") : null
            }
          />
          <div className="bc-hint">
            An admin must approve the refund before any money goes back.
          </div>
        </>
      )}
    </div>
  );

  return (
    <ConfirmModal
      open
      title={`Refund on bill ${bill.bill_no}`}
      confirmLabel="Send request"
      cancelLabel="Cancel"
      variant="primary"
      busy={send.isPending}
      confirmDisabled={!canSend}
      error={error}
      message={message}
      onConfirm={submit}
      onCancel={onClose}
    />
  );
}
