import { useState } from "react";
import MasterFormDialog from "./MasterFormDialog";
import FormField from "../ui/FormField";
import { SelectInput, optionsOf } from "./Fields";
import { requestErrorOf } from "../billing/format";
import { inr } from "./format";
import { toast } from "../../stores/uiStore";
import {
  useAddVoucher,
  useReceiveDeposit,
  useRefundDeposit,
  useWriteOff,
} from "../../queries/hooks/usePharmacyAccounts";
import { toPaise } from "../../../shared/pharmacyMoney";
import { UPI_APP_LABEL } from "../../../shared/billingVocab";
import { PAYMENT_MODE_LABEL, PAYMENT_MODES } from "../../../shared/pharmacyVocab";

const moneyTyped = (v) => {
  const clean = v.replace(/[^\d.]/g, "");
  const [whole, ...rest] = clean.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
};

function useFields(initial) {
  const [values, setValues] = useState(initial);
  const set = (key, clean) => (e) =>
    setValues((v) => ({ ...v, [key]: clean ? clean(e.target.value) : e.target.value }));
  const pick = (key) => (value) => setValues((v) => ({ ...v, [key]: value }));
  return [values, set, pick];
}

function AmountField({ value, onChange, error, label = "Amount (₹)", hint }) {
  return (
    <FormField label={label} required error={error} hint={hint}>
      <input
        className="jb-assign phs-num"
        inputMode="decimal"
        maxLength={12}
        autoFocus
        value={value}
        onChange={onChange}
      />
    </FormField>
  );
}

function ReasonField({ value, onChange, error, required = true, label = "Reason" }) {
  return (
    <FormField label={label} required={required} error={error} className="phv-span-all">
      <input className="jb-assign" maxLength={300} value={value} onChange={onChange} />
    </FormField>
  );
}

export function DepositDialog({ account, refund = false, onClose }) {
  const receive = useReceiveDeposit();
  const giveBack = useRefundDeposit();
  const mutation = refund ? giveBack : receive;
  const [v, set, pick] = useFields({
    mode: "cash",
    amount: "",
    reference: "",
    upi_app: "",
    reason: "",
  });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const amount = toPaise(v.amount);
  const balance = toPaise(account.balance);

  const problems = {};
  if (!(amount > 0)) problems.amount = "Enter an amount more than 0.";
  else if (refund && amount > balance) problems.amount = `Only ${inr(account.balance)} is left.`;
  if (v.mode !== "cash" && !v.reference.trim()) problems.reference = "Enter the reference.";
  if (v.mode === "upi" && !v.upi_app) problems.upi_app = "Choose the UPI app.";
  if (refund && v.reason.trim().length < 3) problems.reason = "Say why it is refunded.";
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      const after = await mutation.mutateAsync({
        target: account.id,
        mode: v.mode,
        amount: amount / 100,
        reference: v.mode === "cash" ? null : v.reference.trim(),
        upi_app: v.mode === "upi" ? v.upi_app : null,
        reason: v.reason.trim() || null,
      });
      toast(
        refund
          ? `Deposit refunded. ${inr(after.balance)} is left.`
          : `Deposit received. ${account.name} now has ${inr(after.balance)} in the pharmacy deposit.`,
      );
      onClose();
    } catch (err) {
      setError(
        requestErrorOf(err, refund ? "Could not refund the deposit" : "Could not save the deposit"),
      );
    }
  };

  return (
    <MasterFormDialog
      title={refund ? "Refund deposit" : "Receive deposit"}
      intro={
        <p className="phs-meta">
          {account.name} ({account.file_no ?? "—"}) · deposit balance {inr(account.balance)}
        </p>
      }
      dirty={Boolean(v.amount || v.reason)}
      busy={mutation.isPending}
      error={error}
      submitLabel={refund ? `Refund ${inr(amount / 100)}` : `Receive ${inr(amount / 100)}`}
      onSubmit={submit}
      onClose={onClose}
      wide={false}
    >
      <div className="bill-form">
        <FormField label={refund ? "Refund by" : "Mode"} required>
          <SelectInput
            value={v.mode}
            onChange={pick("mode")}
            options={PAYMENT_MODES.map((m) => ({ value: m, label: PAYMENT_MODE_LABEL[m] }))}
          />
        </FormField>
        <AmountField value={v.amount} onChange={set("amount", moneyTyped)} error={errors.amount} />
        {v.mode === "upi" ? (
          <FormField label="UPI app" required error={errors.upi_app}>
            <SelectInput
              value={v.upi_app}
              onChange={pick("upi_app")}
              options={[{ value: "", label: "Choose" }, ...optionsOf(UPI_APP_LABEL)]}
            />
          </FormField>
        ) : null}
        {v.mode !== "cash" ? (
          <FormField label="Reference" required error={errors.reference}>
            <input
              className="jb-assign"
              maxLength={60}
              value={v.reference}
              onChange={set("reference")}
            />
          </FormField>
        ) : null}
        <ReasonField
          label={refund ? "Reason" : "Note"}
          required={refund}
          value={v.reason}
          onChange={set("reason")}
          error={errors.reason}
        />
      </div>
    </MasterFormDialog>
  );
}

export function VoucherDialog({ account, onClose }) {
  const add = useAddVoucher();
  const [v, set, pick] = useFields({ kind: "credit", amount: "", reason: "" });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const amount = toPaise(v.amount);

  const problems = {};
  if (!(amount > 0)) problems.amount = "Enter an amount more than 0.";
  else if (v.kind === "debit" && amount > toPaise(account.balance))
    problems.amount = `A debit cannot take the account below zero; ${inr(account.balance)} is left.`;
  if (v.reason.trim().length < 3) problems.reason = "Say why this voucher is made.";
  const errors = touched ? problems : {};

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length) return;
    try {
      const after = await add.mutateAsync({
        target: account.id,
        kind: v.kind,
        amount: amount / 100,
        reason: v.reason.trim(),
      });
      toast(`Voucher saved. Account balance is now ${inr(after.balance)}.`);
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not save the voucher"));
    }
  };

  return (
    <MasterFormDialog
      title="Manual voucher"
      intro={
        <p className="phs-meta">
          {account.name} ({account.file_no ?? "—"}) · account balance {inr(account.balance)}. A
          credit adds to the balance the patient can use on bills; a debit takes from it.
        </p>
      }
      dirty={Boolean(v.amount || v.reason)}
      busy={add.isPending}
      error={error}
      submitLabel="Save voucher"
      onSubmit={submit}
      onClose={onClose}
      wide={false}
    >
      <div className="bill-form">
        <FormField label="Voucher type" required>
          <SelectInput
            value={v.kind}
            onChange={pick("kind")}
            options={[
              { value: "credit", label: "Credit (add to the account)" },
              { value: "debit", label: "Debit (take from the account)" },
            ]}
          />
        </FormField>
        <AmountField value={v.amount} onChange={set("amount", moneyTyped)} error={errors.amount} />
        <ReasonField value={v.reason} onChange={set("reason")} error={errors.reason} />
      </div>
    </MasterFormDialog>
  );
}

export function WriteOffDialog({ bill, onClose }) {
  const writeOff = useWriteOff();
  const [v, set] = useFields({ amount: String(Number(bill.due_amount)), reason: "" });
  const [touched, setTouched] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const amount = toPaise(v.amount);

  const problems = {};
  if (!(amount > 0)) problems.amount = "Enter an amount more than 0.";
  else if (amount > toPaise(bill.due_amount))
    problems.amount = `At most ${inr(bill.due_amount)} is due.`;
  if (v.reason.trim().length < 3) problems.reason = "Say why this money will not be collected.";
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
      await writeOff.mutateAsync({
        target: bill.id,
        amount: amount / 100,
        reason: v.reason.trim(),
      });
      toast(`${inr(amount / 100)} written off on bill ${bill.bill_no}.`);
      onClose();
    } catch (err) {
      setConfirming(false);
      setError(requestErrorOf(err, "Could not write off the due"));
    }
  };

  return (
    <MasterFormDialog
      title={`Write off · Bill ${bill.bill_no}`}
      intro={<p className="phs-meta">{inr(bill.due_amount)} is due on this bill.</p>}
      dirty={Boolean(v.reason)}
      busy={writeOff.isPending}
      error={error}
      submitLabel={confirming ? `Confirm write-off of ${inr(amount / 100)}` : "Review"}
      onSubmit={submit}
      onClose={onClose}
      wide={false}
    >
      <div className="bill-form">
        <AmountField value={v.amount} onChange={set("amount", moneyTyped)} error={errors.amount} />
        <ReasonField value={v.reason} onChange={set("reason")} error={errors.reason} />
      </div>
      {confirming ? (
        <p className="adj-change" role="alert">
          {inr(amount / 100)} on bill {bill.bill_no} will no longer be collected. This is recorded
          with your name and cannot be undone.
        </p>
      ) : null}
    </MasterFormDialog>
  );
}
