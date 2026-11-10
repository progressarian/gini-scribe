import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import ConfirmModal from "../../ui/ConfirmModal.jsx";
import { errorText } from "../import/importText.js";
import { dayText } from "../progress/progressText.js";
import { countDays } from "./dayOffText.js";

const EMPTY = { user_id: "", from: "", to: "", half_day: false, note: "", title: "" };
const TITLE = /^[A-Za-z0-9][A-Za-z0-9 .,'&()/-]*$/;

export default function DayOffDialog({ kind, isAdmin, staff, limits, onClose, onSaved }) {
  const open = Boolean(kind);
  const holiday = kind === "holiday";
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setErrors({});
    setErr(null);
  }, [open, kind]);

  const set = (key) => (e) => {
    const value = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === "from" && (!f.to || f.to < value)) next.to = value;
      if ((key === "from" || key === "to") && next.from !== next.to) next.half_day = false;
      return next;
    });
    setErrors((x) => ({ ...x, [key]: undefined, ...(key === "from" ? { to: undefined } : {}) }));
  };

  const to = form.to || form.from;
  const count = form.from && to >= form.from ? countDays(form.from, to) : null;
  const single = form.from && to === form.from;

  const check = () => {
    const next = {};
    if (isAdmin && !holiday && !form.user_id) next.user_id = "Choose who is on leave.";
    if (holiday) {
      const title = form.title.trim();
      if (!title) next.title = "Enter the holiday name, like Diwali.";
      else if (title.length > 60 || !TITLE.test(title)) {
        next.title = "Use letters and numbers only, up to 60, like Diwali.";
      }
    }
    if (!form.from) next.from = "Choose the first day.";
    else if (form.from < limits.from || form.from > limits.to) {
      next.from = `Choose a date from ${dayText(limits.from)} to ${dayText(limits.to)}.`;
    }
    if (form.from && to < form.from) next.to = "The last day must be on or after the first day.";
    else if (to && to > limits.to) next.to = `Choose a date up to ${dayText(limits.to)}.`;
    else if (count && count.span > 31) next.to = "Choose 31 days or fewer at a time.";
    if (!next.from && !next.to && count && count.working === 0) {
      next.from = "Pick at least one day that is not a Sunday.";
    }
    if (form.note.trim().length > 200) next.note = "Keep it under 200 letters.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async () => {
    if (!check()) return;
    setBusy(true);
    setErr(null);
    try {
      const { data } = holiday
        ? await api.post("/api/crm/holidays", { from: form.from, to, title: form.title.trim() })
        : await api.post("/api/crm/leave", {
            from: form.from,
            to,
            half_day: single && form.half_day,
            note: form.note.trim(),
            user_id: isAdmin ? form.user_id : undefined,
          });
      onSaved(data);
    } catch (e) {
      if (e?.response?.data?.fields) setErrors(e.response.data.fields);
      setErr(errorText(e, holiday ? "Unable to add the holiday." : "Unable to save the leave."));
    } finally {
      setBusy(false);
    }
  };

  const fieldErr = (key) =>
    errors[key] && (
      <span className="dfm__err" id={`off-${key}-err`}>
        {errors[key]}
      </span>
    );
  const invalid = (key) => ({
    "aria-invalid": Boolean(errors[key]),
    "aria-describedby": errors[key] ? `off-${key}-err` : undefined,
  });
  const fieldClass = (key) => `dfm__field ${errors[key] ? "dfm__field--err" : ""}`;

  const summary = !count
    ? null
    : single && form.half_day
      ? "Half day"
      : `${count.working} working day${count.working === 1 ? "" : "s"}${
          count.sundays ? ` · ${count.sundays} Sunday${count.sundays === 1 ? "" : "s"} skipped` : ""
        }`;

  return (
    <ConfirmModal
      open={open}
      variant="primary"
      title={holiday ? "Add a holiday" : isAdmin ? "Add leave" : "Request leave"}
      cancelLabel="Cancel"
      confirmLabel={
        busy ? "Saving…" : holiday ? "Add holiday" : isAdmin ? "Add leave" : "Send request"
      }
      onCancel={onClose}
      onConfirm={save}
      busy={busy}
      error={err}
      message={
        <div className="dfm__dialog">
          <p className="dfm__hint">
            {holiday
              ? "A holiday is a day off for the whole growth team. Sundays are always off."
              : isAdmin
                ? "Leave you add is approved straight away."
                : "Your admin approves the request. Until then it does not count as leave."}
          </p>
          {isAdmin && !holiday && (
            <div className={fieldClass("user_id")}>
              <label className="dfm__label" htmlFor="off-user">
                Who is on leave
              </label>
              <select
                id="off-user"
                className="rep__input"
                value={form.user_id}
                onChange={set("user_id")}
                {...invalid("user_id")}
              >
                <option value="">Choose a person</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
              {fieldErr("user_id")}
            </div>
          )}
          {holiday && (
            <div className={fieldClass("title")}>
              <label className="dfm__label" htmlFor="off-title">
                Holiday name
              </label>
              <input
                id="off-title"
                className="rep__input"
                value={form.title}
                maxLength={60}
                placeholder="Diwali"
                onChange={set("title")}
                {...invalid("title")}
              />
              {fieldErr("title")}
            </div>
          )}
          <div className="tsk__pair">
            <div className={fieldClass("from")}>
              <label className="dfm__label" htmlFor="off-from">
                First day
              </label>
              <input
                id="off-from"
                className="rep__input"
                type="date"
                min={limits.from}
                max={limits.to}
                value={form.from}
                onChange={set("from")}
                {...invalid("from")}
              />
              {fieldErr("from")}
            </div>
            <div className={fieldClass("to")}>
              <label className="dfm__label" htmlFor="off-to">
                Last day
              </label>
              <input
                id="off-to"
                className="rep__input"
                type="date"
                min={form.from || limits.from}
                max={limits.to}
                value={form.to}
                onChange={set("to")}
                {...invalid("to")}
              />
              {fieldErr("to")}
            </div>
          </div>
          {!holiday && (
            <label className="rep__check dfm__check">
              <input
                type="checkbox"
                checked={form.half_day}
                disabled={!single}
                onChange={set("half_day")}
              />
              Half day {single ? "" : "(only for a single date)"}
            </label>
          )}
          {fieldErr("half_day")}
          {!holiday && (
            <div className={fieldClass("note")}>
              <label className="dfm__label" htmlFor="off-note">
                Reason (optional)
              </label>
              <textarea
                id="off-note"
                className="rep__notes"
                rows={2}
                maxLength={200}
                value={form.note}
                placeholder="Family function"
                onChange={set("note")}
                {...invalid("note")}
              />
              {fieldErr("note")}
            </div>
          )}
          {summary && (
            <p className="dfm__hint" role="status">
              {summary}
            </p>
          )}
        </div>
      }
    />
  );
}
