import { useId, useState } from "react";
import { requestErrorOf } from "../billing/format";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { useAddRxFollowupMany } from "../../queries/hooks/useGiniflowRx";
import { RX_FOLLOWUP_LABEL, RX_FOLLOWUP_RESOLVES } from "../../../shared/rxFollowups.js";
import "../../styles/flow.css";
import "../../pages/billing/billing.css";
import "../../pages/billing/billingUi.css";
import "./cancelRequests.css";

const REMARK_MAX = 500;

const datesOf = (rows, labelOf) => [...new Set(rows.map(labelOf))].join(", ");

export default function RxFollowupAllDialog({ rows, labelOf, onClose, onDone }) {
  const markAll = useAddRxFollowupMany();
  const [action, setAction] = useState("");
  const [remark, setRemark] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const remarkId = useId();
  const remarkErrId = useId();
  const actionErrId = useId();

  const count = rows.length;
  const who = `${count} patient${count === 1 ? "" : "s"}`;
  const actionError = action ? "" : "Choose what happened";
  const remarkError = remark.trim() ? "" : "Add a remark — what was done for these patients";

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (actionError || remarkError || markAll.isPending) return;
    try {
      const { marked } = await markAll.mutateAsync({
        visitIds: rows.map((r) => r.visitId),
        action,
        remark: remark.trim(),
      });
      onDone(`${RX_FOLLOWUP_LABEL[action]} — ${marked} patient${marked === 1 ? "" : "s"} done`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not mark them done — try again"));
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
            Mark all done — {who}
          </h2>
          <dl className="cxl-facts">
            <dt>Patients</dt>
            <dd>{who} listed under Prescription not given</dd>
            <dt>Visits</dt>
            <dd>{datesOf(rows, labelOf)}</dd>
          </dl>

          <fieldset
            className="cxl-charge"
            aria-describedby={touched && actionError ? actionErrId : undefined}
          >
            <legend>What happened (required)</legend>
            <div className="cxl-charge__types" role="radiogroup">
              {RX_FOLLOWUP_RESOLVES.map((key) => (
                <label key={key} className="cxl-radio">
                  <input
                    type="radio"
                    name="rx-followup-all-action"
                    value={key}
                    checked={action === key}
                    onChange={() => setAction(key)}
                  />
                  {RX_FOLLOWUP_LABEL[key]}
                </label>
              ))}
            </div>
            {touched && actionError ? (
              <p id={actionErrId} className="bill-dialog__error">
                {actionError}
              </p>
            ) : null}
          </fieldset>

          <div className="fset__field">
            <label htmlFor={remarkId}>Remark (required)</label>
            <textarea
              id={remarkId}
              className="jb-assign"
              rows={3}
              maxLength={REMARK_MAX}
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={Boolean(touched && remarkError)}
              aria-describedby={touched && remarkError ? remarkErrId : undefined}
            />
            <div className="cxl-count">
              {remark.length}/{REMARK_MAX}
            </div>
            {touched && remarkError ? (
              <p id={remarkErrId} className="bill-dialog__error">
                {remarkError}
              </p>
            ) : null}
          </div>

          <p className="cxl-confirm">
            Every patient in the list leaves Prescription not given, with this remark saved on each
            one. A single patient can still be followed up from their own row afterwards.
          </p>

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="bill-dialog__actions">
            <button type="button" className="flow-btn flow-btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="flow-btn flow-btn-primary"
              disabled={markAll.isPending}
            >
              {markAll.isPending ? "Marking…" : `Mark ${who} done`}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
