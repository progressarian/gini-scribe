import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import "./GHMPage.css";
import useAuthStore from "../stores/authStore";
import { SLOT_REASON, slotOptions } from "../lib/slotAvailability.js";

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
// date N days from today as YYYY-MM-DD
const addDaysStr = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
};
// pretty label like "Wed, 4 Jun"
const prettyDate = (s) => {
  if (!s) return "";
  const d = new Date(s + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

// The day-view tabs
const VIEW_TABS = [
  { id: "by_date", label: "📅 By Date", offset: null },
  { id: "tomorrow", label: "🌅 Tomorrow", offset: 1 },
  { id: "fu3", label: "📞 Follow-up in 3 Days", offset: 3 },
  { id: "lookup", label: "🔎 Patient Lookup", offset: null },
  { id: "reassign", label: "🔄 Reassign Needed", offset: null },
];

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
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

// Slot catalog + unavailability-reason labels come from ../lib/slotAvailability.

const VISIT_TYPES = [
  "New",
  "Follow Up",
  "6 weeks",
  "12 weeks",
  "18 weeks",
  "24 weeks",
  "48 weeks",
  "56 weeks",
  "FU within week",
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
function InlineEdit({ value, onChange, type = "text", placeholder, multiline = false }) {
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
      <span
        className={`ie-text ${!value ? "ie-empty" : ""} ${multiline ? "ie-text--multi" : ""}`}
        onClick={open}
        title="Click to edit"
      >
        {value || <span className="ie-placeholder">{placeholder || "—"}</span>}
      </span>
    );
  }

  if (type === "date") {
    return (
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
    );
  }

  if (multiline) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={3}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Enter adds a new line; Ctrl/Cmd+Enter or Escape commits/closes
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder={placeholder}
        className="ie-input ie-textarea"
      />
    );
  }

  return (
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
    if (lv < pv)
      trend = { arrow: "↓", cls: "bio-down" }; // lower sugar = improving
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

  return (
    <div className="summary">
      <div className="summary__group">
        <div className="summary__label">Appointments</div>
        <div className="summary__pills">
          <span className="spill">{total} Total</span>
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
  // Availability for the selected doctor+date. null ⇒ use plain catalog slots
  // (doctor not configured / unknown).
  const [availSlots, setAvailSlots] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Fetch the doctor's day availability so we can grey out unbookable slots.
  useEffect(() => {
    const doctor = form.doctor_name;
    const date = form.appointment_date;
    if (!doctor || !date) {
      setAvailSlots(null);
      return;
    }
    let cancelled = false;
    api(`/api/availability/day?doctor=${encodeURIComponent(doctor)}&date=${date}`)
      .then((d) => {
        if (cancelled) return;
        const slots = d?.resolved ? d.slots || [] : null;
        setAvailSlots(slots);
        // If the chosen slot just became unavailable, clear it.
        if (slots) {
          setForm((f) => {
            const sel = slots.find((x) => x.slot_label === f.time_slot);
            return sel && !sel.available ? { ...f, time_slot: "" } : f;
          });
        }
      })
      .catch(() => {
        if (!cancelled) setAvailSlots(null);
      });
    return () => {
      cancelled = true;
    };
  }, [form.doctor_name, form.appointment_date]);

  // Phone: keep digits only, cap at 10
  const setPhone = (v) => set("phone", v.replace(/\D/g, "").slice(0, 10));

  const save = async () => {
    const name = form.patient_name.trim();
    if (!name) return setErr("Patient name is required");
    if (!/^[A-Za-z.\s'-]+$/.test(name)) return setErr("Patient name should contain letters only");
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
          <span>
            {isPrefilled
              ? `➕ Book Next Appointment — ${prefill.patient_name}`
              : "➕ New Appointment"}
          </span>
          <button className="modal__x" onClick={onClose}>
            ✕
          </button>
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
              <input
                value={form.patient_name}
                onChange={(e) => set("patient_name", e.target.value)}
                placeholder="Full name"
                autoFocus
              />
            </label>
            <label className="fld">
              <span>
                File No <em className="fld__opt">(blank = new patient)</em>
              </span>
              <input
                value={form.file_no}
                onChange={(e) => set("file_no", e.target.value)}
                placeholder="Leave blank for new patient"
              />
            </label>
            <label className="fld">
              <span>
                Mobile{" "}
                {form.phone && form.phone.length !== 10 && (
                  <em className="fld__warn">{form.phone.length}/10</em>
                )}
              </span>
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
              <input
                type="date"
                value={form.appointment_date}
                onChange={(e) => set("appointment_date", e.target.value)}
              />
            </label>
            <label className="fld">
              <span>Time Slot</span>
              <select value={form.time_slot} onChange={(e) => set("time_slot", e.target.value)}>
                <option value="">— Select slot</option>
                {slotOptions(availSlots).map((s) => (
                  <option key={s.slot_label} value={s.slot_label} disabled={!s.available}>
                    {s.slot_label}
                    {s.available ? "" : ` — ${SLOT_REASON[s.blocked_by] || "Unavailable"}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld fld--wide">
              <span>Doctor *</span>
              <select value={form.doctor_name} onChange={(e) => set("doctor_name", e.target.value)}>
                <option value="">— Select doctor</option>
                {doctors.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Visit Type</span>
              <select value={form.visit_type} onChange={(e) => set("visit_type", e.target.value)}>
                {VISIT_TYPES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld">
              <span>Condition</span>
              <input
                value={form.condition}
                onChange={(e) => set("condition", e.target.value)}
                placeholder="Diabetes / Thyroid…"
              />
            </label>
            <label className="fld">
              <span>Booked By</span>
              <input
                value={form.booked_by_name}
                onChange={(e) => set("booked_by_name", e.target.value)}
                placeholder="Your name"
              />
            </label>
            <label className="fld fld--wide">
              <span>Notes</span>
              <input
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                placeholder="Any note…"
              />
            </label>
          </div>

          <p className="modal__hint">
            📱 WhatsApp message &amp; reporting time are generated automatically after booking.
            <br />
            🆕 If File No is blank, a new patient record is created automatically with a new File
            No.
          </p>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
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
  const [changes, setChanges] = useState([]); // doctor change history
  const [confirmChg, setConfirmChg] = useState(null); // change object pending delete

  const load = useCallback(() => {
    api(`/api/call-attempts?appointment_id=${row.id}`)
      .then((d) => setHistory(safeArr(d)))
      .catch(() => setHistory([]));
    api(`/api/appointment-changes?appointment_id=${row.id}`)
      .then((d) => setChanges(safeArr(d)))
      .catch(() => setChanges([]));
  }, [row.id]);

  useEffect(() => {
    load();
  }, [load]);

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

  const confirmDeleteChange = async () => {
    if (!confirmChg) return;
    setDeleting(true);
    const res = await api(`/api/appointment-changes/${confirmChg.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmChg(null);
    if (res?.error) return;
    load();
    onDeleted?.(); // refresh the main row so the reverted value shows
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
                  <span className={`badge badge--${attemptColor(h.outcome)}`}>
                    {attemptLabel(h.outcome)}
                  </span>
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

          {changes.length > 0 && (
            <div className="chg-section">
              <div className="chg-title">
                📝 Change History (Doctor / Preferred Date / Called By)
              </div>
              <div className="hist-list">
                {changes.map((c) => (
                  <div key={c.id} className="hist-item">
                    <span className="hist-when">{fmtDateTime(c.changed_at)}</span>
                    <span className="chg-field">{c.field_label}</span>
                    <span className="chg-old">{c.old_value || "—"}</span>
                    <span className="chg-arrow">→</span>
                    <span className="chg-new">{c.new_value || "—"}</span>
                    <button
                      className="hist-del"
                      title="Delete this change log"
                      onClick={() => setConfirmChg(c)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="hist-form">
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              className={`csel csel--${attemptColor(outcome)}`}
            >
              {ATTEMPT_OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              list="cc-agents-list"
              value={calledBy}
              onChange={(e) => setCalledBy(e.target.value)}
              placeholder="Called by"
              className="hist-input hist-input--by"
            />
            {outcome === "rescheduled" && (
              <input
                type="date"
                value={reschedule}
                onChange={(e) => setReschedule(e.target.value)}
                className="hist-input"
              />
            )}
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") logAttempt();
              }}
              placeholder="What happened / patient said…"
              className="hist-input hist-input--notes"
            />
            <button
              className="btn btn--primary hist-log-btn"
              onClick={logAttempt}
              disabled={saving}
            >
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
                <button
                  className="btn btn--ghost"
                  onClick={() => setConfirmDel(null)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button className="btn btn--danger" onClick={confirmDelete} disabled={deleting}>
                  {deleting ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Delete doctor-change confirmation dialog */}
        {confirmChg && (
          <div className="cdlg-overlay" onClick={() => !deleting && setConfirmChg(null)}>
            <div className="cdlg" onClick={(e) => e.stopPropagation()}>
              <div className="cdlg__icon">🗑️</div>
              <div className="cdlg__title">Delete this change log?</div>
              <div className="cdlg__body">
                <div className="cdlg__line">{fmtDateTime(confirmChg.changed_at)}</div>
                <span className="chg-field">{confirmChg.field_label}</span>
                <div className="cdlg__notes">
                  {confirmChg.old_value || "—"} → {confirmChg.new_value || "—"}
                </div>
              </div>
              <div className="cdlg__hint">This action cannot be undone.</div>
              <div className="cdlg__actions">
                <button
                  className="btn btn--ghost"
                  onClick={() => setConfirmChg(null)}
                  disabled={deleting}
                >
                  Cancel
                </button>
                <button
                  className="btn btn--danger"
                  onClick={confirmDeleteChange}
                  disabled={deleting}
                >
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

// ─── Reassign Needed view ──────────────────────────────────────────────────
// Patients booked to a doctor who is now unavailable (leave / break / day off /
// holiday) for that date+slot. Shows the previous doctor + reason and lets you
// reassign to a free doctor.
function ReassignNeededView({ date }) {
  const [conflicts, setConflicts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [picks, setPicks] = useState({}); // appointment_id → doctor_id
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setMsg("");
    api(`/api/appointments/conflicts?date=${date}`)
      .then((d) => setConflicts(safeArr(d?.conflicts)))
      .catch(() => setConflicts([]))
      .finally(() => setLoading(false));
  }, [date]);
  useEffect(() => {
    load();
  }, [load]);

  const reassign = async (c) => {
    const did = picks[c.appointment_id];
    const target = c.suggested_doctors?.find((x) => x.doctor_id === did);
    if (!target) return setMsg("Pick a doctor to reassign to.");
    setBusyId(c.appointment_id);
    setMsg("");
    try {
      const r = await api(`/api/appointments/${c.appointment_id}/reassign`, {
        method: "PUT",
        body: JSON.stringify({
          to_doctor_id: target.doctor_id,
          to_doctor_name: target.doctor_name,
          reason: `Reassigned from ${c.current_doctor} (${c.reason})`,
          trigger: "manual",
        }),
      });
      if (r?.error) setMsg(r.message || r.error || "Reassign failed");
      else {
        setMsg(`✓ ${c.patient_name} moved to ${target.doctor_name}`);
        load();
      }
    } catch {
      setMsg("Reassign failed.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <div className="qfilter">
        <span className="qfilter__hint">
          Patients whose assigned doctor is now unavailable (leave / break / day off) on{" "}
          {prettyDate(date)}. Change the day with the date selector at the top. Reassign each to a
          free doctor.
        </span>
      </div>

      {msg && (
        <div
          style={{
            margin: "8px 0",
            padding: "8px 12px",
            borderRadius: 7,
            fontSize: 13,
            background: msg.startsWith("✓") ? "#e7f2ec" : "#fdf3f2",
            border: `1px solid ${msg.startsWith("✓") ? "#bfe0cd" : "#f1c9c4"}`,
            color: msg.startsWith("✓") ? "#1d6f43" : "#b5392b",
          }}
        >
          {msg}
        </div>
      )}

      {loading ? (
        <div className="ghm__loading">
          <div className="spinner" />
          Loading…
        </div>
      ) : conflicts.length === 0 ? (
        <div className="ghm__empty">
          <div className="ghm__empty-icon">✅</div>
          <div className="ghm__empty-title">No reassignment needed for {prettyDate(date)}</div>
          <div className="ghm__empty-sub">Every booked patient's doctor is available.</div>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ minWidth: 160 }}>Patient</th>
                <th style={{ width: 110 }}>Date</th>
                <th style={{ width: 130 }}>Slot</th>
                <th style={{ width: 180 }}>Previous Doctor</th>
                <th style={{ width: 130 }}>Why unavailable</th>
                <th style={{ width: 200 }}>Reassign to</th>
                <th style={{ width: 110 }}></th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => (
                <tr key={c.appointment_id}>
                  <td>
                    {c.patient_name}
                    {c.file_no ? <small> ({c.file_no})</small> : null}
                  </td>
                  <td>{c.appointment_date?.slice(0, 10)}</td>
                  <td>{c.time_slot}</td>
                  <td>
                    <strong>{c.current_doctor}</strong>
                  </td>
                  <td>
                    <span
                      style={{
                        fontSize: 12,
                        background: "#fbeceb",
                        color: "#a05049",
                        borderRadius: 10,
                        padding: "2px 8px",
                      }}
                    >
                      {SLOT_REASON[c.reason] || c.reason}
                    </span>
                  </td>
                  <td>
                    {c.suggested_doctors?.length ? (
                      <select
                        className="doc-assign-sel"
                        value={picks[c.appointment_id] || ""}
                        onChange={(e) =>
                          setPicks((p) => ({
                            ...p,
                            [c.appointment_id]: Number(e.target.value) || "",
                          }))
                        }
                      >
                        <option value="">— choose —</option>
                        {c.suggested_doctors.map((d) => (
                          <option key={d.doctor_id} value={d.doctor_id}>
                            {d.doctor_name}
                            {d.same_specialty ? " ⭐" : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <em style={{ color: "#c0392b", fontSize: 12 }}>No doctor free this slot</em>
                    )}
                  </td>
                  <td>
                    <button
                      className="btn btn--primary"
                      disabled={busyId === c.appointment_id || !picks[c.appointment_id]}
                      onClick={() => reassign(c)}
                    >
                      {busyId === c.appointment_id ? "…" : "Reassign"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────
export default function GHMPage() {
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const loggedInName = currentDoctor?.short_name || currentDoctor?.name || "";
  const [view, setView] = useState("by_date"); // by_date | tomorrow | fu3
  const [date, setDate] = useState(todayStr());
  const [showNew, setShowNew] = useState(false);
  const [newPrefill, setNewPrefill] = useState(null);
  const [doctor, setDoctor] = useState("All");
  const [doctors, setDoctors] = useState([]);
  // Debounced copy of `search` — drives the date-independent Patient Lookup fetch
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [ccAgents, setCcAgents] = useState([]);
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

  // ── Switch the day-view tab (also sets the date) ─────────────────────────
  const switchView = (tab) => {
    setView(tab.id);
    setExpanded(null);
    if (tab.offset !== null) setDate(addDaysStr(tab.offset));
    else setDate(todayStr());
  };

  // Patient Lookup is search-driven and ignores the date; everywhere else the
  // search box just filters the already-loaded date list on the client.
  const lookupQ = view === "lookup" ? debouncedSearch.trim() : "";

  // ── Fetch ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    // Lookup tab: nothing to show until the user types a real query. Don't hit
    // the backend (and don't carry over rows from a previous tab).
    if (view === "lookup" && lookupQ.length < 2) {
      setRows([]);
      setBiomarkers({});
      setAttemptCounts({});
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const p = new URLSearchParams({ date, limit: 200 });
      if (doctor !== "All") p.set("doctor", doctor);
      // The Tomorrow and Follow-up tabs are follow-up calling lists: patients
      // whose follow-up is DUE on this date (matched on follow_up_date), not
      // appointments booked that day. Only "By Date" lists booked appointments.
      if (view === "tomorrow" || view === "fu3") p.set("mode", "followup");
      // Patient Lookup: a date-INDEPENDENT search by name / file no / phone. The
      // patient shows up with their current follow-up/booking status no matter
      // which date is selected — this is how someone who forgot to book a
      // follow-up is found (they're on no date's calling list).
      if (view === "lookup") {
        p.set("mode", "lookup");
        p.set("q", lookupQ);
      }
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
  }, [date, doctor, view, lookupQ]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounce the search box so the Patient Lookup fetch fires after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

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

  // ── When call status changes, auto-fill date + caller (logged-in user) ────
  const handleCallStatus = useCallback(
    (row, value) => {
      patch(row.id, "call_status", value);
      // any real call action auto-stamps date + who made the call (if empty)
      if (value && value !== "pending") {
        if (!row.call_date) patch(row.id, "call_date", todayStr());
        if (!row.call_made_by && loggedInName) patch(row.id, "call_made_by", loggedInName);
      }
    },
    [patch, loggedInName],
  );

  // ── Search ────────────────────────────────────────────────────────────────
  // On the Patient Lookup tab the backend already searched (across all dates),
  // so show its rows as-is. Other tabs filter the loaded date list client-side.
  const visible =
    view === "lookup"
      ? rows
      : rows.filter((r) => {
          if (!search) return true;
          const q = search.toLowerCase();
          return (
            r.patient_name?.toLowerCase().includes(q) ||
            r.file_no?.toLowerCase().includes(q) ||
            r.phone?.includes(q) ||
            r.condition?.toLowerCase().includes(q)
          );
        });

  const isToday = date === todayStr();
  // Per-tab column visibility
  // Time Slot only makes sense for booked appointments (By Date). On the
  // follow-up calling lists (Tomorrow, Follow-up) the matched row is a PAST
  // visit, so its time slot is stale — hide it.
  const showTime = view === "by_date";
  const showShowNoShow = false; // Show/No-Show column hidden on all tabs
  const showCallStatus = view !== "by_date"; // on Tomorrow & Follow-up tabs
  const showRecovery = false; // Recovery column hidden on all tabs
  const showCalledBy = view !== "by_date"; // hide Called By on By Date tab
  const showCallDate = view !== "by_date"; // on Tomorrow & Follow-up tabs
  // On the Tomorrow tab every row's follow-up is due tomorrow, so the Follow-up
  // Date column is redundant there — hide it.
  const showFollowUpDate = view !== "tomorrow";
  // total columns (for the expanded history row colSpan): 12 always-on + optionals
  const colSpan =
    12 +
    (showTime ? 1 : 0) +
    (showShowNoShow ? 1 : 0) +
    (showCallStatus ? 1 : 0) +
    (showRecovery ? 1 : 0) +
    (showCalledBy ? 1 : 0) +
    (showCallDate ? 1 : 0) +
    (showFollowUpDate ? 1 : 0);

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
          <span className="ghm__datelab">{isToday ? "Today" : prettyDate(date)}</span>
        </div>
        <div className="ghm__controls">
          {/* Patient Lookup ignores the date and the doctor filter — it searches
              every patient by name / file no / phone, so those controls are hidden. */}
          {view === "lookup" ? null : view === "tomorrow" ? (
            <span className="ctrl ctrl--readonly">{prettyDate(date)}</span>
          ) : (
            <input
              type="date"
              value={date}
              min={view === "fu3" ? todayStr() : undefined}
              onChange={(e) => setDate(e.target.value)}
              className="ctrl"
            />
          )}
          {view !== "lookup" && (
            <DocDropdown value={doctor} options={doctors} onChange={setDoctor} />
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={
              view === "lookup"
                ? "🔎 Search any patient — name, file no, phone (ignores date)"
                : "🔍 Search patient, file no…"
            }
            className="ctrl ctrl--search"
          />
          <button
            className="btn btn--primary"
            onClick={() => {
              setNewPrefill(null);
              setShowNew(true);
            }}
          >
            ➕ New Appointment
          </button>
        </div>
      </div>

      {/* ── View tabs ── */}
      <div className="ghm__tabs">
        {VIEW_TABS.map((t) => (
          <button
            key={t.id}
            className={`ghm__tab ${view === t.id ? "ghm__tab--active" : ""}`}
            onClick={() => switchView(t)}
          >
            {t.label}
            {t.offset !== null && (
              <span className="ghm__tab-date">
                {prettyDate(view === t.id ? date : addDaysStr(t.offset))}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── New Appointment modal ── */}
      {showNew && (
        <NewAppointmentModal
          doctors={doctors}
          defaultDate={date}
          prefill={newPrefill}
          onClose={() => {
            setShowNew(false);
            setNewPrefill(null);
          }}
          onCreated={(createdDate) => {
            setShowNew(false);
            setNewPrefill(null);
            if (createdDate === date) load();
            else setDate(createdDate);
          }}
        />
      )}

      {view === "reassign" ? (
        <ReassignNeededView date={date} />
      ) : (
        <>
          {/* ── Summary ── */}
          {!loading && rows.length > 0 && <Summary rows={rows} />}

          {/* ── Hint ── */}
          <div className="qfilter">
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
          {!loading && visible.length === 0 && view === "lookup" && (
            <div className="ghm__empty">
              <div className="ghm__empty-icon">🔎</div>
              <div className="ghm__empty-title">
                {lookupQ.length < 2 ? "Search a patient to begin" : "No patient found"}
              </div>
              <div className="ghm__empty-sub">
                {lookupQ.length < 2
                  ? "Type a name, file number, or phone. Results aren't filtered by date — any patient appears with their current follow-up/booking status."
                  : "No patient matches that name, file number, or phone."}
              </div>
            </div>
          )}
          {!loading && visible.length === 0 && view !== "lookup" && (
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
                    {showTime && <th style={{ width: 115 }}>Check-in</th>}
                    <th style={{ minWidth: 170 }}>Patient</th>
                    <th style={{ width: 155 }}>Biomarkers (auto)</th>
                    <th style={{ width: 100 }}>Visit Type</th>
                    <th style={{ width: 110 }}>Mode</th>
                    <th style={{ width: 220 }}>Doctor</th>
                    <th style={{ width: 150 }}>Assigned MO</th>
                    <th style={{ width: 160 }}>Prescription Explained By</th>
                    {showShowNoShow && <th style={{ width: 150 }}>Show / No Show</th>}
                    {showCallStatus && (
                      <th style={{ minWidth: 175, whiteSpace: "nowrap" }}>Call Status</th>
                    )}
                    {showRecovery && <th style={{ width: 150 }}>Recovery</th>}
                    {showCalledBy && (
                      <th style={{ minWidth: 120, whiteSpace: "nowrap" }}>Called By</th>
                    )}
                    {showCallDate && <th style={{ minWidth: 110 }}>Call Date</th>}
                    {showFollowUpDate && <th style={{ width: 130 }}>Follow-up Date</th>}
                    <th style={{ width: 180 }}>Preferred Doctor</th>
                    <th style={{ width: 150 }}>Preferred Date</th>
                    <th style={{ minWidth: 210 }}>Notes / Reason</th>
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
                          {showTime && (
                            <td>
                              <span className="fw7 fs12 nowrap">
                                {row.reporting_time_slot || row.time_slot || "—"}
                              </span>
                            </td>
                          )}

                          {/* Patient */}
                          <td>
                            <div className="pcell">
                              <span className="pcell__name">
                                {row.patient_name || "—"}
                                {row.via_preferred && (
                                  <span
                                    className="pref-tag"
                                    title={`Appears here because patient's preferred date is ${date}. Actual appointment: ${row.appointment_date}`}
                                  >
                                    ⭐ Preferred
                                  </span>
                                )}
                              </span>
                              {row.file_no && <span className="pcell__file">{row.file_no}</span>}
                              {(row.disp_sex || row.disp_age != null) && (
                                <span className="pcell__ageSex">
                                  {[
                                    row.disp_sex,
                                    row.disp_age != null ? `${row.disp_age} yrs` : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </span>
                              )}
                              {row.phone && <span className="pcell__ph">📞 {row.phone}</span>}
                              {row.address && <span className="pcell__addr">📍 {row.address}</span>}
                              {row.condition && (
                                <span className="pcell__cond">{row.condition}</span>
                              )}
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

                          {/* Mode of appointment — editable */}
                          <td>
                            <select
                              value={row.mode_of_appointment || ""}
                              onChange={(e) => patch(row.id, "appointment_type", e.target.value)}
                              className="doc-assign-sel"
                              style={{ minWidth: 100 }}
                            >
                              <option value="">—</option>
                              {["Physical", "Digital", "Online"].map((m) => (
                                <option key={m} value={m}>
                                  {m}
                                </option>
                              ))}
                            </select>
                          </td>

                          {/* Doctor — editable. Investigation/lab tests default to Hospital Admin. */}
                          <td>
                            {(() => {
                              const isInvestigation =
                                (row.visit_type || "").toLowerCase() === "investigation";
                              // build option list; ensure current value + Hospital Admin are present
                              const opts = [...doctors];
                              if (!opts.includes("Dr. Hospital Admin"))
                                opts.unshift("Dr. Hospital Admin");
                              if (row.doctor_name && !opts.includes(row.doctor_name))
                                opts.unshift(row.doctor_name);
                              // for investigation rows with no doctor set, show Hospital Admin as selected
                              const current =
                                row.doctor_name || (isInvestigation ? "Dr. Hospital Admin" : "");
                              return (
                                <select
                                  value={current}
                                  onChange={(e) => patch(row.id, "doctor_name", e.target.value)}
                                  className="doc-assign-sel"
                                >
                                  <option value="">— Assign Doctor</option>
                                  {opts.map((d) => (
                                    <option key={d} value={d}>
                                      {d}
                                    </option>
                                  ))}
                                </select>
                              );
                            })()}
                          </td>

                          {/* Assigned MO — editable */}
                          <td>
                            <InlineEdit
                              value={row.assigned_mo}
                              onChange={(v) => patch(row.id, "assigned_mo", v)}
                              placeholder="MO name…"
                            />
                          </td>

                          {/* Prescription explained by — editable */}
                          <td>
                            <InlineEdit
                              value={row.prescription_explained_by}
                              onChange={(v) => patch(row.id, "prescription_explained_by", v)}
                              placeholder="Explained by…"
                            />
                          </td>

                          {/* Came? */}
                          {showShowNoShow && (
                            <td>
                              <ColorSelect
                                value={row.show_no_show}
                                options={SHOW_STATUSES}
                                onChange={(v) => patch(row.id, "show_no_show", v)}
                              />
                            </td>
                          )}

                          {/* Call status */}
                          {showCallStatus && (
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
                          )}

                          {/* Recovery — is patient improving? */}
                          {showRecovery && (
                            <td>
                              <ColorSelect
                                value={row.pt_recovery}
                                options={RECOVERY_STATUSES}
                                onChange={(v) => patch(row.id, "pt_recovery", v)}
                              />
                            </td>
                          )}

                          {/* Called by — auto-fills logged-in user, editable, with dropdown */}
                          {showCalledBy && (
                            <td>
                              <input
                                list="cc-agents-list"
                                defaultValue={row.call_made_by || loggedInName || ""}
                                key={`cb-${row.id}-${row.call_made_by}`}
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  if (v !== (row.call_made_by || ""))
                                    patch(row.id, "call_made_by", v);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") e.target.blur();
                                }}
                                placeholder="CC name"
                                className="cc-input"
                              />
                            </td>
                          )}

                          {/* Call date */}
                          {showCallDate && (
                            <td>
                              <InlineEdit
                                value={row.call_date}
                                onChange={(v) => patch(row.id, "call_date", v)}
                                type="date"
                              />
                            </td>
                          )}

                          {/* Follow-up date — next booked appt, else prescription timing/notes.
                          Hidden on the Tomorrow tab (every row is due tomorrow). */}
                          {showFollowUpDate && (
                            <td>
                              {(() => {
                                // 1) Next booked appointment after this visit → most reliable date
                                if (row.follow_up_date) {
                                  return (
                                    <div className="fu-cell">
                                      <span className="fu-date">{row.follow_up_date}</span>
                                      {row.follow_up_time && (
                                        <span className="fu-time">{row.follow_up_time}</span>
                                      )}
                                    </div>
                                  );
                                }
                                // 2) Else the latest prescription's follow-up DATE or
                                //    timing only. The free-text notes (e.g. "FBG and PP
                                //    glucose charting") are clinical instructions, not a
                                //    date — never render them as the cell value; keep them
                                //    on hover so the info isn't lost.
                                const hr = row.healthray_follow_up || row.last_rx_follow_up || {};
                                const hrDate = hr.date || "";
                                const hrTiming = hr.timing || "";
                                const hrNotes = hr.notes || "";
                                if (hrDate || hrTiming) {
                                  return (
                                    <div className="fu-cell">
                                      {hrDate && <span className="fu-date">{hrDate}</span>}
                                      {hrTiming && <span className="fu-time">{hrTiming}</span>}
                                    </div>
                                  );
                                }
                                return (
                                  <span className="muted" title={hrNotes || undefined}>
                                    —
                                  </span>
                                );
                              })()}
                            </td>
                          )}

                          {/* Preferred doctor — doctor the patient prefers (editable) */}
                          <td>
                            <select
                              value={row.preferred_doctor || ""}
                              onChange={(e) => patch(row.id, "preferred_doctor", e.target.value)}
                              className="doc-assign-sel"
                            >
                              <option value="">— No preference</option>
                              {(row.preferred_doctor && !doctors.includes(row.preferred_doctor)
                                ? [row.preferred_doctor, ...doctors]
                                : doctors
                              ).map((d) => (
                                <option key={d} value={d}>
                                  {d}
                                </option>
                              ))}
                            </select>
                          </td>

                          {/* Preferred date — date the patient wants (editable) */}
                          <td>
                            <input
                              type="date"
                              min={todayStr()}
                              value={row.preferred_date || ""}
                              onChange={(e) => patch(row.id, "preferred_date", e.target.value)}
                              className="rsd-input"
                            />
                          </td>

                          {/* Notes / reason — last column (multiline) */}
                          <td>
                            <InlineEdit
                              value={row.call_notes}
                              onChange={(v) => patch(row.id, "call_notes", v)}
                              placeholder="Patient said… / reason…"
                              multiline
                            />
                          </td>
                        </tr>

                        {isOpen && (
                          <CallHistoryPanel
                            row={row}
                            ccAgents={ccAgents}
                            colSpan={colSpan}
                            onLogged={() => {
                              // refresh badge count + row summary after logging
                              setAttemptCounts((c) => ({ ...c, [row.id]: (c[row.id] || 0) + 1 }));
                              load();
                            }}
                            onDeleted={() => {
                              // refresh badge count + row summary after delete
                              setAttemptCounts((c) => ({
                                ...c,
                                [row.id]: Math.max(0, (c[row.id] || 0) - 1),
                              }));
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
        </>
      )}
    </div>
  );
}
