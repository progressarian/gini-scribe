import { useEffect, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useDiscountFinalBill,
  usePreviewFinalDiscount,
  useRereadBill,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import ManualDiscountFields, { discountDraft, discountProblem } from "./ManualDiscountFields";

const WHOLE_BILL = "";

const PAYBACK = [
  {
    value: "cash",
    label: "Refund in cash now",
    hint: "Comes out of your cash drawer — open your shift first",
  },
  {
    value: "deposit",
    label: "Keep in the patient's deposit",
    hint: "Used on their next bill, or paid back later",
  },
  { value: "as_paid", label: "Pay back the way they paid", hint: "Paid out later from Refunds" },
];

const DONE_TEXT = {
  cash: (made) => ` — ${fromPaise(made.paid_in_cash)} refunded in cash.`,
  deposit: (made) => ` — ${fromPaise(made.kept_as_deposit)} kept in the patient's deposit.`,
  as_paid: (made) => ` — ${fromPaise(made.pay_back)} to pay back (Pay out under Refunds).`,
};

export default function FinalBillDiscount({ bill, patient, onBill, prefill = null }) {
  const preview = usePreviewFinalDiscount();
  const give = useDiscountFinalBill();
  const reread = useRereadBill();
  const [form, setForm] = useState(null);
  const [checked, setChecked] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [payback, setPayback] = useState("cash");

  useEffect(() => {
    if (!prefill) return;
    setError(null);
    setDone(null);
    setForm({
      lineId: WHOLE_BILL,
      value: { kind: prefill.kind, value: prefill.value, reason: prefill.reason ?? "" },
    });
  }, [prefill]);

  if (bill.status !== "final" || bill.bill_type !== "invoice" || bill.editing) return null;

  const body = () => ({
    billId: bill.id,
    visitId: bill.visit_id,
    kind: form.value.kind,
    value: form.value.value.trim(),
    reason: form.value.reason.trim(),
    line_id: form.lineId || null,
    payback,
  });

  const review = async (event) => {
    event.preventDefault();
    setError(null);
    try {
      setChecked(await preview.mutateAsync(body()));
    } catch (e) {
      setError(errorOf(e, "That discount could not be worked out"));
    }
  };

  const confirm = async () => {
    setError(null);
    try {
      const made = await give.mutateAsync(body());
      onBill(await reread.mutateAsync({ billId: bill.id }));
      setDone(
        `Credit note ${made.credit_note_no} made for ${fromPaise(made.amount)}` +
          (made.pay_back > 0
            ? DONE_TEXT[made.payback](made)
            : " — it came off what is still owed."),
      );
      setChecked(null);
      setForm(null);
    } catch (e) {
      setError(errorOf(e, "The discount could not be given"));
    }
  };

  const target = form?.lineId
    ? bill.lines.find((line) => line.id === form.lineId)?.bill_name
    : "the whole bill";

  return (
    <div className="bc-mdisc__bill" role="group" aria-label="Discount on this final bill">
      {done && (
        <div className="bc-note" role="status">
          {done}
        </div>
      )}
      {!form ? (
        <button
          type="button"
          className="st-btn st-btn-g"
          onClick={() => {
            setError(null);
            setDone(null);
            setForm({ lineId: WHOLE_BILL, value: discountDraft(null) });
          }}
        >
          + Discount on this final bill
        </button>
      ) : (
        <form className="bc-mdisc__form" onSubmit={review}>
          <p className="bc-hint">
            The bill is final, so this makes a discount credit note. A % sets the total discount as
            a share of the full bill — what was already given is taken off. If the patient has
            already paid, the difference is paid back to them the way they paid.
          </p>
          <label className="bc-field">
            <span className="bc-field__lbl">Applies to</span>
            <select
              className="bc-field__in"
              value={form.lineId}
              onChange={(e) => setForm({ ...form, lineId: e.target.value })}
            >
              <option value={WHOLE_BILL}>Whole bill</option>
              {bill.lines
                .filter((line) => line.patient_payable > 0)
                .map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.bill_name} · {fromPaise(line.patient_payable)}
                  </option>
                ))}
            </select>
          </label>
          <ManualDiscountFields
            id="bc-final-discount"
            value={form.value}
            onChange={(value) => setForm({ ...form, value })}
          />
          <div className="bc-head__row">
            <button
              type="submit"
              className="st-btn st-btn-grn"
              disabled={Boolean(discountProblem(form.value)) || preview.isPending}
            >
              {preview.isPending ? "Checking…" : "Review discount"}
            </button>
            <button type="button" className="st-btn st-btn-g" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && !checked && <div className="bc-err">{error}</div>}

      <ConfirmModal
        open={Boolean(checked)}
        title="Give this discount?"
        variant="primary"
        confirmLabel={give.isPending ? "Giving discount…" : "Give discount"}
        busy={give.isPending}
        error={error}
        message={
          checked && (
            <div className="bc-cc">
              <dl className="bc-cc__who">
                <div>
                  <dt>Patient</dt>
                  <dd>
                    {patient?.name || "—"}
                    {patient?.fileNo ? ` · ${patient.fileNo}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Bill</dt>
                  <dd>{bill.bill_no}</dd>
                </div>
                <div>
                  <dt>On</dt>
                  <dd>{target}</dd>
                </div>
              </dl>
              <dl className="bc-cc__money" aria-label="Discount worked out">
                {form?.value?.kind === "percent" && (
                  <>
                    <div>
                      <dt>Full amount</dt>
                      <dd>{fromPaise(checked.gross)}</dd>
                    </div>
                    <div>
                      <dt>{form.value.value}% of it</dt>
                      <dd>{fromPaise(checked.amount + checked.already_given)}</dd>
                    </div>
                    <div>
                      <dt>Already given</dt>
                      <dd>−{fromPaise(checked.already_given)}</dd>
                    </div>
                  </>
                )}
                <div className="bc-cc__total">
                  <dt>Discount now</dt>
                  <dd>{fromPaise(checked.amount)}</dd>
                </div>
                <div>
                  <dt>Comes off what is owed</dt>
                  <dd>{fromPaise(checked.off_balance)}</dd>
                </div>
                <div className="bc-cc__total">
                  <dt>To pay back</dt>
                  <dd>{fromPaise(checked.pay_back)}</dd>
                </div>
              </dl>
              {checked.pay_back > 0 && (
                <fieldset className="bc-cc__choices">
                  <legend className="bc-field__lbl">
                    How {fromPaise(checked.pay_back)} goes back to the patient
                  </legend>
                  {PAYBACK.map((option) => (
                    <label key={option.value} className="bc-cc__choice">
                      <input
                        type="radio"
                        name="bc-final-payback"
                        value={option.value}
                        checked={payback === option.value}
                        onChange={() => setPayback(option.value)}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <small>{option.hint}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}
              <p className="bc-cc__warn">
                A discount credit note will be made. It can't be undone; to reverse it, bill the
                amount again.
              </p>
            </div>
          )
        }
        onConfirm={confirm}
        onCancel={() => {
          if (!give.isPending) setChecked(null);
        }}
      />
    </div>
  );
}
