import { useState } from "react";
import api from "../../../services/api.js";
import ConfirmModal from "../../ui/ConfirmModal.jsx";
import { errorText } from "../import/importText.js";

export default function useTaskActions(onChanged) {
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);
  const [err, setErr] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState("");
  const [cancelErr, setCancelErr] = useState(null);

  const post = async (task, action, body, message) => {
    setBusy(task.id);
    setErr(null);
    try {
      await api.post(`/api/crm/tasks/${task.id}/${action}`, body);
      setNotice(message ? { text: message, task } : null);
      onChanged?.();
      return true;
    } catch (e) {
      setErr(errorText(e, "That did not work. Please try again."));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const done = (task) => post(task, "done", {}, `Marked done: ${task.title}`);
  const reopen = (task) => post(task, "reopen", {}, null);
  const askCancel = (task) => {
    setReason("");
    setCancelErr(null);
    setCancelling(task);
  };

  const ui = (
    <>
      {notice && (
        <div className="rep__toast tsk__toast" role="status">
          <span>{notice.text}</span>
          <button
            type="button"
            className="asg__link"
            onClick={() => {
              const task = notice.task;
              setNotice(null);
              reopen(task);
            }}
          >
            Undo
          </button>
        </div>
      )}
      {err && (
        <div className="rep__err" role="alert">
          {err}
        </div>
      )}
      <ConfirmModal
        open={Boolean(cancelling)}
        variant="danger"
        title={`Cancel “${cancelling?.title ?? ""}”?`}
        cancelLabel="Keep the task"
        confirmLabel={busy ? "Cancelling…" : "Cancel task"}
        onCancel={() => setCancelling(null)}
        confirmDisabled={!reason.trim()}
        busy={Boolean(busy)}
        error={cancelErr}
        onConfirm={async () => {
          setCancelErr(null);
          const task = cancelling;
          setBusy(task.id);
          try {
            await api.post(`/api/crm/tasks/${task.id}/cancel`, { reason });
            setCancelling(null);
            setNotice({ text: `Cancelled: ${task.title}`, task });
            onChanged?.();
          } catch (e) {
            setCancelErr(errorText(e, "Unable to cancel the task. Please try again."));
          } finally {
            setBusy(null);
          }
        }}
        message={
          <div className="dfm__dialog">
            {cancelling?.doctor_name && (
              <p className="dfm__ident">
                <strong>{cancelling.doctor_name}</strong>
                {cancelling.doctor_area ? ` · ${cancelling.doctor_area}` : ""}
              </p>
            )}
            <label className="dfm__field">
              <span className="dfm__label">Why is it no longer needed?</span>
              <input
                className="rep__input"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Doctor on leave, event cancelled…"
              />
            </label>
          </div>
        }
      />
    </>
  );

  return { done, reopen, askCancel, busy, ui };
}
