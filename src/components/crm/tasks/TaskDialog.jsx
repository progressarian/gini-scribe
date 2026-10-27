import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import useDebounced from "../../../hooks/useDebounced.js";
import ConfirmModal from "../../ui/ConfirmModal.jsx";
import { errorText } from "../import/importText.js";
import { TASK_PRIORITIES } from "../../../../shared/crmVocab.js";
import { istToday } from "../progress/progressText.js";

const EMPTY = { title: "", due_date: "", priority: "normal", note: "", owner_id: "" };

export default function TaskDialog({ open, canAssign, staff, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [doctor, setDoctor] = useState(null);
  const [q, setQ] = useState("");
  const term = useDebounced(q, 300);
  const [matches, setMatches] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, due_date: istToday() });
    setDoctor(null);
    setQ("");
    setMatches([]);
    setErrors({});
    setErr(null);
  }, [open]);

  useEffect(() => {
    if (!open || doctor || term.trim().length < 2) {
      setMatches([]);
      return;
    }
    let alive = true;
    api
      .get("/api/crm/home/doctors", { params: { q: term.trim(), page: 1 } })
      .then(({ data }) => alive && setMatches(data.rows.slice(0, 6)))
      .catch(() => alive && setMatches([]));
    return () => {
      alive = false;
    };
  }, [term, open, doctor]);

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const check = () => {
    const next = {};
    const title = form.title.trim();
    if (title.length < 3) next.title = "Write what needs doing, like Send the CME invite.";
    if (!form.due_date) next.due_date = "Choose a due date.";
    else if (form.due_date < istToday()) next.due_date = "The due date cannot be in the past.";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async () => {
    if (!check()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.post("/api/crm/tasks", {
        title: form.title,
        due_date: form.due_date,
        priority: form.priority,
        note: form.note,
        doctor_id: doctor?.doctor_id,
        owner_id: canAssign ? form.owner_id || undefined : undefined,
      });
      onSaved();
    } catch (e) {
      if (e?.response?.data?.fields) setErrors(e.response.data.fields);
      setErr(errorText(e, "Unable to add the task. Please try again."));
    } finally {
      setBusy(false);
    }
  };

  const fieldErr = (key) =>
    errors[key] && (
      <span className="dfm__err" id={`task-${key}-err`}>
        {errors[key]}
      </span>
    );

  return (
    <ConfirmModal
      open={open}
      variant="primary"
      title="Add a task"
      cancelLabel="Cancel"
      confirmLabel={busy ? "Adding…" : "Add task"}
      onCancel={onClose}
      onConfirm={save}
      busy={busy}
      error={err}
      message={
        <div className="dfm__dialog">
          <div className="dfm__field">
            <label className="dfm__label" htmlFor="task-title">
              What needs doing
            </label>
            <input
              id="task-title"
              className="rep__input"
              value={form.title}
              maxLength={200}
              onChange={set("title")}
              placeholder="Send the CME invite"
              aria-invalid={Boolean(errors.title)}
              aria-describedby={errors.title ? "task-title-err" : undefined}
            />
            {fieldErr("title")}
          </div>
          <div className="dfm__field">
            <label className="dfm__label" htmlFor="task-doctor">
              Doctor (optional)
            </label>
            {doctor ? (
              <div className="tsk__picked">
                <span>
                  <strong>{doctor.full_name}</strong>
                  {doctor.area ? ` · ${doctor.area}` : ""}
                </span>
                <button type="button" className="asg__link" onClick={() => setDoctor(null)}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  id="task-doctor"
                  className="rep__input"
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search by doctor name, area or mobile"
                  autoComplete="off"
                />
                {matches.length > 0 && (
                  <ul className="tsk__matches" aria-label="Matching doctors">
                    {matches.map((d) => (
                      <li key={d.doctor_id}>
                        <button
                          type="button"
                          onClick={() => {
                            setDoctor(d);
                            setQ("");
                          }}
                        >
                          <strong>{d.full_name}</strong>
                          {[d.area, d.mobile].filter(Boolean).length > 0 &&
                            ` · ${[d.area, d.mobile].filter(Boolean).join(" · ")}`}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {fieldErr("doctor_id")}
          </div>
          <div className="tsk__pair">
            <div className="dfm__field">
              <label className="dfm__label" htmlFor="task-due">
                Due date
              </label>
              <input
                id="task-due"
                className="rep__input"
                type="date"
                min={istToday()}
                value={form.due_date}
                onChange={set("due_date")}
                aria-invalid={Boolean(errors.due_date)}
                aria-describedby={errors.due_date ? "task-due_date-err" : undefined}
              />
              {fieldErr("due_date")}
            </div>
            <div className="dfm__field">
              <label className="dfm__label" htmlFor="task-priority">
                Priority
              </label>
              <select
                id="task-priority"
                className="rep__input"
                value={form.priority}
                onChange={set("priority")}
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {canAssign && (
            <div className="dfm__field">
              <label className="dfm__label" htmlFor="task-owner">
                Assign to
              </label>
              <select
                id="task-owner"
                className="rep__input"
                value={form.owner_id}
                onChange={set("owner_id")}
              >
                <option value="">Me</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
              {fieldErr("owner_id")}
            </div>
          )}
          <div className="dfm__field">
            <label className="dfm__label" htmlFor="task-note">
              Note (optional)
            </label>
            <textarea
              id="task-note"
              className="rep__notes"
              rows={2}
              maxLength={1000}
              value={form.note}
              onChange={set("note")}
            />
          </div>
        </div>
      }
    />
  );
}
