import { useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import {
  useDiscountFinalBill,
  usePreviewFinalDiscount,
  useRereadBill,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";
import ManualDiscountFields, { discountDraft, discountProblem } from "./ManualDiscountFields";

const WHOLE_BILL = "";

export default function FinalBillDiscount({ bill, patient, onBill }) {
  const preview = usePreviewFinalDiscount();
  const give = useDiscountFinalBill();
  const reread = useRereadBill();
  const [form, setForm] = useState(null);
  const [checked, setChecked] = useState(null);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  if (bill.status !== "final" || bill.bill_type !== "invoice") return null;

  const body = () => ({
    billId: bill.id,
    visitId: bill.visit_id,
    kind: form.value.kind,
    value: form.value.value.trim(),
    reason: form.value.reason.trim(),
    line_id: form.lineId || null,
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
            ? ` — ${fromPaise(made.pay_back)} to pay back to the patient (Pay out under Refunds).`
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
            The bill is final, so this makes a discount credit note. If the patient has already
            paid, the discount is paid back to them the way they paid.
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
            <div className="bc-mdisc">
              <dl className="bc-pay__mini">
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
                <div>
                  <dt>Discount</dt>
                  <dd>{fromPaise(checked.amount)}</dd>
                </div>
                <div>
                  <dt>Comes off what is owed</dt>
                  <dd>{fromPaise(checked.off_balance)}</dd>
                </div>
                <div className="bc-pay__left">
                  <dt>To pay back</dt>
                  <dd>{fromPaise(checked.pay_back)}</dd>
                </div>
              </dl>
              <p className="bc-hint">
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
