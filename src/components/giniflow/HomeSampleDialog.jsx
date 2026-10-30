import { useId, useState } from "react";
import {
  HOME_AMOUNT_MAX,
  HOME_COLLECTORS,
  HOME_NOTE_MAX,
  HOME_PAY_MODES,
  homeRecordText,
  homeSampleProblems,
} from "../../../shared/homeCollectors.js";
import { istClock } from "../../../shared/homeCollection.js";
import { requestErrorOf } from "../billing/format";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { useHomeSampleHistory, useSaveHomeSample } from "../../queries/hooks/useHomeSample";
import "../../styles/flow.css";
import "../../pages/billing/billing.css";
import "../../pages/billing/billingUi.css";
import "./cancelRequests.css";
import "./homeSample.css";

export const emptyHomeAnswer = {
  sample: "",
  collectedTime: "",
  collectedBy: "",
  payment: "",
  amount: "",
  mode: "",
  note: "",
};

export const answerFromRecord = (record) =>
  record
    ? {
        sample: record.sample,
        collectedTime: istClock(record.collectedAt),
        collectedBy: record.collectedBy || "",
        payment: record.payment || "",
        amount: record.amount ? String(record.amount) : "",
        mode: record.mode || "",
        note: record.note || "",
      }
    : emptyHomeAnswer;

export const homeProblemsNow = (answer, { brief = false } = {}) =>
  homeSampleProblems(answer, istClock(new Date()), { brief });

const fullHomePayload = (answer) => ({
  sample: answer.sample,
  collectedTime: answer.sample === "collected" ? answer.collectedTime || null : null,
  collectedBy: answer.sample === "collected" ? answer.collectedBy : null,
  payment: answer.sample === "collected" ? answer.payment : null,
  amount: answer.sample === "collected" && answer.payment === "paid" ? answer.amount : null,
  mode: answer.sample === "collected" && answer.payment === "paid" ? answer.mode : null,
  note: answer.note.trim() || null,
});

export const homePayload = (answer, { brief = false } = {}) =>
  brief
    ? { brief: true, sample: answer.sample, note: answer.note.trim() || null }
    : fullHomePayload(answer);

function FieldError({ id, text }) {
  return text ? (
    <p id={id} className="bill-dialog__error">
      {text}
    </p>
  ) : null;
}

export function HomeSampleFields({
  value,
  onChange,
  problems,
  showErrors,
  withNote = true,
  sampleOnly = false,
}) {
  const uid = useId();
  const set = (patch) => onChange({ ...value, ...patch });
  const err = (key) => (showErrors ? problems[key] : "");
  const ids = (key) => ({ id: `${uid}-${key}`, err: `${uid}-${key}-err` });
  const described = (key) => (err(key) ? ids(key).err : undefined);
  const collected = value.sample === "collected";
  const details = collected && !sampleOnly;
  const paid = details && value.payment === "paid";

  return (
    <>
      <fieldset className="cxl-charge hs-set">
        <legend>Sample</legend>
        <div className="hs-choices" role="radiogroup" aria-describedby={described("sample")}>
          <label className="cxl-radio">
            <input
              type="radio"
              name={`${uid}-sample`}
              checked={collected}
              onChange={() => set({ sample: "collected" })}
            />
            Collected at home
          </label>
          <label className="cxl-radio">
            <input
              type="radio"
              name={`${uid}-sample`}
              checked={value.sample === "not_collected"}
              onChange={() => set({ sample: "not_collected" })}
            />
            Not collected — the patient gives the sample at GHM
          </label>
        </div>
        <FieldError id={ids("sample").err} text={err("sample")} />
        {details && (
          <div className="hs-row">
            <div className="fset__field">
              <label htmlFor={ids("collectedTime").id}>Time (optional)</label>
              <input
                id={ids("collectedTime").id}
                type="time"
                className="jb-assign"
                value={value.collectedTime}
                onChange={(e) => set({ collectedTime: e.target.value })}
                aria-invalid={Boolean(err("collectedTime"))}
                aria-describedby={described("collectedTime")}
              />
              <FieldError id={ids("collectedTime").err} text={err("collectedTime")} />
            </div>
            <div className="fset__field">
              <label htmlFor={ids("collectedBy").id}>Collected by (required)</label>
              <select
                id={ids("collectedBy").id}
                className="jb-assign"
                value={value.collectedBy}
                onChange={(e) => set({ collectedBy: e.target.value })}
                aria-invalid={Boolean(err("collectedBy"))}
                aria-describedby={described("collectedBy")}
              >
                <option value="">Choose…</option>
                {HOME_COLLECTORS.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <FieldError id={ids("collectedBy").err} text={err("collectedBy")} />
            </div>
          </div>
        )}
      </fieldset>

      {details && (
        <fieldset className="cxl-charge hs-set">
          <legend>Payment</legend>
          <div className="hs-choices" role="radiogroup" aria-describedby={described("payment")}>
            <label className="cxl-radio">
              <input
                type="radio"
                name={`${uid}-payment`}
                checked={paid}
                onChange={() => set({ payment: "paid" })}
              />
              Paid at home
            </label>
            <label className="cxl-radio">
              <input
                type="radio"
                name={`${uid}-payment`}
                checked={value.payment === "pending"}
                onChange={() => set({ payment: "pending" })}
              />
              Pending
            </label>
          </div>
          <FieldError id={ids("payment").err} text={err("payment")} />
          {paid && (
            <div className="hs-row">
              <div className="fset__field">
                <label htmlFor={ids("amount").id}>Amount in ₹ (required)</label>
                <div className="cxl-value">
                  <span aria-hidden="true">₹</span>
                  <input
                    id={ids("amount").id}
                    className="jb-assign"
                    inputMode="numeric"
                    maxLength={String(HOME_AMOUNT_MAX).length}
                    value={value.amount}
                    onChange={(e) => set({ amount: e.target.value.replace(/\D/g, "") })}
                    aria-invalid={Boolean(err("amount"))}
                    aria-describedby={described("amount")}
                  />
                </div>
                <FieldError id={ids("amount").err} text={err("amount")} />
              </div>
              <div className="fset__field">
                <label htmlFor={ids("mode").id}>Mode (required)</label>
                <select
                  id={ids("mode").id}
                  className="jb-assign"
                  value={value.mode}
                  onChange={(e) => set({ mode: e.target.value })}
                  aria-invalid={Boolean(err("mode"))}
                  aria-describedby={described("mode")}
                >
                  <option value="">Choose…</option>
                  {HOME_PAY_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <FieldError id={ids("mode").err} text={err("mode")} />
              </div>
            </div>
          )}
          <p className="hs-help">
            A record of what the collector reported. It is not a payment on the bill — take the
            money on the bill when it reaches the desk.
          </p>
        </fieldset>
      )}

      {withNote && (
        <div className="fset__field">
          <label htmlFor={ids("note").id}>Note (optional)</label>
          <input
            id={ids("note").id}
            className="jb-assign"
            maxLength={HOME_NOTE_MAX}
            value={value.note}
            onChange={(e) => set({ note: e.target.value })}
          />
        </div>
      )}
    </>
  );
}

export function HomeSampleLine({ record }) {
  const text = homeRecordText(record, istClock);
  return (
    <div className="ar-home" aria-label="Home collection">
      <span className="badge b-home">🏠 Home collection</span>
      <span>Sample: {text.sample}</span>
      {text.payment &&
        (text.pending ? (
          <span className="badge b-amb">{text.payment}</span>
        ) : (
          <span>Payment: {text.payment}</span>
        ))}
    </div>
  );
}

const historyLine = (r) => {
  const text = homeRecordText(r, istClock);
  return [text.sample, text.payment, r.note].filter(Boolean).join(" · ");
};

export default function HomeSampleDialog({ arrival, onClose, onSaved }) {
  const save = useSaveHomeSample();
  const [answer, setAnswer] = useState(() => answerFromRecord(arrival.homeRecord));
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const { data: history = [] } = useHomeSampleHistory(arrival.visitId);
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const problems = homeProblemsNow(answer);
  const last = history[0] || arrival.homeRecord;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (Object.keys(problems).length || save.isPending) return;
    try {
      await save.mutateAsync({ visitId: arrival.visitId, ...homePayload(answer) });
      onSaved(`🏠 Home sample saved for ${arrival.name}`);
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Could not save the home sample"));
    }
  };

  return (
    <BillDialogLayer>
      <div className="flow-dialog-backdrop" onClick={onClose} role="presentation">
        <form
          ref={ref}
          className="flow-card bill-dialog cxl-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
          onSubmit={submit}
          noValidate
        >
          <h2 id={titleId} className="bill-dialog__title">
            🏠 Home sample — {arrival.name}
          </h2>
          <dl className="cxl-facts">
            <dt>Patient</dt>
            <dd>
              {arrival.name} · {arrival.fileNo || "no file no"}
              {arrival.age ? ` · ${arrival.age}${(arrival.sex || "")[0] || ""}` : ""}
            </dd>
            <dt>Booked</dt>
            <dd>{arrival.slot || "No slot"}</dd>
          </dl>

          <HomeSampleFields
            value={answer}
            onChange={setAnswer}
            problems={problems}
            showErrors={touched}
          />

          {last && (
            <div className="hs-last">
              Last saved by {last.enteredBy || "someone"} at {istClock(last.enteredAt)}
              {history.length > 0 && (
                <>
                  {" · "}
                  <button
                    type="button"
                    className="hs-link"
                    aria-expanded={showHistory}
                    onClick={() => setShowHistory((s) => !s)}
                  >
                    History ({history.length})
                  </button>
                </>
              )}
            </div>
          )}
          {showHistory && (
            <ol className="hs-history" aria-label="Home sample history">
              {history.map((r) => (
                <li key={`${r.enteredAt}-${r.enteredBy}`}>
                  <span className="hs-history__when">
                    {istClock(r.enteredAt)} · {r.enteredBy || "—"}
                  </span>
                  {historyLine(r)}
                </li>
              ))}
            </ol>
          )}

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="flow-btn flow-btn-primary" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
