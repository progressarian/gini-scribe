import { useEffect, useState } from "react";
import MasterFormDialog from "./MasterFormDialog";
import FormField from "../ui/FormField";
import BillPayments, { paymentProblems, paymentsForApi } from "./BillPayments";
import { requestErrorOf } from "../billing/format";
import { inr, showDate } from "./format";
import { toast } from "../../stores/uiStore";
import {
  useAskCredit,
  useCollectDue,
  useDecideCredit,
  usePatientCreditHistory,
} from "../../queries/hooks/usePharmacyCredit";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney";
import { CREDIT_STATUS_LABEL } from "../../../shared/pharmacyVocab";

const moneyTyped = (v) => {
  const clean = v.replace(/[^\d.]/g, "");
  const [whole, ...rest] = clean.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
};

function Facts({ items }) {
  return (
    <dl className="adj-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LimitLine({ history }) {
  if (!history) {
    return (
      <p className="phs-meta" role="status">
        Checking the patient&apos;s credit…
      </p>
    );
  }
  if (history.credit_limit === null) {
    return (
      <p className="phb-limit" role="status">
        No credit limit is set. This patient owes {inr(history.due)}
        {Number(history.reserved) ? `, with ${inr(history.reserved)} more approved` : ""}.
      </p>
    );
  }
  const full = Number(history.room) <= 0;
  return (
    <p className={`phb-limit${full ? " is-off" : ""}`} role="status">
      Credit limit {inr(history.credit_limit)} · owes {inr(history.due)}
      {Number(history.reserved)
        ? ` · ${inr(history.reserved)} approved, not yet billed`
        : ""} ·{" "}
      <strong>
        {full ? "no more credit can be given" : `up to ${inr(history.room)} more can be given`}
      </strong>
    </p>
  );
}

function CreditHistory({ history, currentId }) {
  const past = history.requests.filter((r) => r.id !== currentId);
  return (
    <section className="phb-history" aria-label="Patient's credit record">
      <p className="phs-meta">
        {history.credit_bills
          ? `${history.credit_bills} bill${history.credit_bills === 1 ? "" : "s"} on credit before, ${history.credit_bills_paid_off} paid off.`
          : "No credit given to this patient before."}
      </p>
      {history.open_bills.length ? (
        <table className="flow-table phs-table" aria-label="Bills still due">
          <thead>
            <tr>
              <th>Bill still due</th>
              <th className="phs-num">Days</th>
              <th className="phs-num">Due</th>
            </tr>
          </thead>
          <tbody>
            {history.open_bills.map((b) => (
              <tr key={b.id}>
                <td data-label="Bill">
                  <span className="phv-mono">{b.bill_no}</span>
                  <span className="phs-meta">{showDate(b.bill_date)}</span>
                </td>
                <td data-label="Days" className="phs-num">
                  {b.age_days}
                </td>
                <td data-label="Due" className="phs-num phb-due">
                  {inr(b.due_amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {past.length ? (
        <table className="flow-table phs-table" aria-label="Earlier credit requests">
          <thead>
            <tr>
              <th>Earlier request</th>
              <th className="phs-num">Asked</th>
              <th className="phs-num">Approved</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {past.map((r) => (
              <tr key={r.id}>
                <td data-label="Request">
                  {showDate(String(r.requested_at).slice(0, 10))}
                  <span className="phs-meta">
                    {r.bill_no ?? "Draft bill"} · {r.reason}
                  </span>
                </td>
                <td data-label="Asked" className="phs-num">
                  {inr(r.amount)}
                </td>
                <td data-label="Approved" className="phs-num">
                  {r.approved_amount ? inr(r.approved_amount) : "—"}
                </td>
                <td data-label="Outcome">
                  {CREDIT_STATUS_LABEL[r.status]}
                  {r.decided_by_name ? <span className="phs-meta">{r.decided_by_name}</span> : null}
                  {r.decision_note ? <span className="phs-meta">{r.decision_note}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}

export function AskCreditDialog({ bill, onClose }) {
  const history = usePatientCreditHistory(bill.patient_id).data;
  const ask = useAskCredit();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const net = toPaise(bill.net_amount);
  const wanted = toPaise(amount);

  const problems = {};
  if (!(wanted > 0)) problems.amount = "Enter the amount the patient will pay later.";
  else if (wanted > net) problems.amount = `Credit cannot be more than ${inr(bill.net_amount)}.`;
  else if (history?.room !== null && history?.room !== undefined && wanted > toPaise(history.room))
    problems.amount = Number(history.room)
      ? `The credit limit allows at most ${inr(history.room)} more for this patient.`
      : "This patient has reached the credit limit. Collect what is due first.";
  if (reason.trim().length < 3) problems.reason = "Say why the patient cannot pay now.";
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      await ask.mutateAsync({
        billId: bill.id,
        version: bill.version,
        amount: wanted / 100,
        reason: reason.trim(),
      });
      toast("Credit request sent for approval.");
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not send the credit request"));
    }
  };

  return (
    <MasterFormDialog
      title="Ask for credit"
      intro={
        <>
          <Facts
            items={[
              ["Patient", `${bill.patient_name} (${bill.patient_file_no ?? "—"})`],
              ["Bill total", inr(bill.net_amount)],
              ["Already due", inr(bill.patient_due)],
            ]}
          />
          <LimitLine history={history} />
        </>
      }
      dirty={Boolean(amount || reason)}
      busy={ask.isPending}
      error={error}
      submitLabel="Send for approval"
      onSubmit={submit}
      onClose={onClose}
      wide={false}
    >
      <div className="bill-form">
        <FormField
          label="Amount to pay later (₹)"
          required
          error={errors.amount}
          hint={wanted > 0 && wanted <= net ? `Collect ${inr(toRupees(net - wanted))} now` : null}
        >
          <input
            className="jb-assign phs-num"
            inputMode="decimal"
            maxLength={12}
            autoFocus
            value={amount}
            onChange={(e) => setAmount(moneyTyped(e.target.value))}
          />
        </FormField>
        <FormField label="Reason" required error={errors.reason} className="phv-span-all">
          <textarea
            className="jb-assign"
            rows={2}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </FormField>
      </div>
      <p className="phs-meta">
        The bill stays as a draft and cannot be changed until the pharmacy admin approves or refuses
        the credit.
      </p>
    </MasterFormDialog>
  );
}

export function DecideCreditDialog({ request, decision, onClose }) {
  const decide = useDecideCredit();
  const approving = decision === "approve";
  const history = usePatientCreditHistory(request.patient_id).data;
  const [amount, setAmount] = useState(approving ? String(Number(request.amount)) : "");
  const [fitted, setFitted] = useState(false);
  useEffect(() => {
    if (!approving || fitted || !history) return;
    setFitted(true);
    if (history.room !== null && toPaise(history.room) < toPaise(request.amount)) {
      setAmount(toPaise(history.room) ? String(Number(history.room)) : "");
    }
  }, [approving, fitted, history, request.amount]);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const asked = toPaise(request.amount);
  const approved = toPaise(amount);

  const problems = {};
  if (approving && !(approved > 0)) problems.amount = "Enter the credit to approve.";
  else if (approving && approved > asked)
    problems.amount = `Approve at most the ${inr(request.amount)} asked for.`;
  else if (
    approving &&
    history?.room !== null &&
    history?.room !== undefined &&
    approved > toPaise(history.room)
  )
    problems.amount = Number(history.room)
      ? `The credit limit allows at most ${inr(history.room)} for this patient.`
      : "This patient has reached the credit limit. Refuse, or collect what is due first.";
  if (!approving && note.trim().length < 3) problems.note = "Say why the credit is refused.";
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      await decide.mutateAsync({
        id: request.id,
        decision,
        approved_amount: approving ? approved / 100 : null,
        note: note.trim() || null,
      });
      toast(
        approving
          ? `Credit of ${inr(toRupees(approved))} approved for ${request.patient_name}.`
          : `Credit refused for ${request.patient_name}.`,
      );
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not save the decision"));
    }
  };

  return (
    <MasterFormDialog
      title={approving ? "Approve credit" : "Refuse credit"}
      intro={
        <Facts
          items={[
            ["Patient", `${request.patient_name} (${request.patient_file_no ?? "—"})`],
            ["Bill total", inr(request.bill_amount)],
            ["Asked to pay later", inr(request.amount)],
            ["Already due from earlier bills", inr(request.patient_due)],
            ["Reason given", request.reason],
            ["Asked by", request.requested_by_name ?? "—"],
          ]}
        />
      }
      dirty={Boolean(note)}
      busy={decide.isPending}
      error={error}
      submitLabel={approving ? "Approve credit" : "Refuse credit"}
      onSubmit={submit}
      onClose={onClose}
    >
      <LimitLine history={history} />
      {history ? <CreditHistory history={history} currentId={request.id} /> : null}
      <div className="bill-form">
        {approving ? (
          <FormField
            label="Credit approved (₹)"
            required
            error={errors.amount}
            hint={
              approved > 0 && approved <= asked
                ? `The patient pays at least ${inr(toRupees(toPaise(request.bill_amount) - approved))} now`
                : null
            }
          >
            <input
              className="jb-assign phs-num"
              inputMode="decimal"
              maxLength={12}
              value={amount}
              onChange={(e) => setAmount(moneyTyped(e.target.value))}
            />
          </FormField>
        ) : null}
        <FormField
          label={approving ? "Note" : "Why it is refused"}
          required={!approving}
          error={errors.note}
          className="phv-span-all"
        >
          <textarea
            className="jb-assign"
            rows={2}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </FormField>
      </div>
    </MasterFormDialog>
  );
}

export function CollectDueDialog({ bill, onClose }) {
  const collect = useCollectDue();
  const [rows, setRows] = useState([
    { mode: "cash", amount: toRupees(toPaise(bill.due_amount)), reference: "", upi_app: "" },
  ]);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const due = toPaise(bill.due_amount);
  const check = paymentProblems(
    rows,
    bill.due_amount,
    toRupees(Math.max(due - 1, 0)),
    bill.patient_balance ?? 0,
  );

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (!check.ok) return;
    try {
      const after = await collect.mutateAsync({
        billId: bill.id,
        version: bill.version,
        payments: paymentsForApi(rows),
      });
      toast(
        Number(after.due_amount)
          ? `Collected. ${inr(after.due_amount)} is still due on ${after.bill_no}.`
          : `Collected. Bill ${after.bill_no} is fully paid.`,
      );
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not collect the payment"));
    }
  };

  return (
    <MasterFormDialog
      title={`Collect due · Bill ${bill.bill_no}`}
      intro={
        <Facts
          items={[
            ["Patient", `${bill.patient_name} (${bill.patient_file_no ?? "—"})`],
            ["Bill total", inr(bill.net_amount)],
            ["Due now", inr(bill.due_amount)],
          ]}
        />
      }
      dirty={touched}
      busy={collect.isPending}
      error={error}
      submitLabel={`Collect ${inr(toRupees(due - check.gap))}`}
      onSubmit={submit}
      onClose={onClose}
    >
      <BillPayments
        rows={rows}
        net={bill.due_amount}
        shortBy={toRupees(Math.max(due - 1, 0))}
        depositBalance={bill.patient_balance ?? 0}
        onChange={setRows}
        showErrors={touched}
        totalLabel="the amount due"
        legend="Collect"
      />
    </MasterFormDialog>
  );
}
