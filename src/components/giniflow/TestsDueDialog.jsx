import { useId, useState } from "react";
import { requestErrorOf } from "../billing/format";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { useDecideTestsDue, useTestsDue } from "../../queries/hooks/useTestsDue";
import { TEST_URGENCY } from "../../pages/giniflow/consult/testSearch";
import { intervalLabel, TESTS_DUE_SOURCE_LABEL } from "../../../shared/testsDue.js";
import "../../styles/flow.css";
import "../../pages/billing/billing.css";
import "../../pages/billing/billingUi.css";
import "./cancelRequests.css";
import "./testsDue.css";

const fullDate = (ymd) =>
  new Date(`${ymd}T12:00:00`).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const monthsBetween = (from, to) => {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
};

const agoLabel = (lastDone, visitDate) => {
  const months = visitDate ? monthsBetween(lastDone, visitDate) : null;
  if (months === null) return "";
  return months >= 24 ? `${Math.floor(months / 12)} years ago` : `${months} months ago`;
};

export default function TestsDueDialog({ visitId, station, enabled, patient, onToast }) {
  const { data } = useTestsDue(visitId, station, enabled);
  const due = data?.due || [];
  const [dismissedFor, setDismissedFor] = useState(null);
  const open = enabled && due.length > 0 && dismissedFor !== visitId;
  return open ? (
    <DueDialog
      key={visitId}
      visitId={visitId}
      station={station}
      due={due}
      visitDate={data.visitDate}
      patient={patient}
      onToast={onToast}
      onClose={() => setDismissedFor(visitId)}
    />
  ) : null;
}

function DueDialog({ visitId, station, due, visitDate, patient, onToast, onClose }) {
  const decide = useDecideTestsDue(visitId, station);
  const [unticked, setUnticked] = useState(() => new Set());
  const [urgency, setUrgency] = useState("today");
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();

  const toggle = (key) =>
    setUnticked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const submit = async (orderKeys) => {
    if (decide.isPending) return;
    setError("");
    const order = orderKeys;
    const decline = due.map((t) => t.key).filter((k) => !order.includes(k));
    try {
      const result = await decide.mutateAsync({
        order,
        decline,
        urgency: order.length ? urgency : null,
      });
      if (result.ordered.length) {
        const urgencyLabel = TEST_URGENCY.find((u) => u.key === urgency)?.label || urgency;
        onToast?.(
          result.reachesReceptionToday
            ? `✓ ${result.ordered.join(", ")} ordered — sent to reception`
            : `✓ ${result.ordered.join(", ")} saved for ${urgencyLabel.toLowerCase()}`,
        );
      } else {
        onToast?.(`${result.declined.join(", ")} not ordered this visit`);
      }
      onClose();
    } catch (err) {
      setError(requestErrorOf(err, "Couldn't save that. Try again."));
    }
  };

  const orderKeys = due.map((t) => t.key).filter((k) => !unticked.has(k));
  const who = `${patient?.name || "Patient"}${patient?.fileNo ? ` · ${patient.fileNo}` : ""}`;

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
          onSubmit={(e) => {
            e.preventDefault();
            if (orderKeys.length) submit(orderKeys);
          }}
          noValidate
        >
          <h2 id={titleId} className="bill-dialog__title">
            Tests due — {who}
          </h2>
          <p className="tdue-lead">These were done before and are due again.</p>

          <fieldset className="cxl-charge">
            <legend>Tests</legend>
            <div className="tdue-list">
              {due.map((t) => (
                <label key={t.key} className="cxl-radio tdue-row">
                  <input
                    type="checkbox"
                    checked={!unticked.has(t.key)}
                    onChange={() => toggle(t.key)}
                  />
                  <strong>{t.label}</strong>
                  <span>
                    last done {fullDate(t.lastDone)}
                    {agoLabel(t.lastDone, visitDate) ? ` (${agoLabel(t.lastDone, visitDate)})` : ""}
                    {TESTS_DUE_SOURCE_LABEL[t.source]
                      ? ` · ${TESTS_DUE_SOURCE_LABEL[t.source]}`
                      : ""}{" "}
                    · {intervalLabel(t.months)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="cxl-charge" disabled={!orderKeys.length}>
            <legend>Order for</legend>
            <div className="cxl-charge__types" role="radiogroup">
              {TEST_URGENCY.map((u) => (
                <label key={u.key} className="cxl-radio">
                  <input
                    type="radio"
                    name="tests-due-urgency"
                    value={u.key}
                    checked={urgency === u.key}
                    onChange={() => setUrgency(u.key)}
                  />
                  {u.label}
                </label>
              ))}
            </div>
          </fieldset>

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              disabled={decide.isPending}
              onClick={() => submit([])}
            >
              Not now
            </button>
            <button
              type="submit"
              className="flow-btn flow-btn-primary"
              disabled={decide.isPending || !orderKeys.length}
            >
              {decide.isPending
                ? "Ordering…"
                : `Order ${orderKeys.length} ${orderKeys.length === 1 ? "test" : "tests"}`}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
