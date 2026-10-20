import { useId, useState } from "react";
import { requestErrorOf } from "../billing/format";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { useAddRxFollowup } from "../../queries/hooks/useGiniflowRx";
import { RX_FOLLOWUP_LABEL } from "../../../shared/rxFollowups.js";
import "../../styles/flow.css";
import "../../pages/billing/billing.css";
import "../../pages/billing/billingUi.css";
import "./cancelRequests.css";

const REMARK_MAX = 500;

const TITLE = {
  not_taken: "Prescription not taken",
  note: "Add a remark",
  sent_whatsapp: "Prescription sent on WhatsApp",
  collected: "Prescription collected in person",
  not_needed: "Prescription not needed",
};

export default function RxFollowupDialog({ patient, actions, onClose, onDone }) {
  const addFollowup = useAddRxFollowup();
  const [action, setAction] = useState(actions[0]);
  const [remark, setRemark] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState("");
  const ref = useDialog(true, onClose);
  const titleId = useId();
  const remarkId = useId();
  const remarkErrId = useId();

  const remarkError = remark.trim() ? "" : "Add a remark — what happened or what was done";
  const who = `${patient.name}${patient.fileNo ? ` (${patient.fileNo})` : ""}`;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    setError("");
    if (remarkError || addFollowup.isPending) return;
    try {
      await addFollowup.mutateAsync({ visitId: patient.visitId, action, remark: remark.trim() });
      onDone(`${RX_FOLLOWUP_LABEL[action]} — ${patient.name}`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not save that — try again"));
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
            {actions.length === 1 ? TITLE[action] : "Prescription follow-up"}
          </h2>
          <dl className="cxl-facts">
            <dt>Patient</dt>
            <dd>{who}</dd>
            <dt>Visit</dt>
            <dd>
              {patient.visitLabel}
              {patient.doctorName ? ` · ${patient.doctorName}` : ""}
            </dd>
            {patient.phone ? (
              <>
                <dt>Phone</dt>
                <dd>{patient.phone}</dd>
              </>
            ) : null}
          </dl>

          {actions.length > 1 ? (
            <fieldset className="cxl-charge">
              <legend>What happened</legend>
              <div className="cxl-charge__types" role="radiogroup">
                {actions.map((key) => (
                  <label key={key} className="cxl-radio">
                    <input
                      type="radio"
                      name="rx-followup-action"
                      value={key}
                      checked={action === key}
                      onChange={() => setAction(key)}
                    />
                    {RX_FOLLOWUP_LABEL[key]}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

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
              disabled={addFollowup.isPending}
            >
              {addFollowup.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </BillDialogLayer>
  );
}
