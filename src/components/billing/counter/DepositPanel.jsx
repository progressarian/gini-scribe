import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  depositConsentHref,
  depositReceiptPdfHref,
  depositSlipPdfHref,
  useCurrentShift,
  useDeposit,
  useReceiveDeposit,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import { when } from "../importText";
import { PAYMENT_MODE_LABEL } from "./lineText";
import { PdfButton } from "./PdfViewer";
import DepositMoves, { AmountField } from "./DepositMoves";
import { DEPOSIT_MAX } from "../../../../shared/billingVocab.js";

const KIND_LABEL = {
  received: "Deposit taken",
  applied: "Used on a bill",
  restored: "Refund kept as deposit",
  transfer_out: "Moved to another patient",
  transfer_in: "Moved in from another patient",
  to_ipd: "Moved to IPD",
  refunded: "Paid back",
};

const REFERENCE_HINT = {
  card: "e.g. last 4 digits or slip no.",
  upi: "e.g. UPI transaction ID",
};

const blankForm = () => ({ mode: "cash", amount: "", reference: "", note: "" });

function detailOf(entry) {
  if (entry.kind === "received") {
    return [PAYMENT_MODE_LABEL[entry.mode] ?? entry.mode, entry.reference, entry.receipt_no]
      .filter(Boolean)
      .join(" · ");
  }
  if (entry.kind === "applied") return entry.bill_no ? `Bill ${entry.bill_no}` : "Draft bill";
  if (entry.kind === "transfer_out" || entry.kind === "transfer_in") {
    return [
      entry.kind === "transfer_out" ? "To" : "From",
      entry.other_patient?.name,
      entry.other_patient?.file_no && `(${entry.other_patient.file_no})`,
      entry.relationship && `· ${entry.relationship}`,
      entry.slip_no && `· ${entry.slip_no}`,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (entry.kind === "to_ipd") return `IP ${entry.ipd_number} · ${entry.slip_no}`;
  if (entry.kind === "refunded") {
    return [PAYMENT_MODE_LABEL[entry.mode] ?? entry.mode, entry.reference]
      .filter(Boolean)
      .join(" · ");
  }
  if (entry.kind === "restored") {
    return [
      entry.bill_no && `Credit note ${entry.bill_no}`,
      entry.original_bill_no && `bill ${entry.original_bill_no}`,
    ]
      .filter(Boolean)
      .join(" on ");
  }
  return "";
}

const SLIP_KINDS = ["transfer_out", "transfer_in", "to_ipd", "refunded"];

export default function DepositPanel({ patientId, patientName, patientFileNo, open, onToggle }) {
  const { data, isLoading, isError, refetch } = useDeposit(patientId);
  const { data: shift } = useCurrentShift();
  const receive = useReceiveDeposit();
  const [form, setForm] = useState(blankForm);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);
  const [lastReceipt, setLastReceipt] = useState(null);
  const [confirming, setConfirming] = useState(false);

  const balance = data?.balance ?? 0;
  const entries = data?.entries ?? [];
  const amount = Math.round(Number(form.amount || 0) * 100);
  const needsReference = form.mode !== "cash";
  const needsShift = form.mode === "cash" && !shift?.is_open;
  const ready =
    amount > 0 && (!needsReference || form.reference.trim()) && !needsShift && !receive.isPending;

  const change = (patch) => {
    setForm((was) => ({ ...was, ...patch }));
    setConfirming(false);
    setError(null);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setError(null);
    setNote(null);
    try {
      const taken = await receive.mutateAsync({
        patientId,
        mode: form.mode,
        amount: form.amount.trim(),
        ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
        ...(form.note.trim() ? { note: form.note.trim() } : {}),
      });
      setForm(blankForm());
      setConfirming(false);
      setLastReceipt({ id: taken.payment_id, number: taken.receipt_no });
      setNote(
        `Deposit of ${fromPaise(taken.amount)} taken — receipt ${taken.receipt_no}. Balance now ${fromPaise(taken.balance)}.`,
      );
    } catch (e) {
      setConfirming(false);
      setError(errorOf(e, "The deposit could not be taken"));
    }
  };

  return (
    <section className="bc-card bc-deposit" aria-label="Patient deposit" id="bc-deposit">
      <h3 className="bc-card__title">
        <button
          type="button"
          className="bc-additems__toggle"
          aria-expanded={open}
          aria-controls="bc-deposit-body"
          onClick={onToggle}
        >
          <span>
            Deposit
            <span className="bc-deposit__balance">
              {isLoading ? "…" : isError ? "—" : fromPaise(balance)}
            </span>
          </span>
          {open ? (
            <ChevronUp size={16} aria-hidden="true" />
          ) : (
            <ChevronDown size={16} aria-hidden="true" />
          )}
        </button>
      </h3>

      {open && (
        <div id="bc-deposit-body" className="bc-additems__body">
          {isError ? (
            <div className="bc-err" role="alert">
              The deposit could not be loaded.{" "}
              <button type="button" className="st-btn st-btn-g" onClick={() => refetch()}>
                Try again
              </button>
            </div>
          ) : null}

          <p className="bc-hint">
            Money paid in advance, kept for {patientName || "this patient"}. It can pay any of their
            bills — choose <strong>Deposit</strong> as the payment mode. Refunds of cancelled
            services can be kept here too.
          </p>

          {data && (data.held > 0 || data.balance > 0) && (
            <dl className="bc-pay__mini">
              <div>
                <dt>Balance</dt>
                <dd>{fromPaise(data.balance)}</dd>
              </div>
              {data.held > 0 && (
                <div>
                  <dt>Held for refund</dt>
                  <dd>{fromPaise(data.held)}</dd>
                </div>
              )}
              <div className="bc-pay__left">
                <dt>Available</dt>
                <dd>{fromPaise(data.available)}</dd>
              </div>
            </dl>
          )}

          {data && (
            <DepositMoves
              patient={{ id: patientId, name: patientName, file_no: patientFileNo }}
              deposit={data}
            />
          )}

          <div className="bc-field__lbl">Take a deposit</div>
          <form className="bc-deposit__form" onSubmit={submit} aria-label="Take a deposit">
            <label className="bc-field">
              <span className="bc-field__lbl">Mode</span>
              <select
                className="bc-field__in"
                value={form.mode}
                onChange={(e) => change({ mode: e.target.value, reference: "" })}
              >
                {Object.entries(PAYMENT_MODE_LABEL).map(([mode, label]) => (
                  <option key={mode} value={mode}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <AmountField
              value={form.amount}
              available={DEPOSIT_MAX * 100}
              reason={`One deposit can be at most ${fromPaise(DEPOSIT_MAX * 100)}`}
              onChange={(amount) => change({ amount })}
            />
            {needsReference && (
              <label className="bc-field">
                <span className="bc-field__lbl">Reference *</span>
                <input
                  className="bc-field__in"
                  maxLength={60}
                  placeholder={REFERENCE_HINT[form.mode]}
                  value={form.reference}
                  onChange={(e) => change({ reference: e.target.value })}
                />
              </label>
            )}
            <label className="bc-field bc-deposit__note">
              <span className="bc-field__lbl">Note</span>
              <input
                className="bc-field__in"
                maxLength={300}
                placeholder="Optional — e.g. advance before admission"
                value={form.note}
                onChange={(e) => change({ note: e.target.value })}
              />
            </label>
            {needsShift && (
              <div className="bc-hint" role="status">
                Open your shift (Shift tab) before taking cash, so it is counted in your drawer.
              </div>
            )}
            {confirming && (
              <div className="bc-note" role="status">
                Take {fromPaise(amount)} by {PAYMENT_MODE_LABEL[form.mode]} as a deposit for{" "}
                {patientName || "this patient"}? Their deposit becomes {fromPaise(balance + amount)}
                .
              </div>
            )}
            <div className="bc-head__row">
              <button type="submit" className="st-btn st-btn-grn" disabled={!ready}>
                {receive.isPending
                  ? "Taking deposit…"
                  : confirming
                    ? "Confirm deposit"
                    : "Take deposit"}
              </button>
              {confirming && (
                <button
                  type="button"
                  className="st-btn st-btn-g"
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </button>
              )}
            </div>
          </form>

          {error && (
            <div className="bc-err" role="alert">
              {error}
            </div>
          )}
          {note && (
            <div className="bc-note" role="status">
              {note}
              {lastReceipt && (
                <>
                  {" "}
                  <PdfButton
                    className="st-btn st-btn-g"
                    href={depositReceiptPdfHref(lastReceipt.id)}
                    title={`Deposit receipt ${lastReceipt.number}`}
                    fileName={`Deposit_${lastReceipt.number}.pdf`}
                  >
                    Print receipt
                  </PdfButton>
                </>
              )}
            </div>
          )}

          <div className="bc-deposit__history">
            <div className="bc-field__lbl">History</div>
            {isLoading ? (
              <div className="bc-hint">Loading…</div>
            ) : !entries.length ? (
              <div className="bc-hint">No deposit has been taken for this patient yet.</div>
            ) : (
              <div className="bc-deposit__scroll">
                <table className="ltable" aria-label="Deposit history">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>What</th>
                      <th className="bc-num">Amount</th>
                      <th className="bc-num">Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => (
                      <tr key={entry.id}>
                        <td>
                          {when(entry.created_at)}
                          {entry.created_by_name ? (
                            <div className="bc-hint">{entry.created_by_name}</div>
                          ) : null}
                        </td>
                        <td>
                          {KIND_LABEL[entry.kind] ?? entry.kind}
                          {detailOf(entry) ? (
                            <div className="bc-hint">{detailOf(entry)}</div>
                          ) : null}
                          {entry.note ? <div className="bc-hint">{entry.note}</div> : null}
                          {SLIP_KINDS.includes(entry.kind) ? (
                            <PdfButton
                              className="st-btn st-btn-g"
                              href={depositSlipPdfHref(entry.id)}
                              title={`Deposit slip ${entry.slip_no || ""}`.trim()}
                              fileName={`DepositSlip_${entry.slip_no || entry.id}.pdf`}
                              aria-label={`Print the slip for ${KIND_LABEL[entry.kind].toLowerCase()}`}
                            >
                              Slip
                            </PdfButton>
                          ) : null}
                          {entry.consent_document_id ? (
                            <a
                              className="st-btn st-btn-g"
                              href={depositConsentHref(entry.consent_document_id)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Consent
                            </a>
                          ) : null}
                          {entry.kind === "received" && entry.payment_id ? (
                            <PdfButton
                              className="st-btn st-btn-g"
                              href={depositReceiptPdfHref(entry.payment_id)}
                              title={`Deposit receipt ${entry.receipt_no || ""}`.trim()}
                              fileName={`Deposit_${entry.receipt_no || entry.payment_id}.pdf`}
                              aria-label={`Print deposit receipt ${entry.receipt_no || ""}`.trim()}
                            >
                              Receipt
                            </PdfButton>
                          ) : null}
                        </td>
                        <td className="bc-num">
                          {entry.amount > 0 ? "+" : "−"}
                          {fromPaise(Math.abs(entry.amount))}
                        </td>
                        <td className="bc-num">{fromPaise(entry.balance_after)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
