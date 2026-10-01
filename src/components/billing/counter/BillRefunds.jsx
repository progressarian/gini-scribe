import { useEffect, useState } from "react";
import {
  creditNotePdfHref,
  refundReceiptPdfHref,
  useBillRefunds,
  useCurrentShift,
  usePayOut,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise, moneyTyped } from "../format";
import { payOutText, refundLegsText, refundModeText } from "./lineText";
import { HEALTHRAY_MODE } from "../../../../shared/billingVocab.js";
import RefundDialog from "./RefundDialog";
import { PdfButton } from "./PdfViewer";

const paiseOf = (typed) => Math.round(Number(typed || 0) * 100);

const needsReference = (mode) => mode !== "cash" && mode !== HEALTHRAY_MODE;

const toRupees = (paise) => (Math.max(0, paise) / 100).toFixed(2).replace(/\.00$/, "");

const REFERENCE_HINT = {
  card: "Card reversal reference",
  upi: "UPI reversal transaction ID",
};

const rowsFor = (note) =>
  note.refund.legs.map((leg) => ({
    mode: leg.mode,
    most: leg.amount,
    amount: toRupees(leg.amount),
    reference: "",
  }));

function PayOut({ note, bill, onPaid }) {
  const { data: shift } = useCurrentShift();
  const payOut = usePayOut();
  const [rows, setRows] = useState(() => rowsFor(note));
  const [error, setError] = useState(null);
  const key = `${note.id}:${note.version}:${note.refund.due}`;

  useEffect(() => {
    setRows(rowsFor(note));
  }, [key]);

  const entered = rows.reduce((sum, row) => sum + paiseOf(row.amount), 0);
  const cashOut = rows.some((row) => row.mode === "cash" && paiseOf(row.amount) > 0);
  const missingReference = rows.some(
    (row) => paiseOf(row.amount) > 0 && needsReference(row.mode) && !row.reference.trim(),
  );
  const over = rows.some((row) => paiseOf(row.amount) > row.most);

  const change = (index, patch) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const setAmount = (index, typed) => {
    const amount = moneyTyped(typed);
    const most = rows[index].most;
    change(index, { amount: paiseOf(amount) > most ? toRupees(most) : amount });
  };

  const pay = async () => {
    setError(null);
    try {
      await payOut.mutateAsync({
        creditNoteId: note.id,
        billId: bill.id,
        visitId: bill.visit_id,
        version: note.version,
        payments: rows
          .filter((row) => paiseOf(row.amount) > 0)
          .map((row) => ({
            mode: row.mode,
            amount: row.amount.trim(),
            ...(row.reference.trim() ? { reference: row.reference.trim() } : {}),
          })),
      });
      onPaid(`Paid back ${fromPaise(entered)} on ${note.bill_no}.`);
    } catch (e) {
      setError(errorOf(e, "The refund could not be paid out"));
    }
  };

  return (
    <div className="bc-pay__take" aria-label={`Pay out on ${note.bill_no}`} role="group">
      <div className="bc-hint">
        {fromPaise(note.refund.due)} is due back to the patient —{" "}
        {refundLegsText(note.refund.legs, fromPaise)}.
      </div>
      {cashOut && !shift?.is_open && (
        <div className="bc-pay__warn">
          No shift is open, so cash can&apos;t be paid back yet — open one on the Shift tab.
        </div>
      )}
      <div className="bc-pay__lines">
        {rows.map((row, index) => (
          <div className="bc-pay__line" key={`${row.mode}-${index}`}>
            <div className="bc-pay__linehead">
              <span>{payOutText(row.mode)}</span>
            </div>
            <div className="bc-pay__fields">
              <label className="bc-field">
                <span className="bc-field__lbl">Amount to pay back</span>
                <span className="bc-pay__money">
                  <span aria-hidden="true">₹</span>
                  <input
                    className="bc-field__in"
                    inputMode="decimal"
                    value={row.amount}
                    onChange={(e) => setAmount(index, e.target.value)}
                  />
                </span>
              </label>
              {needsReference(row.mode) && (
                <label className="bc-field bc-pay__ref">
                  <span className="bc-field__lbl">Reference</span>
                  <input
                    className="bc-field__in"
                    maxLength={60}
                    placeholder={REFERENCE_HINT[row.mode]}
                    value={row.reference}
                    onChange={(e) => change(index, { reference: e.target.value })}
                  />
                </label>
              )}
            </div>
          </div>
        ))}
      </div>
      {missingReference && (
        <div className="bc-hint">Add the reversal reference for each card or UPI refund.</div>
      )}
      <button
        type="button"
        className="bc-pay__go"
        disabled={entered <= 0 || over || missingReference || payOut.isPending}
        onClick={pay}
      >
        {payOut.isPending ? "Paying out…" : `Pay out ${fromPaise(entered)}`}
      </button>
      {error && <div className="bc-err">{error}</div>}
    </div>
  );
}

function RequestState({ request }) {
  if (!request) return null;
  if (request.status === "pending") {
    return (
      <div className="bc-hint" role="status">
        <strong>Refund requested — waiting for admin.</strong> {request.reason}
        {request.refund?.preview ? (
          <> · {fromPaise(request.refund.preview.refund.due)} to go back</>
        ) : null}
      </div>
    );
  }
  if (request.status === "rejected") {
    return (
      <div className="bc-err" role="status">
        Refund rejected by {request.decided_by?.name ?? "the admin"}: {request.decision_note}
      </div>
    );
  }
  return null;
}

function CancelledNotRefunded({ lines, waiting, onRefund }) {
  if (!lines.length) return null;
  return (
    <div className="bc-refund__note" aria-label="Cancelled on the floor — not refunded yet">
      <div>
        <strong>Cancelled on the floor — not refunded yet:</strong>{" "}
        {lines.map((line) => `${line.bill_name} ${fromPaise(line.patient_payable)}`).join(", ")}
      </div>
      {waiting ? (
        <div className="bc-hint">
          Once the admin answers the waiting refund, refund {lines.length === 1 ? "it" : "these"}{" "}
          too.
        </div>
      ) : (
        <div className="bc-head__row">
          <button type="button" className="st-btn st-btn-g" onClick={onRefund}>
            Refund {lines.length === 1 ? "this" : "these"}…
          </button>
        </div>
      )}
    </div>
  );
}

const prefillFor = (lines) => ({
  lines: lines.map((line) => ({ line_id: line.line_id, quantity: line.quantity })),
  reason_code: lines.find((line) => line.reason_code)?.reason_code ?? "",
  note: [...new Set(lines.map((line) => line.note).filter(Boolean))].join("; "),
});

export default function BillRefunds({ bill, onRefunded }) {
  const refundable = bill.bill_type === "invoice" && bill.status === "final";
  const { data } = useBillRefunds(bill.id, { enabled: refundable });
  const [note, setNote] = useState(null);
  const [refunding, setRefunding] = useState(null);
  const notes = data?.credit_notes || [];
  const latest = data?.requests?.[0] ?? null;
  const known = bill.credits?.notes?.length ?? 0;
  const cancelled = bill.credits?.cancelled_not_refunded ?? [];
  const waiting = bill.credits?.request?.status === "pending";

  useEffect(() => {
    if (data && notes.length !== known) onRefunded();
  }, [notes.length, known]);

  if (!refundable || (!latest && !notes.length && !cancelled.length)) return null;

  return (
    <section className="bc-card" aria-label="Refunds">
      <h3 className="bc-card__title">Refunds</h3>
      <RequestState request={latest} />
      <CancelledNotRefunded
        lines={cancelled}
        waiting={waiting}
        onRefund={() => {
          setNote(null);
          setRefunding(prefillFor(cancelled));
        }}
      />
      {notes.map((cn) => (
        <div key={cn.id} className="bc-refund__note">
          <div>
            <strong>Credit note {cn.bill_no}</strong> · credited {fromPaise(cn.totals.payable)} ·
            refunded {fromPaise(cn.totals.refunded)}
          </div>
          {cn.refund.approved_mode && (
            <div className="bc-head__meta">
              Approved: {refundModeText(cn.refund.approved_mode)}
              {cn.refund.mode_reason ? ` — ${cn.refund.mode_reason}` : ""}
              {cn.refund.reason ? ` · ${cn.refund.reason}` : ""}
            </div>
          )}
          <div className="bc-head__row">
            <PdfButton
              className="st-btn st-btn-g"
              href={creditNotePdfHref(cn.id)}
              title={`Credit note ${cn.bill_no}`}
              fileName={`CreditNote_${cn.bill_no}.pdf`}
            >
              Print credit note
            </PdfButton>
            {cn.totals.refunded > 0 && (
              <PdfButton
                className="st-btn st-btn-g"
                href={refundReceiptPdfHref(cn.id)}
                title={`Refund receipt ${cn.bill_no}`}
                fileName={`RefundReceipt_${cn.bill_no}.pdf`}
              >
                Print refund receipt
              </PdfButton>
            )}
          </div>
          {cn.refund.due > 0 && (
            <PayOut
              note={cn}
              bill={bill}
              onPaid={(message) => {
                setNote(message);
                onRefunded();
              }}
            />
          )}
        </div>
      ))}
      {note && <div className="bc-note">{note}</div>}
      {refunding && (
        <RefundDialog
          bill={bill}
          prefill={refunding}
          onClose={() => setRefunding(null)}
          onSent={() => {
            setRefunding(null);
            setNote("Refund requested — waiting for admin.");
            onRefunded();
          }}
        />
      )}
    </section>
  );
}
