import { useEffect, useRef, useState } from "react";
import ConfirmModal from "../../ui/ConfirmModal";
import useAuthStore from "../../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../../shared/permissions.js";
import {
  useConfirmConsultantChange,
  useConsultantChange,
  useConsultantChanges,
  useDismissConsultantChange,
} from "../../../queries/hooks/useBilling";
import { errorOf, fromPaise } from "../format";

const REFUND_MODES = [
  { value: "cash", label: "Cash" },
  { value: "card", label: "Card" },
  { value: "upi", label: "UPI" },
];

function outcome(preview) {
  if (preview.new_fee === null) return "the new consultant has no fee set yet";
  if (preview.difference > 0) return `${fromPaise(preview.difference)} more to collect`;
  if (preview.difference < 0) return `${fromPaise(-preview.difference)} goes back to the patient`;
  return "same fee";
}

const changeOutcome = (change) => (change.preview ? outcome(change.preview) : "fee to check");

export function consultantChangeText(changes) {
  if (changes.length === 1) {
    const [change] = changes;
    return `Consultant changed for ${change.patient.name} (${change.from.name} → ${change.to.name}) — ${changeOutcome(change)}`;
  }
  return `${changes.length} consultant changes need the fee settled — open the Bill tab`;
}

export function useConsultantChangesToSettle(enabled, onNew) {
  const { data } = useConsultantChanges({ enabled });
  const seen = useRef(null);
  const told = useRef(onNew);
  told.current = onNew;
  const changes = data?.changes;

  useEffect(() => {
    if (!changes) return;
    const fresh = seen.current ? changes.filter((change) => !seen.current.has(change.id)) : [];
    seen.current = new Set(changes.map((change) => change.id));
    if (fresh.length) told.current(fresh);
  }, [changes]);

  return changes ?? [];
}

export function ConsultantChangesWaiting({ changes, visitId, onOpen }) {
  if (!changes.length) return null;
  return (
    <section className="bc-ccw" aria-label="Consultant changes to settle">
      <h3 className="bc-ccw__title">
        Consultant changed — fee to settle <span className="bc-ccw__n">{changes.length}</span>
      </h3>
      <ul className="bc-ccw__list">
        {changes.map((change) => (
          <li key={change.id}>
            <button
              type="button"
              className={`bc-ccw__item${change.visit_id === visitId ? " on" : ""}`}
              aria-current={change.visit_id === visitId ? "true" : undefined}
              onClick={() => onOpen({ visit: change.visit_id })}
            >
              <span>
                <strong>{change.patient.name}</strong>
                {change.patient.file_no && ` · ${change.patient.file_no}`}
              </span>
              <span className="bc-ccw__what">
                {change.from.name} → {change.to.name} · {changeOutcome(change)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ConsultantChange({ visitId, patient, onSettled }) {
  const { data: change } = useConsultantChange(visitId);
  const me = useAuthStore((st) => st.currentDoctor);
  const confirm = useConfirmConsultantChange();
  const dismiss = useDismissConsultantChange();
  const [step, setStep] = useState(null);
  const [leftover, setLeftover] = useState("deposit");
  const [refundMode, setRefundMode] = useState("cash");
  const [note, setNote] = useState("");
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  if (!change && !done) return null;

  const preview = change?.preview;
  const close = () => {
    if (confirm.isPending || dismiss.isPending) return;
    setStep(null);
    setError(null);
  };

  const settle = async () => {
    setError(null);
    try {
      const made = await confirm.mutateAsync({
        changeId: change.id,
        visitId,
        leftover,
        refund_mode: leftover === "refund" ? refundMode : null,
        note: note.trim() || null,
      });
      setDone(
        `Consultant change settled: ${fromPaise(made.to_deposit)} credited to the deposit, ` +
          `${fromPaise(made.applied_from_deposit)} used for the new fee` +
          (made.refund_requested
            ? `, ${fromPaise(made.refund_requested)} refund waiting for a second person's approval.`
            : made.left_in_deposit
              ? `, ${fromPaise(made.left_in_deposit)} kept in the deposit.`
              : "."),
      );
      setStep(null);
      onSettled?.();
    } catch (e) {
      setError(errorOf(e, "The consultant change could not be settled"));
    }
  };

  const keepBill = async () => {
    setError(null);
    try {
      await dismiss.mutateAsync({ changeId: change.id, visitId, note: note.trim() });
      setDone("The bill stays as it is; the consultant change is closed.");
      setStep(null);
    } catch (e) {
      setError(errorOf(e, "The consultant change could not be closed"));
    }
  };

  if (!change) {
    return (
      <div className="bc-note" role="status">
        {done}
      </div>
    );
  }

  const leftOver = preview?.left_in_deposit ?? 0;
  const changedByMe =
    Boolean(me?.id) &&
    change.reassigned_by?.id === me.id &&
    !hasCapability(me.role, CAPABILITIES.ADMIN);

  return (
    <div className="bc-hint" role="status" aria-label="Consultant changed">
      <strong>
        Consultant changed — {change.from.name} → {change.to.name}
      </strong>
      {preview && (
        <>
          {" "}
          · billed {fromPaise(preview.charged)}, new fee{" "}
          {preview.new_fee === null ? "not set" : fromPaise(preview.new_fee)} · {outcome(preview)}
        </>
      )}
      {change.reassigned_by?.name ? ` · changed by ${change.reassigned_by.name}` : ""}
      {changedByMe && (
        <div>
          You changed the consultant, so another staff member at the counter must settle the fee.
        </div>
      )}
      <div className="bc-head__row">
        <button
          type="button"
          className="st-btn st-btn-blu"
          disabled={!preview || preview.new_fee === null || changedByMe}
          onClick={() => {
            setNote("");
            setStep("confirm");
          }}
        >
          Settle fee change
        </button>
        <button
          type="button"
          className="st-btn st-btn-g"
          onClick={() => {
            setNote("");
            setStep("dismiss");
          }}
        >
          Keep the bill as it is
        </button>
      </div>

      <ConfirmModal
        open={step === "confirm"}
        title="Settle the consultant change?"
        variant="primary"
        confirmLabel={confirm.isPending ? "Settling…" : "Settle fee change"}
        busy={confirm.isPending}
        error={error}
        onConfirm={settle}
        onCancel={close}
        message={
          preview && (
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
                  <dd>{preview.bills.join(", ") || "—"}</dd>
                </div>
                <div>
                  <dt>Consultant</dt>
                  <dd>
                    {change.from.name} → {change.to.name}
                  </dd>
                </div>
              </dl>
              <dl className="bc-cc__money" aria-label="Fee change">
                <div>
                  <dt>Billed for {change.from.name}</dt>
                  <dd>{fromPaise(preview.charged)}</dd>
                </div>
                <div>
                  <dt>Credited to the deposit</dt>
                  <dd>+{fromPaise(preview.to_deposit)}</dd>
                </div>
                <div>
                  <dt>New fee · {change.to.name}</dt>
                  <dd>{fromPaise(preview.new_fee)}</dd>
                </div>
                <div>
                  <dt>Paid from the deposit</dt>
                  <dd>−{fromPaise(preview.applied_from_deposit)}</dd>
                </div>
                <div className="bc-cc__total">
                  <dt>Still to collect</dt>
                  <dd>{fromPaise(preview.to_collect)}</dd>
                </div>
                {leftOver > 0 && (
                  <div className="bc-cc__total">
                    <dt>Left over</dt>
                    <dd>{fromPaise(leftOver)}</dd>
                  </div>
                )}
              </dl>
              {leftOver > 0 && (
                <fieldset className="bc-cc__choices">
                  <legend className="bc-field__lbl">
                    What happens to the {fromPaise(leftOver)}
                  </legend>
                  <label className="bc-cc__choice">
                    <input
                      type="radio"
                      name="cc-leftover"
                      value="deposit"
                      checked={leftover === "deposit"}
                      onChange={() => setLeftover("deposit")}
                    />
                    <span>
                      <strong>Keep in the patient's deposit</strong>
                      <small>Used for this patient's next bill.</small>
                    </span>
                  </label>
                  <label className="bc-cc__choice">
                    <input
                      type="radio"
                      name="cc-leftover"
                      value="refund"
                      checked={leftover === "refund"}
                      onChange={() => setLeftover("refund")}
                    />
                    <span>
                      <strong>Refund it</strong>
                      <small>Needs a second person's approval before it is paid back.</small>
                    </span>
                  </label>
                  {leftover === "refund" && (
                    <label className="bc-field">
                      <span className="bc-field__lbl">Pay back by</span>
                      <select
                        className="bc-field__in"
                        value={refundMode}
                        onChange={(e) => setRefundMode(e.target.value)}
                      >
                        {REFUND_MODES.map((mode) => (
                          <option key={mode.value} value={mode.value}>
                            {mode.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </fieldset>
              )}
              <label className="bc-field">
                <span className="bc-field__lbl">Note (optional)</span>
                <input
                  className="bc-field__in"
                  value={note}
                  maxLength={300}
                  onChange={(e) => setNote(e.target.value)}
                />
              </label>
              <p className="bc-cc__warn">
                A credit note is made for {change.from.name}'s consultation and {change.to.name}'s
                consultation is added to this visit's draft bill. This can't be undone.
              </p>
            </div>
          )
        }
      />

      <ConfirmModal
        open={step === "dismiss"}
        title="Keep the bill as it is?"
        variant="primary"
        confirmLabel={dismiss.isPending ? "Saving…" : "Keep the bill"}
        busy={dismiss.isPending}
        confirmDisabled={!note.trim()}
        error={error}
        onConfirm={keepBill}
        onCancel={close}
        message={
          <div className="bc-cc">
            <p className="bc-hint">
              The patient stays with {change.to.name}, but the bill keeps {change.from.name}'s
              consultation fee.
            </p>
            <label className="bc-field">
              <span className="bc-field__lbl">Why the bill stays as it is (required)</span>
              <input
                className="bc-field__in"
                value={note}
                maxLength={300}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
        }
      />
    </div>
  );
}
