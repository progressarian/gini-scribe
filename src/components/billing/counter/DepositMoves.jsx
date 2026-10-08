import { useEffect, useState } from "react";
import useAuthStore from "../../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../../shared/permissions";
import {
  depositSlipPdfHref,
  useDepositPatientSearch,
  usePayOutDepositRefund,
  useRequestDepositRefund,
  useTransferDeposit,
  useTransferDepositToIpd,
  useUploadDepositConsent,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise, moneyTyped } from "../format";
import { PAYMENT_MODE_LABEL } from "./lineText";
import { readFile } from "./PatientHeader";
import { PdfButton } from "./PdfViewer";

const CONSENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const REFERENCE_HINT = { card: "Card reversal slip no.", upi: "UPI transaction ID" };
const paiseOf = (typed) => Math.round(Number(typed || 0) * 100);
const idLine = (patient) =>
  [patient?.file_no, patient?.health_id, patient?.phone].filter(Boolean).join(" · ") || "—";

function AmountField({ value, available, onChange }) {
  const [capped, setCapped] = useState(false);
  return (
    <label className="bc-field">
      <span className="bc-field__lbl">Amount * (up to {fromPaise(available)})</span>
      <span className="bc-pay__money">
        <span aria-hidden="true">₹</span>
        <input
          className="bc-field__in"
          inputMode="decimal"
          value={value}
          aria-invalid={capped}
          onChange={(e) => {
            const typed = moneyTyped(e.target.value);
            const over = paiseOf(typed) > available;
            setCapped(over);
            onChange(over ? String(available / 100) : typed);
          }}
        />
      </span>
      {capped && (
        <span className="bc-err" role="alert">
          Only {fromPaise(available)} is in the deposit, so the amount is set to that.
        </span>
      )}
    </label>
  );
}

function Done({ result, onClose }) {
  return (
    <div className="bc-note" role="status">
      {result.text}{" "}
      {result.entryId && (
        <PdfButton
          className="st-btn st-btn-g"
          href={depositSlipPdfHref(result.entryId)}
          title={result.title}
          fileName={`${result.title.replace(/\s+/g, "_")}.pdf`}
        >
          Print slip
        </PdfButton>
      )}{" "}
      <button type="button" className="st-btn st-btn-g" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function ToPatient({ patient, available, onDone }) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [to, setTo] = useState(null);
  const [form, setForm] = useState({ amount: "", relationship: "", reason: "" });
  const [file, setFile] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const { data: found, isFetching } = useDepositPatientSearch(debounced);
  const upload = useUploadDepositConsent();
  const move = useTransferDeposit();
  const amount = paiseOf(form.amount);
  const busy = upload.isPending || move.isPending;
  const ready =
    to &&
    amount > 0 &&
    amount <= available &&
    form.relationship.trim() &&
    form.reason.trim() &&
    file &&
    !busy;

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

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
    try {
      const consent = await upload.mutateAsync({
        patientId: patient.id,
        base64: await readFile(file),
        mediaType: file.type,
        fileName: file.name,
      });
      const moved = await move.mutateAsync({
        patientId: patient.id,
        to_patient_id: to.id,
        amount: form.amount.trim(),
        relationship: form.relationship.trim(),
        reason: form.reason.trim(),
        consent_document_id: consent.document_id,
      });
      onDone({
        text: `Moved ${fromPaise(moved.amount)} to ${moved.to.name} — slip ${moved.slip_no}. ${patient.name}'s deposit is now ${fromPaise(moved.from.balance)}.`,
        entryId: moved.entry_id,
        title: `Deposit transfer ${moved.slip_no}`,
      });
    } catch (e) {
      setConfirming(false);
      setError(errorOf(e, "The deposit could not be moved"));
    }
  };

  const others = (found || []).filter((row) => row.id !== patient.id);

  return (
    <form
      className="bc-deposit__form"
      onSubmit={submit}
      aria-label="Move deposit to another patient"
    >
      {!to ? (
        <div className="bc-deposit__note">
          <label className="bc-field">
            <span className="bc-field__lbl">Move to patient *</span>
            <input
              className="bc-field__in"
              type="search"
              value={search}
              placeholder="Search by patient name, file no. or phone"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {debounced.length >= 2 && (
            <ul className="bc-deposit__people" aria-label="Matching patients">
              {isFetching && !others.length ? <li className="bc-hint">Searching…</li> : null}
              {!isFetching && !others.length ? (
                <li className="bc-hint">No other patient matches “{debounced}”.</li>
              ) : null}
              {others.map((row) => (
                <li key={row.id}>
                  <button type="button" className="bc-deposit__person" onClick={() => setTo(row)}>
                    <strong>{row.name}</strong>
                    <span className="bc-hint">
                      {idLine(row)}
                      {row.age
                        ? ` · ${row.age}${row.sex ? `/${String(row.sex).charAt(0)}` : ""}`
                        : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="bc-deposit__pair bc-deposit__note" aria-label="The two patients">
          <div>
            <div className="bc-field__lbl">From (depositor)</div>
            <strong>{patient.name}</strong>
            <div className="bc-hint">{idLine(patient)}</div>
          </div>
          <div>
            <div className="bc-field__lbl">To</div>
            <strong>{to.name}</strong>
            <div className="bc-hint">{idLine(to)}</div>
            <button
              type="button"
              className="st-btn st-btn-g"
              onClick={() => {
                setTo(null);
                setConfirming(false);
              }}
            >
              Change
            </button>
          </div>
        </div>
      )}
      <AmountField
        value={form.amount}
        available={available}
        onChange={(amount) => change({ amount })}
      />
      <label className="bc-field">
        <span className="bc-field__lbl">Relationship *</span>
        <input
          className="bc-field__in"
          maxLength={60}
          placeholder="e.g. mother, son, friend"
          value={form.relationship}
          onChange={(e) => change({ relationship: e.target.value })}
        />
      </label>
      <label className="bc-field bc-deposit__note">
        <span className="bc-field__lbl">Reason *</span>
        <input
          className="bc-field__in"
          maxLength={300}
          value={form.reason}
          onChange={(e) => change({ reason: e.target.value })}
        />
      </label>
      <label className="bc-field bc-deposit__note">
        <span className="bc-field__lbl">
          Signed consent of {patient.name} * (photo or PDF, up to 5 MB)
        </span>
        <input
          className="bc-field__in"
          type="file"
          accept={CONSENT_TYPES.join(",")}
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            setError(
              picked && !CONSENT_TYPES.includes(picked.type)
                ? "Upload the consent as a photo (JPG, PNG or WebP) or a PDF"
                : null,
            );
            setFile(picked && CONSENT_TYPES.includes(picked.type) ? picked : null);
            setConfirming(false);
          }}
        />
      </label>
      {confirming && to && (
        <div className="bc-note" role="status">
          Move {fromPaise(amount)} from {patient.name} to {to.name}? {patient.name}'s deposit
          becomes {fromPaise(available - amount)}. Only a transfer back can reverse this.
        </div>
      )}
      {error && (
        <div className="bc-err" role="alert">
          {error}
        </div>
      )}
      <div className="bc-head__row">
        <button type="submit" className="st-btn st-btn-grn" disabled={!ready}>
          {busy ? "Moving…" : confirming ? "Confirm move" : "Move deposit"}
        </button>
      </div>
    </form>
  );
}

function ToIpd({ patient, available, onDone }) {
  const [form, setForm] = useState({ amount: "", ipd: "", reason: "" });
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const move = useTransferDepositToIpd();
  const amount = paiseOf(form.amount);
  const ready =
    amount > 0 && amount <= available && form.ipd.trim() && form.reason.trim() && !move.isPending;

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
    try {
      const moved = await move.mutateAsync({
        patientId: patient.id,
        amount: form.amount.trim(),
        ipd_number: form.ipd.trim(),
        reason: form.reason.trim(),
      });
      onDone({
        text: `Moved ${fromPaise(moved.amount)} to IPD ${form.ipd.trim()} — slip ${moved.slip_no}. Give the slip to the IPD desk to enter in HealthRay.`,
        entryId: moved.entry_id,
        title: `Deposit to IPD ${moved.slip_no}`,
      });
    } catch (e) {
      setConfirming(false);
      setError(errorOf(e, "The deposit could not be moved to IPD"));
    }
  };

  return (
    <form className="bc-deposit__form" onSubmit={submit} aria-label="Move deposit to IPD">
      <AmountField
        value={form.amount}
        available={available}
        onChange={(amount) => change({ amount })}
      />
      <label className="bc-field">
        <span className="bc-field__lbl">HealthRay IP / admission no. *</span>
        <input
          className="bc-field__in"
          maxLength={40}
          value={form.ipd}
          onChange={(e) => change({ ipd: e.target.value })}
        />
      </label>
      <label className="bc-field bc-deposit__note">
        <span className="bc-field__lbl">Reason *</span>
        <input
          className="bc-field__in"
          maxLength={300}
          placeholder="e.g. admitted under Dr …"
          value={form.reason}
          onChange={(e) => change({ reason: e.target.value })}
        />
      </label>
      {confirming && (
        <div className="bc-note" role="status">
          Move {fromPaise(amount)} of {patient.name}'s deposit to IPD admission {form.ipd.trim()}?
          Their deposit becomes {fromPaise(available - amount)}.
        </div>
      )}
      {error && (
        <div className="bc-err" role="alert">
          {error}
        </div>
      )}
      <div className="bc-head__row">
        <button type="submit" className="st-btn st-btn-grn" disabled={!ready}>
          {move.isPending ? "Moving…" : confirming ? "Confirm move to IPD" : "Move to IPD"}
        </button>
      </div>
    </form>
  );
}

function PayBack({ patient, available, openRefund, onDone }) {
  const [form, setForm] = useState({ amount: "", mode: "cash", reason: "" });
  const [reference, setReference] = useState("");
  const [error, setError] = useState(null);
  const ask = useRequestDepositRefund();
  const pay = usePayOutDepositRefund();
  const amount = paiseOf(form.amount);

  if (openRefund?.status === "pending") {
    return (
      <div className="bc-hint" role="status">
        A refund of {fromPaise(openRefund.amount)} by{" "}
        {PAYMENT_MODE_LABEL[openRefund.requested_mode]} is waiting for approval. The amount is held
        until it is approved and paid, or rejected.
      </div>
    );
  }

  if (openRefund?.status === "approved") {
    const mode = openRefund.approved_mode;
    const needsReference = mode !== "cash";
    const payOut = async () => {
      setError(null);
      try {
        const paid = await pay.mutateAsync({
          requestId: openRefund.id,
          ...(reference.trim() ? { reference: reference.trim() } : {}),
        });
        onDone({
          text: `Paid back ${fromPaise(paid.amount)} by ${PAYMENT_MODE_LABEL[paid.mode]}. Deposit now ${fromPaise(paid.balance)}.`,
          entryId: paid.entry_id,
          title: "Deposit refund receipt",
        });
      } catch (e) {
        setError(errorOf(e, "The refund could not be paid out"));
      }
    };
    return (
      <div className="bc-deposit__form">
        <div className="bc-note bc-deposit__note" role="status">
          Approved: pay back {fromPaise(openRefund.amount)} to {patient.name} by{" "}
          {PAYMENT_MODE_LABEL[mode]}.
        </div>
        {needsReference && (
          <label className="bc-field">
            <span className="bc-field__lbl">Reference *</span>
            <input
              className="bc-field__in"
              maxLength={60}
              placeholder={REFERENCE_HINT[mode]}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </label>
        )}
        {error && (
          <div className="bc-err bc-deposit__note" role="alert">
            {error}
          </div>
        )}
        <div className="bc-head__row">
          <button
            type="button"
            className="st-btn st-btn-grn"
            disabled={pay.isPending || (needsReference && !reference.trim())}
            onClick={payOut}
          >
            {pay.isPending ? "Paying back…" : `Pay back ${fromPaise(openRefund.amount)}`}
          </button>
        </div>
      </div>
    );
  }

  const ready = amount > 0 && amount <= available && form.reason.trim() && !ask.isPending;
  const submit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setError(null);
    try {
      await ask.mutateAsync({
        patientId: patient.id,
        amount: form.amount.trim(),
        mode: form.mode,
        reason: form.reason.trim(),
      });
      onDone({
        text: `Refund of ${fromPaise(amount)} sent for approval. The amount is held until then.`,
      });
    } catch (e) {
      setError(errorOf(e, "The refund could not be requested"));
    }
  };

  return (
    <form className="bc-deposit__form" onSubmit={submit} aria-label="Ask to pay the deposit back">
      <AmountField
        value={form.amount}
        available={available}
        onChange={(amount) => setForm((was) => ({ ...was, amount }))}
      />
      <label className="bc-field">
        <span className="bc-field__lbl">Pay back by</span>
        <select
          className="bc-field__in"
          value={form.mode}
          onChange={(e) => setForm((was) => ({ ...was, mode: e.target.value }))}
        >
          {Object.entries(PAYMENT_MODE_LABEL).map(([mode, label]) => (
            <option key={mode} value={mode}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label className="bc-field bc-deposit__note">
        <span className="bc-field__lbl">Reason *</span>
        <input
          className="bc-field__in"
          maxLength={300}
          value={form.reason}
          onChange={(e) => setForm((was) => ({ ...was, reason: e.target.value }))}
        />
      </label>
      <p className="bc-hint bc-deposit__note">
        A second person (admin or reception admin) approves it on the Refunds board; then the money
        is paid back here.
      </p>
      {error && (
        <div className="bc-err bc-deposit__note" role="alert">
          {error}
        </div>
      )}
      <div className="bc-head__row">
        <button type="submit" className="st-btn st-btn-grn" disabled={!ready}>
          {ask.isPending ? "Sending…" : "Ask for approval"}
        </button>
      </div>
    </form>
  );
}

const ACTIONS = [
  { key: "pay_back", label: "Pay back", master: false },
  { key: "to_patient", label: "Move to another patient", master: true },
  { key: "to_ipd", label: "Move to IPD", master: true },
];

export default function DepositMoves({ patient, deposit }) {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canMove = hasCapability(role, CAPABILITIES.BILLING_MASTER);
  const [action, setAction] = useState(null);
  const [result, setResult] = useState(null);
  const available = deposit?.available ?? 0;
  const openRefund = deposit?.open_refund ?? null;
  const shown = ACTIONS.filter((item) => !item.master || canMove);
  if (!available && !openRefund && !result) return null;

  const done = (outcome) => {
    setResult(outcome);
    setAction(null);
  };

  return (
    <div className="bc-deposit__moves">
      <div className="bc-head__row" role="group" aria-label="Deposit actions">
        {shown.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`st-btn ${action === item.key ? "st-btn-grn" : "st-btn-g"}`}
            aria-pressed={action === item.key}
            disabled={item.key !== "pay_back" && !available}
            onClick={() => {
              setResult(null);
              setAction(action === item.key ? null : item.key);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      {!canMove && (
        <p className="bc-hint">
          Moving a deposit to another patient or to IPD needs a reception admin.
        </p>
      )}
      {result && <Done result={result} onClose={() => setResult(null)} />}
      {action === "to_patient" && (
        <ToPatient patient={patient} available={available} onDone={done} />
      )}
      {action === "to_ipd" && <ToIpd patient={patient} available={available} onDone={done} />}
      {action === "pay_back" && (
        <PayBack patient={patient} available={available} openRefund={openRefund} onDone={done} />
      )}
    </div>
  );
}
