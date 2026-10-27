import { useState } from "react";
import { Link } from "react-router-dom";
import ConfirmModal from "../../ui/ConfirmModal.jsx";

const dayText = (item) => {
  const day =
    item.meta?.visit_date || item.visit.visit_date || item.visit.occurred_at?.slice(0, 10);
  if (!day) return "";
  return new Date(`${day.slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
};

const reasonText = (item) => {
  if (!item.attempts) return "Not sent yet.";
  if (!item.last_status) return "No connection when it was sent. It will try again.";
  if (item.last_status >= 500) {
    return "The server could not save it. Try again; if it keeps failing, tell your admin.";
  }
  return item.last_error || "The server refused it.";
};

export default function PendingVisits({ items, busy, onRetry, onRemove, result }) {
  const [removing, setRemoving] = useState(null);
  const [removed, setRemoved] = useState(null);
  if (!items.length && !result && !removed) return null;
  const refused = items.filter((i) => i.last_status);
  const plural = (n) => `${n} visit${n === 1 ? "" : "s"}`;

  return (
    <section
      className={`pvq ${refused.length ? "pvq--err" : ""}`}
      aria-labelledby="pvq-title"
      role={refused.length ? "alert" : "status"}
    >
      <div className="pvq__head">
        <strong id="pvq-title">
          {items.length === 0
            ? removed && !result
              ? "No visits waiting."
              : "All visits are saved."
            : refused.length
              ? `${plural(items.length)} not saved yet`
              : `${plural(items.length)} waiting to sync`}
        </strong>
        {items.length > 0 && (
          <button
            type="button"
            className="rep__btn rep__btn--sm pvq__retry"
            onClick={onRetry}
            disabled={busy}
          >
            {busy ? "Retrying…" : "Retry now"}
          </button>
        )}
      </div>
      {items.length > 0 && (
        <ul className="pvq__list">
          {items.map((i) => (
            <li key={i.visit.id}>
              <span className="pvq__who">
                {i.meta?.doctor_name || "A doctor"}
                {dayText(i) ? ` · ${dayText(i)}` : ""}
              </span>
              <span className="pvq__why">{reasonText(i)}</span>
              {i.last_status && (
                <button
                  type="button"
                  className="asg__link pvq__remove"
                  onClick={() => setRemoving(i)}
                  disabled={busy}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {result && items.length > 0 && (
        <p className="pvq__note">
          {result.sent > 0 ? `${plural(result.sent)} saved. ` : ""}
          {result.failed > 0 ? `${plural(result.failed)} still not saved.` : ""}
        </p>
      )}
      {removed && (
        <p className="pvq__note" role="status">
          Removed the unsaved visit to {removed.meta?.doctor_name || "the doctor"}.{" "}
          <Link
            className="rep__link"
            to={`/crm/visit/${removed.visit.doctor_id}?name=${encodeURIComponent(
              removed.meta?.doctor_name || "",
            )}`}
          >
            Log it again
          </Link>
        </p>
      )}
      {items.length > 0 && (
        <p className="pvq__note">
          These are kept on this device until they save. Do not clear the browser data.
        </p>
      )}
      <ConfirmModal
        open={Boolean(removing)}
        variant="danger"
        title={`Remove the unsaved visit to ${removing?.meta?.doctor_name || "this doctor"}?`}
        cancelLabel="Keep it"
        confirmLabel="Remove visit"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          onRemove(removing);
          setRemoved(removing);
          setRemoving(null);
        }}
        message={
          removing && (
            <div className="dfm__dialog">
              <p className="dfm__ident">
                <strong>{removing.meta?.doctor_name || "A doctor"}</strong>
                {dayText(removing) ? ` · ${dayText(removing)}` : ""}
              </p>
              <p>
                It was never saved, and it is deleted from this device. Nothing else changes. You
                can log the visit again afterwards.
              </p>
              <p>Reason it was refused: {reasonText(removing)}</p>
            </div>
          )
        }
      />
    </section>
  );
}
