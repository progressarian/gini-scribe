import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import "./GHMPage.css";

const API_URL = import.meta.env.VITE_API_URL || "";
const getToken = () => localStorage.getItem("gini_auth_token") || "";

const api = (url, opts = {}) =>
  fetch(`${API_URL}${url}`, {
    ...opts,
    headers: {
      "x-auth-token": getToken(),
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  }).then((r) => r.json());

const safeArr = (v) => (Array.isArray(v) ? v : []);
const todayStr = () => new Date().toISOString().split("T")[0];

// ─── Call status options ───────────────────────────────────────────────────
const CALL_STATUSES = [
  { value: "pending", label: "Not Called Yet", color: "gray" },
  { value: "called", label: "✅ Called / Spoke", color: "green" },
  { value: "not_picked", label: "📵 Not Picked Up", color: "red" },
  { value: "rescheduled", label: "📅 Rescheduled", color: "blue" },
  { value: "call_later", label: "🕐 Will Call Later", color: "amber" },
  { value: "no_call_needed", label: "⏭ No Call Needed", color: "gray" },
];

const SHOW_STATUSES = [
  { value: "", label: "— Not Marked", color: "gray" },
  { value: "Show", label: "✅ Patient Came", color: "green" },
  { value: "No Show", label: "❌ Did Not Come", color: "red" },
];

const RECOVERY_STATUSES = [
  { value: "", label: "—", color: "gray" },
  { value: "Yes", label: "🟢 Improving", color: "green" },
  { value: "No", label: "🔴 Not Improving", color: "red" },
];

// Outcomes for an individual call attempt (richer than the row summary)
const ATTEMPT_OUTCOMES = [
  { value: "called", label: "✅ Called / Spoke", color: "green" },
  { value: "not_picked", label: "📵 Not Picked Up", color: "red" },
  { value: "busy", label: "📞 Busy", color: "amber" },
  { value: "switched_off", label: "🔌 Switched Off", color: "amber" },
  { value: "wrong_number", label: "❓ Wrong Number", color: "red" },
  { value: "rescheduled", label: "📅 Rescheduled", color: "blue" },
  { value: "call_later", label: "🕐 Will Call Later", color: "amber" },
];
const attemptLabel = (v) => ATTEMPT_OUTCOMES.find((o) => o.value === v)?.label || v;
const attemptColor = (v) => ATTEMPT_OUTCOMES.find((o) => o.value === v)?.color || "gray";

function fmtDateTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

const TIME_SLOTS = [
  "9:30 AM to 10 AM", "10 AM to 11 AM", "11 AM to 12 PM",
  "12 PM to 1 PM", "1 PM to 2 PM", "2 PM to 2:30 PM",
  "2:30 PM to 3 PM", "3 PM to 3:30 PM", "3:30 PM to 4 PM",
];

const VISIT_TYPES = [
  "New", "Follow Up", "6 weeks", "12 weeks", "18 weeks",
  "24 weeks", "48 weeks", "56 weeks", "FU within week",
];

const callColor = (v) => CALL_STATUSES.find((s) => s.value === v)?.color || "gray";
const showColor = (v) => SHOW_STATUSES.find((s) => s.value === v)?.color || "gray";

// ─── Custom dropdown — shows max 7 items then scrolls ────────────────────
function DocDropdown({ value, options, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef();

  // Close when clicking outside
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const select = (val) => {
    onChange(val);
    setOpen(false);
  };
  const label = value === "All" || !value ? "All Doctors" : value;

  return (
    <div className="doc-dd" ref={ref}>
      <button type="button" className="doc-dd__btn ctrl" onClick={() => setOpen((o) => !o)}>
        <span className="doc-dd__label">{label}</span>
        <span className="doc-dd__arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="doc-dd__list">
          <div
            className={`doc-dd__item ${value === "All" ? "doc-dd__item--active" : ""}`}
            onMouseDown={() => select("All")}
          >
            All Doctors
          </div>
          {options.map((d) => (
            <div
              key={d}
              className={`doc-dd__item ${value === d ? "doc-dd__item--active" : ""}`}
              onMouseDown={() => select(d)}
            >
              {d}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Inline text/date cell that saves on blur / Enter ─────────────────────
function InlineEdit({ value, onChange, type = "text", placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || "");
  const ref = useRef();

  // Keep draft in sync if value changes while not editing
  useEffect(() => {
    if (!editing) setDraft(value || "");
  }, [value, editing]);

  const open = () => {
    setDraft(value || "");
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (v !== (value || "").trim()) onChange(v);
  };

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <span className={`ie-text ${!value ? "ie-empty" : ""}`} onClick={open} title="Click to edit">
        {value || <span className="ie-placeholder">{placeholder || "—"}</span>}
      </span>
    );
  }

  return type === "date" ? (
    <input
      ref={ref}
      type="date"
      value={draft}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        setEditing(false);
        if (v !== (value || "")) onChange(v);
      }}
      onBlur={() => setEditing(false)}
      className="ie-input"
    />
  ) : (
    <input
      ref={ref}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setEditing(false);
      }}
      placeholder={placeholder}
      className="ie-input"
    />
  );
}

// ─── Colored dropdown ──────────────────────────────────────────────────────
function ColorSelect({ value, options, onChange }) {
  const color = options.find((o) => o.value === value)?.color || "gray";
  return (
    <select
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
      className={`csel csel--${color}`}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

// ─── Biomarker cell — auto from lab data, shows latest 2 with trend ─────────
function fmtNum(v) {
  if (v == null) return null;
  // result_text may be "10.2%" or "95.2mg/dL"; extract leading number
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function BioRow({ label, readings }) {
  if (!readings || !readings.length) return null;
  // readings[0] = latest, readings[1] = previous
  const latest = readings[0];
  const prev = readings[1];
  const lv = fmtNum(latest.v);
  const pv = prev ? fmtNum(prev.v) : null;

  let trend = null;
  if (lv != null && pv != null) {
    if (lv < pv) trend = { arrow: "↓", cls: "bio-down" };   // lower sugar = improving
    else if (lv > pv) trend = { arrow: "↑", cls: "bio-up" };
    else trend = { arrow: "→", cls: "bio-flat" };
  }

  return (
    <div className="bio-row">
      <span className="bio-label">{label}</span>
      {prev && <span className="bio-prev">{fmtNum(prev.v)}</span>}
      {prev && <span className="bio-sep">→</span>}
      <span className="bio-latest">{fmtNum(latest.v)}</span>
      {trend && <span className={`bio-arrow ${trend.cls}`}>{trend.arrow}</span>}
    </div>
  );
}

function BiomarkerCell({ bio }) {
  if (!bio || (!bio.hba1c?.length && !bio.fbs?.length)) {
    return <span className="muted">No labs</span>;
  }
  return (
    <div className="bio-cell">
      <BioRow label="HbA1c" readings={bio.hba1c} />
      <BioRow label="FBS" readings={bio.fbs} />
    </div>
  );
}

// ─── Summary bar ──────────────────────────────────────────────────────────
function Summary({ rows }) {
  const total = rows.length;
  const came = rows.filter((r) => r.show_no_show === "Show").length;
  const noShow = rows.filter((r) => r.show_no_show === "No Show").length;
  const pendingShow = total - came - noShow;
  const called = rows.filter((r) => r.call_status === "called").length;
  const notPicked = rows.filter((r) => r.call_status === "not_picked").length;
  const rescheduled = rows.filter((r) => r.call_status === "rescheduled").length;
  const notCalled = rows.filter((r) => !r.call_status || r.call_status === "pending").length;
  const fu = rows.filter(
    (r) => r.visit_type && !r.visit_type.toLowerCase().startsWith("new"),
  ).length;
  const improving = rows.filter((r) => r.pt_recovery === "Yes").length;
  const notImproving = rows.filter((r) => r.pt_recovery === "No").length;

  return (
    <div className="summary">
      <div className="summary__group">
        <div className="summary__label">Appointments</div>
        <div className="summary__pills">
          <span className="spill">{total} Total</span>
          <span className="spill spill--green">{came} Patient Came</span>
          <span className="spill spill--red">{noShow} Did Not Come</span>
          <span className="spill spill--gray">{pendingShow} Pending</span>
          <span className="spill spill--amber">{fu} Follow-up</span>
        </div>
      </div>
      <div className="summary__sep" />
      <div className="summary__group">
        <div className="summary__label">Calling</div>
        <div className="summary__pills">
          <span className="spill spill--orange">{notCalled} Need to Call</span>
          <span className="spill spill--green">{called} Spoke</span>
          <span className="spill spill--red">{notPicked} Not Picked</span>
          <span className="spill spill--blue">{rescheduled} Rescheduled</span>
        </div>
      </div>
      <div className="summary__sep" />
      <div className="summary__group">
        <div className="summary__label">Recovery</div>
        <div className="summary__pills">
          <span className="spill spill--green">{improving} Improving</span>
          <span className="spill spill--red">{notImproving} Not Improving</span>
        </div>
      </div>
    </div>
  );
}

// ─── New Appointment modal ─────────────────────────────────────────────────
function NewAppointmentModal({ doctors, defaultDate, prefill, onClose, onCreated }) {
  const isPrefilled = !!prefill?.patient_name;
  const [form, setForm] = useState({
    patient_name: prefill?.patient_name || "",
    file_no: prefill?.file_no || "",
    phone: prefill?.phone || "",
    doctor_name: prefill?.doctor_name || doctors[0] || "",
    appointment_date: defaultDate,
    time_slot: "",
    // A repeat booking for a known patient is almost always a follow-up
    visit_type: isPrefilled ? "Follow Up" : "New",
    condition: prefill?.condition || "",
    booked_by_name: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Phone: keep digits only, cap at 10
  const setPhone = (v) => set("phone", v.replace(/\D/g, "").slice(0, 10));

  const save = async () => {
    const name = form.patient_name.trim();
    if (!name) return setErr("Patient name is required");
    if (!/^[A-Za-z.\s'-]+$/.test(name))
      return setErr("Patient name should contain letters only");
    if (!form.doctor_name) return setErr("Please select a doctor");
    if (!form.appointment_date) return setErr("Please select a date");
    // Phone is optional, but if entered must be exactly 10 digits
    if (form.phone && !/^\d{10}$/.test(form.phone))
      return setErr("Mobile number must be exactly 10 digits");
    // A brand-new patient (no file no) needs a phone to be reachable
    if (!form.file_no.trim() && !form.phone)
      return setErr("Mobile number is required for a new patient");
    if (form.file_no && !/^[A-Za-z0-9_-]+$/.test(form.file_no.trim()))
      return setErr("File No can only contain letters, numbers, _ and -");

    setSaving(true);
    setErr("");
    try {
      const res = await api("/api/ghm-appointments", {
        method: "POST",
        body: JSON.stringify(form),
      });
      if (res?.error) {
        setErr(res.error);
        setSaving(false);
        return;
      }
      onCreated(form.appointment_date);
    } catch {
      setErr("Could not save. Please try again.");
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__hdr">
          <span>{isPrefilled ? `➕ Book Next Appointment — ${prefill.patient_name}` : "➕ New Appointment"}</span>
          <button className="modal__x" onClick={onClose}>✕</button>
        </div>

        <div className="modal__body">
          {err && <div className="modal__err">{err}</div>}
          {isPrefilled && (
            <div className="modal__prefill-note">
              ✓ Patient details auto-filled. Just pick the date, slot &amp; doctor.
            </div>
          )}

          <div className="fgrid">
            <label className="fld fld--wide">
              <span>Patient Name *</span>
              <input value={form.patient_name} onChange={(e) => set("patient_name", e.target.value)} placeholder="Full name" autoFocus />
            </label>
            <label className="fld">
              <span>File No <em className="fld__opt">(blank = new patient)</em></span>
              <input value={form.file_no} onChange={(e) => set("file_no", e.target.value)} placeholder="Leave blank for new patient" />
            </label>
            <label className="fld">
              <span>Mobile {form.phone && form.phone.length !== 10 && <em className="fld__warn">{form.phone.length}/10</em>}</span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={form.phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="10-digit number"
              />
            </label>
            <label className="fld">
              <span>Date *</span>
              <input type="date" value={form.appointment_date} onChange={(e) => set("appointment_date", e.target.value)} />
            </label>
            <label className="fld">
              <span>Time Slot</span>
              <select value={form.time_slot} onChange={(e) => set("time_slot", e.target.value)}>
                <option value="">— Select slot</option>
                {TIME_SLOTS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="fld fld--wide">
              <span>Doctor *</span>
              <select value={form.doctor_name} onChange={(e) => set("doctor_name", e.target.value)}>
                <option value="">— Select doctor</option>
                {doctors.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="fld">
              <span>Visit Type</span>
              <select value={form.visit_type} onChange={(e) => set("visit_type", e.target.value)}>
                {VISIT_TYPES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <label className="fld">
              <span>Condition</span>
              <input value={form.condition} onChange={(e) => set("condition", e.target.value)} placeholder="Diabetes / Thyroid…" />
            </label>
            <label className="fld">
              <span>Booked By</span>
              <input value={form.booked_by_name} onChange={(e) => set("booked_by_name", e.target.value)} placeholder="Your name" />
            </label>
            <label className="fld fld--wide">
              <span>Notes</span>
              <input value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Any note…" />
            </label>
          </div>

          <p className="modal__hint">
            📱 WhatsApp message &amp; reporting time are generated automatically after booking.
            <br />🆕 If File No is blank, a new patient record is created automatically with a new File No.
          </p>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? "Booking…" : "Book Appointment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Call history expandable row content ───────────────────────────────────
function CallHistoryPanel({ row, ccAgents, onLogged, onDeleted, colSpan }) {
  const [history, setHistory] = useState(null); // null = loading
  const [outcome, setOutcome] = useState("not_picked");
  const [calledBy, setCalledBy] = useState("");
  const [notes, setNotes] = useState("");
  const [reschedule, setReschedule] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDel, setConfirmDel] = useState(null); // attempt object pending delete
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(() => {
    api(`/api/call-attempts?appointment_id=${row.id}`)
      .then((d) => setHistory(safeArr(d)))
      .catch(() => setHistory([]));
  }, [row.id]);

  useEffect(() => { load(); }, [load]);

  const logAttempt = async () => {
    if (!outcome) return;
    setSaving(true);
    const res = await api("/api/call-attempts", {
      method: "POST",
      body: JSON.stringify({
        appointment_id: row.id,
        outcome,
        called_by: calledBy.trim() || null,
        notes: notes.trim() || null,
        reschedule_date: outcome === "rescheduled" ? reschedule || null : null,
      }),
    });
    setSaving(false);
    if (res?.error) return;
    // reset form, reload history, tell parent to refresh summary/badge
    setNotes("");
    setReschedule("");
    load();
    onLogged?.();
  };

  const confirmDelete = async () => {
    if (!confirmDel) return;
    setDeleting(true);
    const res = await api(`/api/call-attempts/${confirmDel.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmDel(null);
    if (res?.error) return;
    load();
    onDeleted?.();
  };

  return (
    <tr className="hist-row">
      <td colSpan={colSpan} className="hist-cell">
        <div className="hist-wrap">
          <div className="hist-title">📞 Call History — {row.patient_name}</div>

          {history === null ? (
            <div className="hist-loading">Loading history…</div>
          ) : history.length === 0 ? (
            <div className="hist-empty">No calls logged yet. Add the first attempt below.</div>
          ) : (
            <div className="hist-list">
              {history.map((h) => (
                <div key={h.id} className="hist-item">
                  <span className="hist-no">#{h.attempt_no}</span>
                  <span className="hist-when">{fmtDateTime(h.called_at)}</span>
                  <span className={`badge badge--${attemptColor(h.outcome)}`}>{attemptLabel(h.outcome)}</span>
                  {h.called_by && <span className="hist-by">— {h.called_by}</span>}
                  {h.reschedule_date && <span className="hist-resch">→ {h.reschedule_date}</span>}
                  {h.notes && <span className="hist-notes">“{h.notes}”</span>}
                  <button
                    className="hist-del"
                    title="Delete this call log"
                    onClick={() => setConfirmDel(h)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="hist-form">
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={`csel csel--${attemptColor(outcome)}`}>
              {ATTEMPT_OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input
              list="cc-agents-list"
              value={calledBy}
              onChange={(e) => setCalledBy(e.target.value)}
              placeholder="Called by"
              className="hist-input hist-input--by"
            />
            {outcome === "rescheduled" && (
              <input type="date" value={reschedule} onChange={(e) => setReschedule(e.target.value)} className="hist-input" />
            )}
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") logAttempt(); }}
              placeholder="What happened / patient said…"
              className="hist-input hist-input--notes"
            />
            <button className="btn btn--primary hist-log-btn" onClick={logAttempt} disabled={saving}>
              {saving ? "Saving…" : "+ Log Call"}
            </button>
          </div>
        </div>

        {/* Delete confirmation dialog */}
        {confirmDel && (
          <div className="cdlg-overlay" onClick={() => !deleting && setConfirmDel(null)}>
            <div className="cdlg" onClick={(e) => e.stopPropagation()}>
              <div className="cdlg__icon">🗑️</div>
              <div className="cdlg__title">Delete this call log?</div>
              <div className="cdlg__body">
                <div className="cdlg__line">
                  <strong>#{confirmDel.attempt_no}</strong> · {fmtDateTime(confirmDel.called_at)}
                </div>
                <span className={`badge badge--${attemptColor(confirmDel.outcome)}`}>
                  {attemptLabel(confirmDel.outcome)}
                </span>
                {confirmDel.called_by && <span className="cdlg__by">— {confirmDel.called_by}</span>}
                {confirmDel.notes && <div className="cdlg__notes">“{confirmDel.notes}”</div>}
              </div>
              <div className="cdlg__hint">This action cannot be undone.</div>
              <div className="cdlg__actions">
                <button className="btn btn--ghost" onClick={() => setConfirmDel(null)} disabled={deleting}>
                  Cancel
                </button>
                <button className="btn btn--danger" onClick={confirmDelete} disabled={deleting}>
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}
      </td>
    </tr>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────
export default function GHMPage() {
  const [date, setDate] = useState(todayStr());
  const [showNew, setShowNew] = useState(false);
  const [newPrefill, setNewPrefill] = useState(null);
  const [doctor, setDoctor] = useState("All");
  const [doctors, setDoctors] = useState([]);
  const [ccAgents, setCcAgents] = useState([]);
  const [filter, setFilter] = useState("all"); // all | need_call | came | no_show
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState([]);
  const [biomarkers, setBiomarkers] = useState({}); // { patient_id: { hba1c:[], fbs:[] } }
  const [attemptCounts, setAttemptCounts] = useState({}); // { appointment_id: count }
  const [expanded, setExpanded] = useState(null); // appointment_id of open history row
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState({});

  // ── Load doctors + CC agents once on mount ───────────────────────────────
  useEffect(() => {
    api("/api/ghm-appointments/doctors")
      .then((data) => setDoctors(safeArr(data).map((d) => d.doctor_name)))
      .catch(() => {});

    api("/api/cc-calling/agents")
      .then((data) => setCcAgents(safeArr(data).map((a) => a.name)))
      .catch(() => {});
  }, []);

  // ── Fetch ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ date, limit: 200 });
      if (doctor !== "All") p.set("doctor", doctor);
      const res = await api(`/api/ghm-appointments?${p}`);
      const data = safeArr(res?.data);
      setRows(data);

      // Fetch biomarkers for all patients in one batch call
      const pids = [...new Set(data.map((r) => r.patient_id).filter(Boolean))];
      if (pids.length) {
        api("/api/ghm-appointments/biomarkers", {
          method: "POST",
          body: JSON.stringify({ patient_ids: pids }),
        })
          .then((bm) => setBiomarkers(bm || {}))
          .catch(() => setBiomarkers({}));
      } else {
        setBiomarkers({});
      }

      // Fetch call-attempt counts for the badge (one batch call)
      const apptIds = data.map((r) => r.id).filter(Boolean);
      if (apptIds.length) {
        api("/api/call-attempts/counts", {
          method: "POST",
          body: JSON.stringify({ appointment_ids: apptIds }),
        })
          .then((c) => setAttemptCounts(c || {}))
          .catch(() => setAttemptCounts({}));
      } else {
        setAttemptCounts({});
      }
    } finally {
      setLoading(false);
    }
  }, [date, doctor]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Patch one field on an appointment row ────────────────────────────────
  const patch = useCallback(async (id, field, value) => {
    setSaving((s) => ({ ...s, [id]: true }));
    // Optimistic update
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    await api(`/api/ghm-appointments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ [field]: value }),
    });
    setSaving((s) => ({ ...s, [id]: false }));
  }, []);

  // ── When call status set to "called", auto-fill today's date ─────────────
  const handleCallStatus = useCallback(
    (row, value) => {
      patch(row.id, "call_status", value);
      if (value === "called" && !row.call_date) {
        patch(row.id, "call_date", todayStr());
      }
    },
    [patch],
  );

  // ── Filter + search ───────────────────────────────────────────────────────
  const visible = rows.filter((r) => {
    if (filter === "need_call" && r.call_status && r.call_status !== "pending") return false;
    if (filter === "came" && r.show_no_show !== "Show") return false;
    if (filter === "no_show" && r.show_no_show !== "No Show") return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        r.patient_name?.toLowerCase().includes(q) ||
        r.file_no?.toLowerCase().includes(q) ||
        r.phone?.includes(q) ||
        r.condition?.toLowerCase().includes(q)
      );
    }
    return true;
  });

  const needCall = rows.filter((r) => !r.call_status || r.call_status === "pending").length;
  const isToday = date === todayStr();

  return (
    <div className="ghm">
      {/* CC agents datalist — used by all "Called By" inputs */}
      <datalist id="cc-agents-list">
        {ccAgents.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      {/* ── Header ── */}
      <div className="ghm__hdr">
        <div className="ghm__title">
          <h1>Daily Patient Sheet</h1>
          <span className="ghm__datelab">{isToday ? "Today" : date}</span>
        </div>
        <div className="ghm__controls">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="ctrl"
          />
          <DocDropdown value={doctor} options={doctors} onChange={setDoctor} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search patient, file no…"
            className="ctrl ctrl--search"
          />
          <button className="btn btn--primary" onClick={() => { setNewPrefill(null); setShowNew(true); }}>
            ➕ New Appointment
          </button>
        </div>
      </div>

      {/* ── New Appointment modal ── */}
      {showNew && (
        <NewAppointmentModal
          doctors={doctors}
          defaultDate={date}
          prefill={newPrefill}
          onClose={() => { setShowNew(false); setNewPrefill(null); }}
          onCreated={(createdDate) => {
            setShowNew(false);
            setNewPrefill(null);
            if (createdDate === date) load();
            else setDate(createdDate);
          }}
        />
      )}

      {/* ── Summary ── */}
      {!loading && rows.length > 0 && <Summary rows={rows} />}

      {/* ── Quick filters ── */}
      <div className="qfilter">
        {[
          { id: "all", label: `All  (${rows.length})` },
          { id: "need_call", label: `📞 Need to Call  (${needCall})`, highlight: needCall > 0 },
          { id: "came", label: `✅ Patient Came` },
          { id: "no_show", label: `❌ Did Not Come` },
        ].map((f) => (
          <button
            key={f.id}
            className={`qfilter__btn ${filter === f.id ? "qfilter__btn--active" : ""} ${f.highlight ? "qfilter__btn--alert" : ""}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
        <span className="qfilter__hint">Click any cell to edit · saves automatically</span>
      </div>

      {/* ── Loading ── */}
      {loading && (
        <div className="ghm__loading">
          <div className="spinner" />
          Loading…
        </div>
      )}

      {/* ── Empty ── */}
      {!loading && visible.length === 0 && (
        <div className="ghm__empty">
          <div className="ghm__empty-icon">📋</div>
          <div className="ghm__empty-title">
            {rows.length === 0
              ? `No appointments found for ${date}`
              : "No patients match this filter"}
          </div>
          {rows.length === 0 && (
            <div className="ghm__empty-sub">
              Select a different date or check if appointments have been booked.
            </div>
          )}
        </div>
      )}

      {/* ── Table ── */}
      {!loading && visible.length > 0 && (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 115 }}>Time Slot</th>
                <th style={{ minWidth: 170 }}>Patient</th>
                <th style={{ width: 155 }}>Biomarkers (auto)</th>
                <th style={{ width: 100 }}>Visit Type</th>
                <th style={{ width: 220 }}>Doctor</th>
                <th style={{ width: 150 }}>Show / No Show</th>
                <th style={{ width: 170 }}>Call Status</th>
                <th style={{ width: 150 }}>Recovery</th>
                <th style={{ width: 100 }}>Called By</th>
                <th style={{ width: 105 }}>Call Date</th>
                <th style={{ minWidth: 210 }}>Notes / Reason</th>
                <th style={{ width: 150 }}>Reschedule Date</th>
                <th style={{ width: 130 }}>Follow-up Date</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row, i) => {
                const isSaving = saving[row.id];
                const callStat = row.call_status || "pending";
                const showStat = row.show_no_show || "";

                const isOpen = expanded === row.id;
                const attempts = attemptCounts[row.id] || 0;

                return (
                  <Fragment key={row.id}>
                  <tr
                    className={[
                      "tbl__row",
                      showStat === "Show" ? "tbl__row--came" : "",
                      showStat === "No Show" ? "tbl__row--noshow" : "",
                      callStat === "not_picked" ? "tbl__row--notpicked" : "",
                      isSaving ? "tbl__row--saving" : "",
                      isOpen ? "tbl__row--open" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {/* Chevron toggle */}
                    <td className="tc">
                      <button
                        className={`chev ${isOpen ? "chev--open" : ""}`}
                        title="Show call history"
                        onClick={() => setExpanded(isOpen ? null : row.id)}
                      >
                        ▸
                      </button>
                    </td>

                    {/* # */}
                    <td className="tc">
                      <span className="rnum">{i + 1}</span>
                    </td>

                    {/* Time */}
                    <td>
                      <span className="fw7 fs12 nowrap">
                        {row.reporting_time_slot || row.time_slot || "—"}
                      </span>
                    </td>

                    {/* Patient */}
                    <td>
                      <div className="pcell">
                        <span className="pcell__name">{row.patient_name || "—"}</span>
                        {row.file_no && <span className="pcell__file">{row.file_no}</span>}
                        {row.phone && <span className="pcell__ph">📞 {row.phone}</span>}
                        {row.condition && <span className="pcell__cond">{row.condition}</span>}
                        <button
                          className="book-next-btn"
                          title="Book next appointment for this patient"
                          onClick={() => {
                            setNewPrefill({
                              patient_name: row.patient_name,
                              file_no: row.file_no,
                              phone: row.phone,
                              condition: row.condition,
                              doctor_name: row.doctor_name,
                            });
                            setShowNew(true);
                          }}
                        >
                          ➕ Book next
                        </button>
                      </div>
                    </td>

                    {/* Biomarkers — auto from lab data */}
                    <td>
                      <BiomarkerCell bio={biomarkers[row.patient_id]} />
                    </td>

                    {/* Visit type */}
                    <td>
                      {row.visit_type && (
                        <span
                          className={`badge badge--${row.visit_type.toLowerCase().startsWith("new") ? "blue" : "amber"}`}
                        >
                          {row.visit_type}
                        </span>
                      )}
                    </td>

                    {/* Doctor — assignable */}
                    <td>
                      <select
                        value={row.doctor_name || ""}
                        onChange={(e) => patch(row.id, "doctor_name", e.target.value)}
                        className="doc-assign-sel"
                      >
                        <option value="">— Assign Doctor</option>
                        {doctors.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                    </td>

                    {/* Came? */}
                    <td>
                      <ColorSelect
                        value={row.show_no_show}
                        options={SHOW_STATUSES}
                        onChange={(v) => patch(row.id, "show_no_show", v)}
                      />
                    </td>

                    {/* Call status */}
                    <td>
                      <div className="callstat-cell">
                        <ColorSelect
                          value={callStat}
                          options={CALL_STATUSES}
                          onChange={(v) => handleCallStatus(row, v)}
                        />
                        {attempts > 0 && (
                          <button
                            className="attempt-badge"
                            title={`${attempts} call attempt(s) — click to view history`}
                            onClick={() => setExpanded(isOpen ? null : row.id)}
                          >
                            📞 ×{attempts}
                          </button>
                        )}
                      </div>
                    </td>

                    {/* Recovery — is patient improving? */}
                    <td>
                      <ColorSelect
                        value={row.pt_recovery}
                        options={RECOVERY_STATUSES}
                        onChange={(v) => patch(row.id, "pt_recovery", v)}
                      />
                    </td>

                    {/* Called by — datalist: pick from DB or type manually */}
                    <td>
                      <input
                        list="cc-agents-list"
                        defaultValue={row.call_made_by || ""}
                        key={`cb-${row.id}-${row.call_made_by}`}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          if (v !== (row.call_made_by || "")) patch(row.id, "call_made_by", v);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") e.target.blur();
                        }}
                        placeholder="CC name"
                        className="cc-input"
                      />
                    </td>

                    {/* Call date */}
                    <td>
                      <InlineEdit
                        value={row.call_date}
                        onChange={(v) => patch(row.id, "call_date", v)}
                        type="date"
                      />
                    </td>

                    {/* Notes / reason */}
                    <td>
                      <InlineEdit
                        value={row.call_notes}
                        onChange={(v) => patch(row.id, "call_notes", v)}
                        placeholder="Patient said… / reason…"
                      />
                    </td>

                    {/* Reschedule date — only visible when status is Rescheduled */}
                    <td>
                      {callStat === "rescheduled" ? (
                        <input
                          type="date"
                          value={row.call_reschedule_date || ""}
                          onChange={(e) => patch(row.id, "call_reschedule_date", e.target.value)}
                          className="rsd-input"
                        />
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>

                    {/* Follow-up date — auto from next booked appointment */}
                    <td>
                      {row.follow_up_date ? (
                        <div className="fu-cell">
                          <span className="fu-date">{row.follow_up_date}</span>
                          {row.follow_up_time && (
                            <span className="fu-time">{row.follow_up_time}</span>
                          )}
                        </div>
                      ) : (
                        <span className="muted">Not booked</span>
                      )}
                    </td>
                  </tr>

                  {isOpen && (
                    <CallHistoryPanel
                      row={row}
                      ccAgents={ccAgents}
                      colSpan={14}
                      onLogged={() => {
                        // refresh badge count + row summary after logging
                        setAttemptCounts((c) => ({ ...c, [row.id]: (c[row.id] || 0) + 1 }));
                        load();
                      }}
                      onDeleted={() => {
                        // refresh badge count + row summary after delete
                        setAttemptCounts((c) => ({ ...c, [row.id]: Math.max(0, (c[row.id] || 0) - 1) }));
                        load();
                      }}
                    />
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
