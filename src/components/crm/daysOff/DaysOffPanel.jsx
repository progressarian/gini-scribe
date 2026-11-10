import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import ConfirmModal from "../../ui/ConfirmModal.jsx";
import { errorText } from "../import/importText.js";
import { DAY_OFF_STATUSES, dayOffStatusMeta } from "../../../../shared/crmVocab.js";
import DayOffDialog from "./DayOffDialog.jsx";
import { dayCount, datesText } from "./dayOffText.js";

const FILTERS = [{ value: "all", label: "All" }, ...DAY_OFF_STATUSES];

const EMPTY = {
  pending: "No leave requests waiting.",
  approved: "No approved leave.",
  rejected: "No rejected leave.",
  cancelled: "No cancelled leave.",
  all: "No leave yet.",
};

export default function DaysOffPanel({ onPendingChange, onChanged }) {
  const [status, setStatus] = useState(null);
  const [person, setPerson] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get("/api/crm/days-off", {
        params: { status: status ?? undefined, user: person || undefined },
      })
      .then(({ data: body }) => {
        if (cancelled) return;
        setData(body);
        if (status === null) setStatus(body.status);
        if (body.is_admin) onPendingChange?.(body.pending);
      })
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load holidays and leave.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [status, person, reload]);

  const refresh = (message) => {
    setNotice(message);
    setReload((n) => n + 1);
    onChanged?.();
  };

  const run = async () => {
    const { action, row } = confirm;
    setBusy(true);
    setActionErr(null);
    const url =
      action === "remove"
        ? `/api/crm/holidays/${row.request_id}/remove`
        : `/api/crm/leave/${row.request_id}/${action}`;
    try {
      await api.post(url, { note: note.trim() || undefined });
      setConfirm(null);
      const who = row.full_name ? `${row.full_name}'s leave` : "Leave";
      refresh(
        {
          approve: `${who} approved.`,
          reject: `${who} rejected.`,
          cancel: `${who} cancelled.`,
          remove: `${row.title} removed.`,
        }[action],
      );
    } catch (e) {
      setActionErr(errorText(e, "That did not work."));
      setReload((n) => n + 1);
    } finally {
      setBusy(false);
    }
  };

  const ask = (action, row) => {
    setNote("");
    setActionErr(null);
    setConfirm({ action, row });
  };

  const admin = data?.is_admin;
  const today = data?.today;
  const holidays = data?.holidays ?? [];
  const upcoming = holidays.filter((h) => h.to_day >= today);
  const past = holidays.filter((h) => h.to_day < today).reverse();
  const canCancel = (l) => (admin ? l.status === "approved" : l.status === "pending");

  const confirmText = () => {
    if (!confirm) return {};
    const { action, row } = confirm;
    const when = datesText(row.from_day, row.to_day);
    if (action === "remove") {
      return {
        title: `Remove the holiday ${row.title}?`,
        label: "Remove holiday",
        body: `${when} becomes a working day again for everyone, and averages for those dates change.`,
      };
    }
    return {
      approve: {
        title: `Approve ${row.full_name}'s leave?`,
        label: "Approve leave",
        body: `${when} (${dayCount(row.days)}) will not count as working days for ${row.full_name}.`,
      },
      reject: {
        title: `Reject ${row.full_name}'s leave?`,
        label: "Reject leave",
        body: `${when} stays a working day. ${row.full_name} will see your note.`,
        needsNote: true,
      },
      cancel: {
        title: admin ? `Cancel ${row.full_name}'s leave?` : "Cancel your leave request?",
        label: "Cancel leave",
        body: `${when} (${dayCount(row.days)}) will count as working days again.`,
      },
    }[action];
  };
  const c = confirmText();

  return (
    <section className="home__panel lv" aria-label="Holidays and leave">
      <div className="tsk__bar">
        <div className="rep__chips" role="group" aria-label="Filter leave">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`rep__chip ${status === f.value ? "rep__chip--on" : ""}`}
              aria-pressed={status === f.value}
              onClick={() => setStatus(f.value)}
            >
              {f.value === "pending" ? "Waiting" : f.label}
              {f.value === "pending" && data?.pending > 0 && <strong> {data.pending}</strong>}
            </button>
          ))}
        </div>
        <div className="tsk__tools">
          {admin && (
            <label className="asg__field asg__field--narrow">
              <span className="asg__sr">Person</span>
              <select
                className={`rep__input ${person ? "home__select--on" : ""}`}
                value={person}
                onChange={(e) => setPerson(e.target.value)}
              >
                <option value="">Everyone</option>
                {data.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {admin && (
            <button
              type="button"
              className="rep__btn rep__btn--sm"
              onClick={() => setDialog("holiday")}
            >
              + Holiday
            </button>
          )}
          {data && (
            <button
              type="button"
              className="rep__btn rep__btn--primary rep__btn--sm"
              onClick={() => setDialog("leave")}
            >
              {admin ? "+ Leave" : "Request leave"}
            </button>
          )}
        </div>
      </div>

      {notice && (
        <div className="rep__toast" role="status">
          {notice}
        </div>
      )}
      {err && (
        <div className="rep__err" role="alert">
          {err}{" "}
          <button type="button" className="asg__link" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {!err && (
        <>
          <h3 className="lv__h3">{admin ? "Leave" : "My leave"}</h3>
          <ul className="rep__list home__list" aria-busy={loading}>
            {loading &&
              !data &&
              Array.from({ length: 2 }, (_, i) => (
                <li key={i} className="rep__row asg__skeleton" />
              ))}
            {data && data.leave.length === 0 && (
              <li className="rep__empty">
                {EMPTY[status] ?? EMPTY.all}
                {!admin && status !== "pending" && " Use Request leave when you plan a day off."}
              </li>
            )}
            {data?.leave.map((l) => {
              const meta = dayOffStatusMeta(l.status);
              return (
                <li key={l.request_id} className="rep__row lv__row">
                  <div className="rep__row-main">
                    <strong>
                      {admin ? `${l.full_name} · ` : ""}
                      {datesText(l.from_day, l.to_day)}
                    </strong>
                    <span className="rep__row-sub">
                      {l.portion === "half" ? "Half day" : dayCount(l.days)}
                      {l.note ? ` · ${l.note}` : ""}
                      {l.added_by_admin ? ` · added by ${l.requested_by_name ?? "your admin"}` : ""}
                    </span>
                    {l.status !== "pending" && (l.decided_by_name || l.decision_note) && (
                      <span className="rep__row-sub">
                        {meta?.label ?? l.status}
                        {l.decided_by_name ? ` by ${l.decided_by_name}` : ""}
                        {l.decision_note ? `: ${l.decision_note}` : ""}
                      </span>
                    )}
                    <span className="rep__row-flags">
                      <span className={`rep__due rep__due--${meta?.tone ?? "ink"}`}>
                        {meta?.label ?? l.status}
                      </span>
                    </span>
                  </div>
                  <div className="rep__row-actions tsk__actions">
                    {admin && l.status === "pending" && (
                      <>
                        <button
                          type="button"
                          className="rep__btn rep__btn--sm"
                          onClick={() => ask("reject", l)}
                        >
                          Reject
                        </button>
                        <button
                          type="button"
                          className="rep__btn rep__btn--primary rep__btn--sm"
                          onClick={() => ask("approve", l)}
                        >
                          Approve
                        </button>
                      </>
                    )}
                    {canCancel(l) && (
                      <button
                        type="button"
                        className="rep__btn rep__btn--sm"
                        onClick={() => ask("cancel", l)}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <h3 className="lv__h3">Holidays</h3>
          <ul className="rep__list home__list">
            {data && holidays.length === 0 && (
              <li className="rep__empty">
                No holidays marked.{admin ? " Use + Holiday to add one, like Diwali." : ""}
              </li>
            )}
            {[...upcoming, ...past].map((h) => (
              <li
                key={h.request_id}
                className={`rep__row lv__row ${h.to_day < today ? "lv__row--past" : ""}`}
              >
                <div className="rep__row-main">
                  <strong>{h.title}</strong>
                  <span className="rep__row-sub">
                    {datesText(h.from_day, h.to_day)} · {dayCount(h.days)}
                    {h.to_day < today ? " · past" : ""}
                  </span>
                </div>
                {admin && (
                  <div className="rep__row-actions">
                    <button
                      type="button"
                      className="rep__btn rep__btn--sm"
                      onClick={() => ask("remove", h)}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="lv__foot">
            Sundays, holidays and approved leave are left out of “visits per working day”.
          </p>
        </>
      )}

      {data && (
        <DayOffDialog
          kind={dialog}
          isAdmin={admin}
          staff={data.staff}
          limits={data.limits}
          onClose={() => setDialog(null)}
          onSaved={(result) => {
            const kind = dialog;
            setDialog(null);
            refresh(
              kind === "holiday"
                ? "Holiday added."
                : result.status === "pending"
                  ? "Leave requested. It counts once your admin approves it."
                  : "Leave added.",
            );
          }}
        />
      )}

      <ConfirmModal
        open={Boolean(confirm)}
        variant={confirm?.action === "approve" ? "primary" : "danger"}
        title={c.title}
        cancelLabel="Go back"
        confirmLabel={busy ? "Saving…" : c.label}
        onCancel={() => setConfirm(null)}
        onConfirm={run}
        confirmDisabled={c.needsNote && !note.trim()}
        busy={busy}
        error={actionErr}
        message={
          confirm && (
            <div className="dfm__dialog">
              <p>{c.body}</p>
              {confirm.action === "reject" && (
                <label className="dfm__field">
                  <span className="dfm__label">Note for {confirm.row.full_name}</span>
                  <textarea
                    className="rep__notes"
                    rows={2}
                    maxLength={200}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                </label>
              )}
            </div>
          )
        }
      />
    </section>
  );
}
