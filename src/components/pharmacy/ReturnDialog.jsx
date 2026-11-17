import { useState } from "react";
import MasterFormDialog from "./MasterFormDialog";
import FormField from "../ui/FormField";
import { digitsTyped, requestErrorOf } from "../billing/format";
import { inr, localDate, packUnits, showDate } from "./format";
import { toast } from "../../stores/uiStore";
import { useCreateReturn } from "../../queries/hooks/usePharmacyBills";
import { useReturnIndent } from "../../queries/hooks/usePharmacyDepartments";
import { pharmacyBillTotals, pharmacyReturnAmounts } from "../../../shared/pharmacyPricing";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney";
import { UPI_APP_LABEL } from "../../../shared/billingVocab";
import { PAYMENT_MODE_LABEL, PAYMENT_MODES } from "../../../shared/pharmacyVocab";

export default function ReturnDialog({ bill, returned, onDone, onClose, indentId = null }) {
  const billReturn = useCreateReturn();
  const indentReturn = useReturnIndent();
  const create = indentId ? indentReturn : billReturn;
  const [qty, setQty] = useState({});
  const [reason, setReason] = useState("");
  const [mode, setMode] = useState("cash");
  const [reference, setReference] = useState("");
  const [upiApp, setUpiApp] = useState("");
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const today = localDate();

  const rows = bill.lines.map((line) => {
    const before = returned[line.id] ?? 0;
    const left = line.qty_units - before;
    const units = Number(qty[line.id] || 0);
    const expired = line.expiry_date <= today;
    const amounts =
      units > 0 && units <= left ? pharmacyReturnAmounts(line, bill, before, units) : null;
    return { line, before, left, units, expired, amounts };
  });
  const chosen = rows.filter((r) => r.units > 0);
  const totals = pharmacyBillTotals(chosen.filter((r) => r.amounts).map((r) => r.amounts));
  const offDue = Math.min(totals.total, toPaise(bill.due_amount ?? 0));
  const refund = totals.total - offDue;
  const needsRefund = refund > 0 && !indentId;

  const problems = {};
  for (const r of chosen) {
    if (r.units > r.left)
      problems[r.line.id] = `Only ${r.left} ${r.line.unit_label} can still be returned.`;
  }
  if (!chosen.length) problems.lines = "Enter the quantity coming back for at least one medicine.";
  if (reason.trim().length < 3) problems.reason = "Say why the medicines came back.";
  if (needsRefund && mode !== "cash" && !reference.trim())
    problems.reference = "Enter the refund reference.";
  if (needsRefund && mode === "upi" && !upiApp) problems.upiApp = "Choose the UPI app.";
  if (indentId && refund > 0)
    problems.lines = `Only ${inr(toRupees(offDue))} is still due on this bill. Ask the pharmacy to take back the rest and refund it.`;
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    try {
      const base = {
        version: bill.version,
        reason: reason.trim(),
        lines: chosen.map((r) => ({ line_id: r.line.id, qty_units: r.units })),
      };
      if (indentId) {
        const after = await create.mutateAsync({ id: indentId, ...base });
        toast(`Return saved. ${inr(after.due_amount)} is now due on bill ${after.bill_no}.`);
        onDone(after);
        return;
      }
      const note = await create.mutateAsync({
        id: bill.id,
        ...base,
        refund: {
          mode,
          reference: mode === "cash" ? null : reference.trim(),
          upi_app: mode === "upi" ? upiApp : null,
        },
      });
      toast(
        toPaise(note.paid_amount)
          ? `Credit note ${note.bill_no} saved. Refund ${inr(note.paid_amount)}.`
          : `Credit note ${note.bill_no} saved. ${inr(note.due_adjusted)} taken off the due.`,
      );
      onDone(note);
    } catch (err) {
      setConfirming(false);
      setError(requestErrorOf(err, "Could not record the return"));
    }
  };

  return (
    <MasterFormDialog
      title={`Return medicines · Bill ${bill.bill_no}`}
      intro={
        <p className="phs-meta">
          {bill.patient_name} ({bill.patient_file_no}). Returned medicines go back into the same
          batch. Expired medicines cannot be returned to stock.
        </p>
      }
      dirty={Boolean(chosen.length || reason)}
      busy={create.isPending}
      error={error || errors.lines}
      submitLabel={
        confirming
          ? create.isPending
            ? "Saving…"
            : needsRefund
              ? `Confirm refund of ${inr(toRupees(refund))}`
              : "Confirm return"
          : "Review return"
      }
      onSubmit={submit}
      onClose={onClose}
    >
      <div className="fset__scroll">
        <table className="flow-table phs-table" aria-label="Medicines on the bill">
          <thead>
            <tr>
              <th>Medicine</th>
              <th>Batch · expiry</th>
              <th className="phs-num">Sold</th>
              <th className="phs-num">Can return</th>
              <th className="phs-num">Returning</th>
              <th className="phs-num">Refund</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.line.id} className={r.expired || !r.left ? "phs-row--out" : ""}>
                <td data-label="Medicine">{r.line.medicine_name}</td>
                <td data-label="Batch">
                  <span className="phv-mono">{r.line.batch_no}</span>
                  <span className="phs-meta">Exp {showDate(r.line.expiry_date)}</span>
                </td>
                <td data-label="Sold" className="phs-num">
                  {packUnits(r.line.qty_units, r.line)}
                </td>
                <td data-label="Can return" className="phs-num">
                  {r.left} {r.line.unit_label}
                </td>
                <td data-label="Returning" className="phs-num">
                  {r.expired ? (
                    <span className="phs-meta">Expired</span>
                  ) : !r.left ? (
                    <span className="phs-meta">All returned</span>
                  ) : (
                    <div className="phb-give">
                      <input
                        className="jb-assign phb-qty"
                        inputMode="numeric"
                        maxLength={6}
                        aria-label={`Returning ${r.line.medicine_name} batch ${r.line.batch_no}`}
                        aria-invalid={errors[r.line.id] ? true : undefined}
                        value={qty[r.line.id] ?? ""}
                        disabled={confirming}
                        onChange={(e) =>
                          setQty({ ...qty, [r.line.id]: digitsTyped(e.target.value) })
                        }
                      />
                      {errors[r.line.id] ? (
                        <small className="form-field__error" role="alert">
                          {errors[r.line.id]}
                        </small>
                      ) : null}
                    </div>
                  )}
                </td>
                <td data-label="Refund" className="phs-num">
                  {r.amounts ? inr(toRupees(r.amounts.total)) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="bill-form">
        <FormField label="Reason" required error={errors.reason} className="phv-span-all">
          <input
            className="jb-assign"
            maxLength={300}
            value={reason}
            disabled={confirming}
            onChange={(e) => setReason(e.target.value)}
          />
        </FormField>
        {needsRefund ? (
          <FormField label="Refund by" required>
            <select
              className="jb-assign"
              value={mode}
              disabled={confirming}
              onChange={(e) => setMode(e.target.value)}
            >
              {PAYMENT_MODES.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        {needsRefund && mode === "upi" ? (
          <FormField label="UPI app" required error={errors.upiApp}>
            <select
              className="jb-assign"
              value={upiApp}
              disabled={confirming}
              onChange={(e) => setUpiApp(e.target.value)}
            >
              <option value="">Choose</option>
              {Object.entries(UPI_APP_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </FormField>
        ) : null}
        {needsRefund && mode !== "cash" ? (
          <FormField label="Refund reference" required error={errors.reference}>
            <input
              className="jb-assign"
              maxLength={60}
              value={reference}
              disabled={confirming}
              onChange={(e) => setReference(e.target.value)}
            />
          </FormField>
        ) : null}
      </div>
      <p className="phb-picked" role="status" aria-live="polite">
        {!chosen.length
          ? "Nothing chosen yet"
          : [
              offDue ? `${inr(toRupees(offDue))} taken off the due` : "",
              needsRefund ? `Refund ${inr(toRupees(refund))} by ${PAYMENT_MODE_LABEL[mode]}` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
      </p>
      {confirming ? (
        <p className="adj-change" role="alert">
          This saves a credit note against bill {bill.bill_no} and puts {chosen.length} medicine
          {chosen.length === 1 ? "" : "s"} back into {bill.location_name ?? "stock"}.
          {offDue ? ` ${inr(toRupees(offDue))} comes off what the patient owes.` : ""}
          {needsRefund
            ? ` ${inr(toRupees(refund))} is paid back by ${PAYMENT_MODE_LABEL[mode]}.`
            : ""}{" "}
          It cannot be undone.
        </p>
      ) : null}
    </MasterFormDialog>
  );
}
