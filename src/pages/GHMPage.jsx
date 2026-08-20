import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ClipboardList,
  Download,
  FileText,
  FolderOpen,
  MapPin,
  MoveDown,
  MoveRight,
  MoveUp,
  Phone,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Star,
  Sunrise,
  Trash2,
  X,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import "./GHMPage.css";
import useAuthStore from "../stores/authStore";
import { SLOT_REASON, slotOptions, ARRIVAL_TIME_RANGES } from "../lib/slotAvailability.js";
import { exportWatiWorkbook } from "../lib/ghmWatiExport.js";
import { CAPABILITIES as CAP, hasAnyCapability } from "../../shared/permissions";
import PatientRecordModal from "../components/ghm/PatientRecordModal.jsx";
import Dropdown from "../components/ui/Dropdown.jsx";
import FilterPopover from "../components/ui/FilterPopover.jsx";
import SearchBox from "../components/ui/SearchBox.jsx";
import DatePicker from "../components/DatePicker.jsx";
import useBodyScrollLock from "../hooks/useBodyScrollLock.js";
import useViewportFill from "../hooks/useViewportFill.js";
import {
  PAGE_SIZE,
  useAppointmentChanges,
  useCallAttemptCounts,
  useCallAttempts,
  useCcAgents,
  useCreateAppointment,
  useDayAvailability,
  useDeleteAppointmentChange,
  useDeleteCallAttempt,
  useDoctorConflicts,
  useExportPages,
  useGhmBiomarkers,
  useGhmDoctors,
  useGhmLastMo,
  useGhmList,
  useLogCallAttempt,
  usePatchAppointment,
  useReassignAppointment,
} from "../queries/hooks/useGhm";
import { qk } from "../queries/keys";

const safeArr = (v) => (Array.isArray(v) ? v : []);

const STALE_MO_DAYS = 90;

const daysAgo = (d) => {
  if (!d) return null;
  const then = new Date(`${String(d).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(then.getTime())) return null;
  return Math.floor((Date.now() - then.getTime()) / 86400000);
};

const agoLabel = (days) => {
  if (days <= 0) return "today";
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months} mo ago` : `${(days / 365).toFixed(1)} yr ago`;
};

const fmtPhone = (v) => {
  const digits = String(v || "").replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : v;
};
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
// `cap` gates the tab per role (omitted = visible to anyone who can open /ghm).
// Reassigning appointments between doctors is scheduling-desk work, so it is
// RECEPTION_OPS — the OBT call team reaches /ghm via OBT_OPS and doesn't get it.
const VIEW_TABS = [
  { id: "by_date", label: "Today", Icon: CalendarDays, offset: null },
  { id: "tomorrow", label: "Tomorrow", Icon: Sunrise, offset: 1 },
  { id: "fu3", label: "Follow-up in 3 Days", Icon: Phone, offset: 3 },
  { id: "lookup", label: "Patient Lookup", Icon: Search, offset: null },
  {
    id: "reassign",
    label: "Reassign Needed",
    Icon: RefreshCw,
    offset: null,
    cap: CAP.RECEPTION_OPS,
  },
];

// ─── Call status options ───────────────────────────────────────────────────
const CALL_STATUSES = [
  { value: "pending", label: "Not Called Yet", color: "gray" },
  { value: "called", label: "Called / Spoke", color: "green" },
  { value: "not_picked", label: "Not Picked Up", color: "red" },
  { value: "rescheduled", label: "Rescheduled", color: "blue" },
  { value: "call_later", label: "Will Call Later", color: "amber" },
  { value: "no_call_needed", label: "No Call Needed", color: "gray" },
];

const SHOW_STATUSES = [
  { value: "", label: "— Not Marked", color: "gray" },
  { value: "Show", label: "Patient Came", color: "green" },
  { value: "No Show", label: "Did Not Come", color: "red" },
];

const HOME_COLLECTION_OPTIONS = [
  { value: "no", label: "No", color: "gray" },
  { value: "yes", label: "Yes — home collection", color: "purple" },
];

const RECOVERY_STATUSES = [
  { value: "", label: "—", color: "gray" },
  { value: "Yes", label: "Improving", color: "green" },
  { value: "No", label: "Not Improving", color: "red" },
];

// Outcomes for an individual call attempt (richer than the row summary)
const ATTEMPT_OUTCOMES = [
  { value: "called", label: "Called / Spoke", color: "green" },
  { value: "not_picked", label: "Not Picked Up", color: "red" },
  { value: "busy", label: "Busy", color: "amber" },
  { value: "switched_off", label: "Switched Off", color: "amber" },
  { value: "wrong_number", label: "Wrong Number", color: "red" },
  { value: "rescheduled", label: "Rescheduled", color: "blue" },
  { value: "call_later", label: "Will Call Later", color: "amber" },
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
const doctorOptions = (doctors) => [
  { value: "All", label: "All Doctors" },
  ...doctors.map((d) => ({ value: d, label: d })),
];

const CELL_DATE_STYLE = {
  padding: "5px 26px 5px 26px",
  fontSize: 12,
  borderRadius: 7,
};

const MODE_OPTIONS = [
  { value: "", label: "—" },
  ...["Physical", "Digital", "Online"].map((m) => ({ value: m, label: m })),
];

const COLLECTION_OPTIONS = [
  { value: "all", label: "All patients" },
  { value: "home", label: "Home collection only" },
];

// ─── Inline text/date cell that saves on blur / Enter ─────────────────────
function InlineEdit({ value, onChange, placeholder, multiline = false }) {
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

function ColorSelect({ value, options, onChange }) {
  return <Dropdown value={value || ""} options={options} onChange={onChange} variant="color" />;
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
      trend = { Icon: MoveDown, cls: "bio-down", label: "improving" }; // lower sugar = improving
    else if (lv > pv) trend = { Icon: MoveUp, cls: "bio-up", label: "worse" };
    else trend = { Icon: MoveRight, cls: "bio-flat", label: "unchanged" };
  }

  return (
    <div className="bio-row">
      <span className="bio-label">{label}</span>
      {prev && <span className="bio-prev">{fmtNum(prev.v)}</span>}
      {prev && (
        <span className="bio-sep">
          <ArrowRight size={11} aria-hidden="true" />
        </span>
      )}
      <span className="bio-latest">{fmtNum(latest.v)}</span>
      {trend && (
        <span className={`bio-arrow ${trend.cls}`} title={trend.label}>
          <trend.Icon size={13} aria-hidden="true" />
        </span>
      )}
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

const SUMMARY_BUCKET = {
  home_collection: (v) => (v ? "home_collection" : null),
  call_status: (v) =>
    ({ called: "called", not_picked: "not_picked", rescheduled: "rescheduled" })[v] ||
    (!v || v === "pending" ? "not_called" : null),
  show_no_show: (v) => (v === "Show" ? "came" : v === "No Show" ? "no_show" : "pending_show"),
};

function Summary({ summary }) {
  const total = summary.total || 0;
  const came = summary.came || 0;
  const noShow = summary.no_show || 0;
  const pendingShow = summary.pending_show || 0;
  const called = summary.called || 0;
  const notPicked = summary.not_picked || 0;
  const rescheduled = summary.rescheduled || 0;
  const notCalled = summary.not_called || 0;
  const fu = summary.follow_up || 0;

  return (
    <div className="summary">
      <div className="summary__group">
        <div className="summary__label">Appointments</div>
        <div className="summary__pills">
          <span className="spill">{total} Total</span>
          <span className="spill spill--gray">{pendingShow} Pending</span>
          <span className="spill spill--amber">{fu} Follow-up</span>
          <span className="spill spill--purple">
            {summary.home_collection || 0} Home Collection
          </span>
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

function GhmFilters({ view, date, doctor, doctors, collectionFilter, activeCount, onApply }) {
  const [draft, setDraft] = useState({ date, doctor, collectionFilter });

  useEffect(() => {
    setDraft({ date, doctor, collectionFilter });
  }, [date, doctor, collectionFilter]);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  // Lookup ignores the date entirely — it searches every patient on every date,
  // so offering one there only invited the question of what it filtered.
  const showDate = view !== "tomorrow" && view !== "lookup";
  const showDoctor = view !== "lookup";

  return (
    <FilterPopover
      activeCount={activeCount}
      onApply={() => onApply(draft)}
      onReset={() =>
        setDraft({ date: view === "lookup" ? "" : date, doctor: "All", collectionFilter: "all" })
      }
      hint={
        view === "lookup"
          ? "Patient Lookup searches every patient on every date, so it has no date filter — each row shows that patient's most recent appointment."
          : "Filters run on the server, so they cover the whole date — not just the rows already loaded."
      }
    >
      {showDate && (
        <div className="fpop__fld">
          <span>{view === "lookup" ? "Upcoming from (optional)" : "Date"}</span>
          <DatePicker
            value={draft.date}
            onChange={(v) => set("date", v)}
            minDate={view === "fu3" ? todayStr() : undefined}
            placeholder={view === "lookup" ? "Today" : "Select date"}
            clearable={view === "lookup"}
          />
        </div>
      )}
      {view === "tomorrow" && (
        <div className="fpop__fld">
          <span>Date</span>
          <span className="ctrl ctrl--readonly">{prettyDate(date)}</span>
        </div>
      )}

      {showDoctor && (
        <div className="fpop__fld">
          <span>Doctor</span>
          <Dropdown
            value={draft.doctor}
            options={doctorOptions(doctors)}
            onChange={(v) => set("doctor", v)}
            ariaLabel="Doctor"
          />
        </div>
      )}

      <div className="fpop__fld">
        <span>Home collection</span>
        <Dropdown
          value={draft.collectionFilter}
          options={COLLECTION_OPTIONS}
          onChange={(v) => set("collectionFilter", v)}
          ariaLabel="Home collection"
        />
      </div>
    </FilterPopover>
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
    home_collection: false,
  });
  const [err, setErr] = useState("");

  useBodyScrollLock();

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const { data: availData } = useDayAvailability(form.doctor_name, form.appointment_date);
  const availSlots = availData ?? null;

  const createMutation = useCreateAppointment();
  const saving = createMutation.isPending;

  useEffect(() => {
    if (!availSlots) return;
    setForm((f) => {
      const sel = availSlots.find((x) => x.slot_label === f.time_slot);
      return sel && !sel.available ? { ...f, time_slot: "" } : f;
    });
  }, [availSlots]);

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

    setErr("");
    try {
      await createMutation.mutateAsync(form);
      onCreated(form.appointment_date);
    } catch (e) {
      setErr(e?.response?.data?.error || "Could not save. Please try again.");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__hdr">
          <span className="modal__title">
            <Plus size={16} aria-hidden="true" />
            {isPrefilled ? `Book Next Appointment — ${prefill.patient_name}` : "New Appointment"}
          </span>
          <button className="modal__x" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="modal__body">
          {err && <div className="modal__err">{err}</div>}
          {isPrefilled && (
            <div className="modal__prefill-note">
              <Check size={14} aria-hidden="true" />
              Patient details auto-filled. Just pick the date, slot &amp; doctor.
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
            <label className="fld fld--check fld--wide">
              <input
                type="checkbox"
                checked={form.home_collection}
                onChange={(e) => set("home_collection", e.target.checked)}
              />
              <span>Needs home sample collection</span>
            </label>
          </div>

          <p className="modal__hint">
            <Smartphone size={13} aria-hidden="true" /> WhatsApp message &amp; reporting time are
            generated automatically after booking.
            <br />
            <Plus size={13} aria-hidden="true" /> If File No is blank, a new patient record is
            created automatically with a new File No.
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
function CallHistoryPanel({ row, ccAgents, colSpan }) {
  const [outcome, setOutcome] = useState("not_picked");
  const [calledBy, setCalledBy] = useState("");
  const [notes, setNotes] = useState("");
  const [reschedule, setReschedule] = useState("");
  const [confirmDel, setConfirmDel] = useState(null); // attempt object pending delete
  const [confirmChg, setConfirmChg] = useState(null); // change object pending delete

  useBodyScrollLock(!!confirmDel || !!confirmChg);

  const attemptsQuery = useCallAttempts(row.id);
  const changesQuery = useAppointmentChanges(row.id);
  const history = attemptsQuery.isPending ? null : attemptsQuery.data || [];
  const changes = changesQuery.data || [];

  const logMutation = useLogCallAttempt();
  const deleteAttempt = useDeleteCallAttempt();
  const deleteChange = useDeleteAppointmentChange();
  const saving = logMutation.isPending;
  const deleting = deleteAttempt.isPending || deleteChange.isPending;

  const logAttempt = async () => {
    if (!outcome) return;
    try {
      await logMutation.mutateAsync({
        appointment_id: row.id,
        outcome,
        called_by: calledBy.trim() || null,
        notes: notes.trim() || null,
        reschedule_date: outcome === "rescheduled" ? reschedule || null : null,
      });
      setNotes("");
      setReschedule("");
    } catch {}
  };

  const confirmDelete = async () => {
    if (!confirmDel) return;
    try {
      await deleteAttempt.mutateAsync(confirmDel.id);
    } finally {
      setConfirmDel(null);
    }
  };

  const confirmDeleteChange = async () => {
    if (!confirmChg) return;
    try {
      await deleteChange.mutateAsync(confirmChg.id);
    } finally {
      setConfirmChg(null);
    }
  };

  return (
    <tr className="hist-row">
      <td colSpan={colSpan} className="hist-cell">
        <div className="hist-wrap">
          <div className="hist-title">
            <Phone size={14} aria-hidden="true" />
            Call History — {row.patient_name}
          </div>

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
                  {h.reschedule_date && (
                    <span className="hist-resch">
                      <ArrowRight size={12} aria-hidden="true" />
                      {h.reschedule_date}
                    </span>
                  )}
                  {h.notes && <span className="hist-notes">“{h.notes}”</span>}
                  <button
                    className="hist-del"
                    title="Delete this call log"
                    aria-label="Delete this call log"
                    onClick={() => setConfirmDel(h)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {changes.length > 0 && (
            <div className="chg-section">
              <div className="chg-title">
                <FileText size={13} aria-hidden="true" />
                Change History (Doctor / Preferred Date / Called By)
              </div>
              <div className="hist-list">
                {changes.map((c) => (
                  <div key={c.id} className="hist-item">
                    <span className="hist-when">{fmtDateTime(c.changed_at)}</span>
                    <span className="chg-field">{c.field_label}</span>
                    <span className="chg-old">{c.old_value || "—"}</span>
                    <span className="chg-arrow">
                      <ArrowRight size={12} aria-hidden="true" />
                    </span>
                    <span className="chg-new">{c.new_value || "—"}</span>
                    <button
                      className="hist-del"
                      title="Delete this change log"
                      aria-label="Delete this change log"
                      onClick={() => setConfirmChg(c)}
                    >
                      <X size={13} aria-hidden="true" />
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
              <div className="cdlg__icon">
                <Trash2 size={22} aria-hidden="true" />
              </div>
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
              <div className="cdlg__icon">
                <Trash2 size={22} aria-hidden="true" />
              </div>
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
  const [picks, setPicks] = useState({}); // appointment_id → doctor_id
  const [busyId, setBusyId] = useState(null);
  const [msg, setMsg] = useState(null);

  const conflictsQuery = useDoctorConflicts(date);
  const conflicts = conflictsQuery.data || [];
  const loading = conflictsQuery.isPending;

  const reassignMutation = useReassignAppointment();

  const reassign = async (c) => {
    const did = picks[c.appointment_id];
    const target = c.suggested_doctors?.find((x) => x.doctor_id === did);
    if (!target) return setMsg({ ok: false, text: "Pick a doctor to reassign to." });
    setBusyId(c.appointment_id);
    setMsg(null);
    try {
      await reassignMutation.mutateAsync({
        appointmentId: c.appointment_id,
        body: {
          to_doctor_id: target.doctor_id,
          to_doctor_name: target.doctor_name,
          reason: `Reassigned from ${c.current_doctor} (${c.reason})`,
          trigger: "manual",
        },
      });
      setMsg({ ok: true, text: `${c.patient_name} moved to ${target.doctor_name}` });
    } catch (e) {
      const body = e?.response?.data;
      setMsg({ ok: false, text: body?.message || body?.error || "Reassign failed." });
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
        <div className={`reassign-msg reassign-msg--${msg.ok ? "ok" : "err"}`}>
          {msg.ok ? (
            <CheckCircle2 size={14} aria-hidden="true" />
          ) : (
            <X size={14} aria-hidden="true" />
          )}
          {msg.text}
        </div>
      )}

      {loading ? (
        <div className="ghm__loading">
          <div className="spinner" />
          Loading…
        </div>
      ) : conflicts.length === 0 ? (
        <div className="ghm__empty">
          <div className="ghm__empty-icon">
            <CheckCircle2 size={34} aria-hidden="true" />
          </div>
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
                      <Dropdown
                        value={picks[c.appointment_id] || ""}
                        options={[
                          { value: "", label: "— choose —" },
                          ...c.suggested_doctors.map((d) => ({
                            value: d.doctor_id,
                            label: `${d.doctor_name}${d.same_specialty ? " (same specialty)" : ""}`,
                          })),
                        ]}
                        onChange={(v) =>
                          setPicks((p) => ({ ...p, [c.appointment_id]: Number(v) || "" }))
                        }
                        variant="cell"
                        ariaLabel="Reassign to doctor"
                      />
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
  const visibleTabs = VIEW_TABS.filter(
    (t) => !t.cap || hasAnyCapability(currentDoctor?.role, t.cap),
  );
  const canReassign = visibleTabs.some((t) => t.id === "reassign");
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VIEW_TABS.find((t) => t.id === searchParams.get("tab")) || VIEW_TABS[0];
  const [view, setView] = useState(initialTab.id); // by_date | tomorrow | fu3
  const [date, setDate] = useState(
    initialTab.offset !== null ? addDaysStr(initialTab.offset) : todayStr(),
  );
  const [showNew, setShowNew] = useState(false);
  const [newPrefill, setNewPrefill] = useState(null);
  const [doctor, setDoctor] = useState("All");
  const [collectionFilter, setCollectionFilter] = useState("all");
  // Debounced copy of `search` — drives the date-independent Patient Lookup fetch
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [search, setSearch] = useState("");
  const [recordFor, setRecordFor] = useState(null);
  const [expanded, setExpanded] = useState(null); // appointment_id of open history row
  const EXPORT_PAGE_SIZE = 100;

  const doctors = useGhmDoctors().data || [];
  const ccAgents = useCcAgents().data || [];

  // ── Switch the day-view tab (also sets the date) ─────────────────────────
  const switchView = (tab) => {
    setView(tab.id);
    setExpanded(null);
    if (tab.offset !== null) setDate(addDaysStr(tab.offset));
    else setDate(todayStr());
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", tab.id);
        return next;
      },
      { replace: true },
    );
  };

  const searchQ = debouncedSearch.trim();
  const lookupQ = view === "lookup" ? searchQ : "";

  const buildQuery = useCallback(
    (pageNum, limit) => {
      const p = new URLSearchParams({ limit, page: pageNum });
      // Lookup is date-independent: it has no date filter, and the backend falls
      // back to today for the "upcoming booking" cutoff.
      if (view !== "lookup") p.set("date", date);
      if (doctor !== "All") p.set("doctor", doctor);
      if (collectionFilter === "home") p.set("home_collection", "1");
      // The Tomorrow and Follow-up tabs are follow-up calling lists: patients
      // whose follow-up is DUE on this date (matched on follow_up_date), not
      // appointments booked that day. Only "By Date" lists booked appointments.
      if (view === "tomorrow" || view === "fu3") p.set("mode", "followup");
      if (view === "lookup") {
        p.set("mode", "lookup");
        p.set("q", lookupQ);
      } else if (searchQ) {
        p.set("q", searchQ);
      }
      return p;
    },
    [date, doctor, collectionFilter, view, lookupQ, searchQ],
  );

  const listEnabled = view !== "lookup" || lookupQ.length > 0;
  const listKey = qk.ghm.list(buildQuery(1, PAGE_SIZE).toString());
  const listQuery = useGhmList({
    buildQuery,
    enabled: listEnabled,
    keepPrevious: view !== "lookup",
  });

  const pages = listEnabled ? listQuery.data?.pages || [] : [];
  const rows = useMemo(() => pages.flatMap((pg) => safeArr(pg?.data)), [pages]);
  const summary = pages[0]?.summary || {};
  const total = pages[0]?.total || 0;
  const loading = listEnabled && listQuery.isPending;
  const loadingMore = listQuery.isFetchingNextPage;
  const loadMore = () => listQuery.fetchNextPage();

  const patientIds = useMemo(() => rows.map((r) => r.patient_id).filter(Boolean), [rows]);
  const appointmentIds = useMemo(() => rows.map((r) => r.id).filter(Boolean), [rows]);
  const biomarkerQuery = useGhmBiomarkers(patientIds);
  const lastMoQuery = useGhmLastMo(patientIds);
  const attemptQuery = useCallAttemptCounts(appointmentIds);
  const biomarkers = biomarkerQuery.data || {};
  const lastMo = lastMoQuery.data || {};
  const attemptCounts = attemptQuery.data || {};
  // Any request still in flight while rows are already on screen — a refetch on
  // focus, a stale-time refresh or the per-page batches catching up. The rows
  // shown are the previous answer until it lands, so the header says so.
  const refreshing =
    !listQuery.isPending &&
    (listQuery.isFetching ||
      biomarkerQuery.isFetching ||
      lastMoQuery.isFetching ||
      attemptQuery.isFetching);

  const exportMutation = useExportPages(buildQuery, EXPORT_PAGE_SIZE);
  const exporting = exportMutation.isPending;

  const exportWati = useCallback(async () => {
    const all = await exportMutation.mutateAsync();
    if (!all.length) {
      window.alert("No patients to export for this date.");
      return;
    }
    const counts = await exportWatiWorkbook(all, date);
    if (!counts.fresh && !counts.followUp)
      window.alert("No patients with a phone number to export.");
  }, [exportMutation, date]);

  // Debounce the search box so the Patient Lookup fetch fires after typing stops.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const patchMutation = usePatchAppointment(listKey, (old, id, field, value) => {
    if (!old?.pages) return old;
    const before = old.pages.flatMap((pg) => safeArr(pg?.data)).find((r) => r.id === id);
    const bucket = SUMMARY_BUCKET[field];
    const from = before && bucket ? bucket(before[field]) : null;
    const to = bucket ? bucket(value) : null;
    const moved = from !== to;
    return {
      ...old,
      pages: old.pages.map((pg) => ({
        ...pg,
        data: safeArr(pg?.data).map((r) => (r.id === id ? { ...r, [field]: value } : r)),
        summary: moved
          ? {
              ...pg.summary,
              ...(from ? { [from]: Math.max(0, (pg.summary?.[from] || 0) - 1) } : null),
              ...(to ? { [to]: (pg.summary?.[to] || 0) + 1 } : null),
            }
          : pg.summary,
      })),
    };
  });

  const patch = useCallback(
    (id, field, value) => patchMutation.mutate({ id, field, value }),
    [patchMutation],
  );

  const saving = useMemo(() => {
    const v = patchMutation.variables;
    return patchMutation.isPending && v ? { [v.id]: true } : {};
  }, [patchMutation.isPending, patchMutation.variables]);

  // ── When call status changes, auto-fill date + caller (logged-in user) ────
  const handleCallStatus = useCallback(
    (row, value) => {
      patch(row.id, "call_status", value);
      // call_date is the day the call was actually made, so the status is tied
      // to that day and no other: a patient rung on the 20th for a visit on the
      // 21st counts as called on the 20th, and the 21st reads "not called"
      // again. Overwritten, not filled-in-if-empty — a date left by an earlier
      // day's call would otherwise file today's call under that older day.
      if (value && value !== "pending") {
        const today = todayStr();
        if (row.call_date !== today) patch(row.id, "call_date", today);
        if (loggedInName && row.call_made_by !== loggedInName)
          patch(row.id, "call_made_by", loggedInName);
      }
    },
    [patch, loggedInName],
  );

  const isToday = date === todayStr();
  // A By Date view of a future date is a calling list too — those patients still
  // have to be rung to confirm — so it gets the call columns. On today or a past
  // date the calling is done or moot, and they would only add noise.
  const callingDay = view !== "by_date" || date > todayStr();
  // Per-tab column visibility
  const showShowNoShow = false; // Show/No-Show column hidden on all tabs
  const showCallStatus = callingDay;
  const showRecovery = false; // Recovery column hidden on all tabs
  const showCalledBy = callingDay;
  const showCallDate = callingDay;
  // On the Tomorrow tab every row's follow-up is due tomorrow, so the Follow-up
  // Date column is redundant there — hide it.
  const showFollowUpDate = view !== "tomorrow";
  // Lookup spans every date, so each row needs to say which visit it is showing.
  // The other tabs are pinned to one date and would just repeat it 50 times.
  const showApptDate = view === "lookup";
  const colSpan =
    15 +
    (showApptDate ? 1 : 0) +
    (showShowNoShow ? 1 : 0) +
    (showCallStatus ? 1 : 0) +
    (showRecovery ? 1 : 0) +
    (showCalledBy ? 1 : 0) +
    (showCallDate ? 1 : 0) +
    (showFollowUpDate ? 1 : 0);

  const activeFilters = (doctor !== "All" ? 1 : 0) + (collectionFilter !== "all" ? 1 : 0);

  const typing = view === "lookup" && search.trim() !== debouncedSearch.trim();
  const searching = view === "lookup" && (typing || (listEnabled && loading));
  const busy = ((loading && rows.length > 0) || refreshing) && !searching;
  const coldLoading = (loading && rows.length === 0) || searching;
  const showRows = rows.length > 0 && !searching;

  const canFit = view !== "reassign" && showRows;
  const { ref: pageRef, height: pageHeight, fitted } = useViewportFill(canFit);

  return (
    <div
      className={`ghm ${fitted ? "ghm--fit" : ""}`}
      ref={pageRef}
      style={fitted ? { height: pageHeight } : undefined}
    >
      {/* CC agents datalist — used by all "Called By" inputs */}
      <datalist id="cc-agents-list">
        {ccAgents.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <div className="ghm__top">
        {/* ── Header ── */}
        <div className="ghm__hdr">
          <div className="ghm__title">
            <h1>Daily Patient Sheet</h1>
            <span className="ghm__datelab">{isToday ? "Today" : prettyDate(date)}</span>
            {showRows && (
              <span className="ghm__count">
                {rows.length} of {total}
                {searchQ ? " matching" : ""}
              </span>
            )}
            {busy && (
              <span className="ghm__busy">
                <span className="ghm__busy-dot" aria-hidden="true" />
                {searchQ || typing ? "Searching…" : "Updating…"}
              </span>
            )}
          </div>
          <div className="ghm__controls">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder={
                view === "lookup"
                  ? "Search any patient — name, file no, phone"
                  : "Search this date — name, file no, phone, condition"
              }
            />
            <GhmFilters
              view={view}
              date={date}
              doctor={doctor}
              doctors={doctors}
              collectionFilter={collectionFilter}
              activeCount={activeFilters}
              onApply={(next) => {
                setDate(next.date || todayStr());
                setDoctor(next.doctor);
                setCollectionFilter(next.collectionFilter);
              }}
            />
            {view === "fu3" && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={exportWati}
                disabled={exporting}
              >
                <Download size={14} aria-hidden="true" />
                {exporting ? "Exporting…" : "Export Excel"}
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setNewPrefill(null);
                setShowNew(true);
              }}
            >
              <Plus size={15} aria-hidden="true" />
              New Appointment
            </button>
          </div>
        </div>

        {/* ── View tabs ── */}
        <div className="ghm__tabs">
          {visibleTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`ghm__tab ${view === t.id ? "ghm__tab--active" : ""}`}
              onClick={() => switchView(t)}
            >
              <t.Icon size={14} aria-hidden="true" />
              {t.label}
              {t.offset !== null && (
                <span className="ghm__tab-date">
                  {prettyDate(view === t.id ? date : addDaysStr(t.offset))}
                </span>
              )}
            </button>
          ))}
        </div>
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
            if (createdDate !== date) setDate(createdDate);
          }}
        />
      )}

      {recordFor && (
        <PatientRecordModal
          patientId={recordFor.id}
          patientName={recordFor.name}
          onClose={() => setRecordFor(null)}
        />
      )}

      {/* canReassign re-checks the capability here, not just on the tab: hiding a
          tab is presentation, and the body must not render if the view is ever
          reached another way (deep link, persisted view state). */}
      {view === "reassign" && canReassign ? (
        <ReassignNeededView date={date} />
      ) : (
        <>
          {/* ── Summary ── */}
          {showRows && <Summary summary={summary} />}

          {/* ── Loading ── */}
          {coldLoading && (
            <div className="ghm__loading">
              <div className="spinner" />
              {searching ? "Searching…" : "Loading…"}
            </div>
          )}

          {/* ── Empty ── */}
          {!coldLoading && !loading && rows.length === 0 && view === "lookup" && (
            <div className="ghm__empty">
              <div className="ghm__empty-icon">
                <Search size={34} aria-hidden="true" />
              </div>
              <div className="ghm__empty-title">
                {lookupQ ? "No patient found" : "Search a patient to begin"}
              </div>
              <div className="ghm__empty-sub">
                {lookupQ
                  ? "No patient matches that name, file number, or phone. Clearing the filters may widen the search."
                  : "Type a name, file number, or phone. Every patient is searched, whatever date is selected — the date only sets the point the Follow-up column counts forward from."}
              </div>
            </div>
          )}
          {!coldLoading && !loading && rows.length === 0 && view !== "lookup" && (
            <div className="ghm__empty">
              <div className="ghm__empty-icon">
                {searchQ ? (
                  <Search size={34} aria-hidden="true" />
                ) : (
                  <ClipboardList size={34} aria-hidden="true" />
                )}
              </div>
              <div className="ghm__empty-title">
                {searchQ
                  ? `No patient matches “${searchQ}” on ${prettyDate(date)}`
                  : `No appointments found for ${date}`}
              </div>
              <div className="ghm__empty-sub">
                {searchQ
                  ? "The search covers this whole date, not just the rows loaded. Try Patient Lookup to search every date."
                  : "Select a different date or check if appointments have been booked."}
              </div>
            </div>
          )}

          {/* ── Table ── */}
          {showRows && (
            <div className={`tbl-wrap ${busy ? "tbl-wrap--busy" : ""}`}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 30 }}></th>
                    <th style={{ width: 36 }}>#</th>
                    {showApptDate && <th style={{ width: 120 }}>Appointment</th>}
                    <th style={{ minWidth: 170 }}>Patient</th>
                    <th style={{ width: 155 }}>Biomarkers (auto)</th>
                    <th style={{ width: 100 }}>Visit Type</th>
                    <th style={{ width: 110 }}>Mode</th>
                    <th style={{ width: 220 }}>Doctor</th>
                    <th style={{ width: 150 }}>Assigned MO</th>
                    <th style={{ width: 140 }}>Last MO Seen</th>
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
                    <th style={{ width: 150 }}>Preferred Time</th>
                    <th style={{ width: 130 }}>Home Collection</th>
                    <th style={{ minWidth: 210 }}>Notes / Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, i) => {
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
                          {showApptDate && (
                            <td>
                              {row.appointment_date ? (
                                <div className="fu-cell">
                                  <span className="fu-date">
                                    {prettyDate(row.appointment_date)}
                                  </span>
                                  {/* {row.time_slot && (
                                    <span className="fu-time">{row.time_slot}</span>
                                  )} */}
                                </div>
                              ) : (
                                <span className="muted">—</span>
                              )}
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
                                    <Star size={11} aria-hidden="true" />
                                    Preferred
                                  </span>
                                )}
                              </span>
                              {row.phone ? (
                                <a
                                  className="pcell__ph"
                                  href={`tel:${String(row.phone).replace(/\D/g, "")}`}
                                  title="Call this patient"
                                >
                                  <Phone size={12} aria-hidden="true" />
                                  {fmtPhone(row.phone)}
                                </a>
                              ) : (
                                <span className="pcell__ph pcell__ph--none">
                                  <Phone size={12} aria-hidden="true" />
                                  No phone number
                                </span>
                              )}
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
                              {row.address && (
                                <span className="pcell__addr">
                                  <MapPin size={11} aria-hidden="true" />
                                  {row.address}
                                </span>
                              )}
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
                                <Plus size={12} aria-hidden="true" />
                                Book next
                              </button>
                              {row.patient_id && (
                                <button
                                  className="records-btn"
                                  title="View all documents, prescriptions, labs and past visits"
                                  onClick={() =>
                                    setRecordFor({
                                      id: row.patient_id,
                                      name: row.patient_name,
                                    })
                                  }
                                >
                                  <FolderOpen size={12} aria-hidden="true" />
                                  All records
                                </button>
                              )}
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
                            <Dropdown
                              value={row.mode_of_appointment || ""}
                              options={MODE_OPTIONS}
                              onChange={(v) => patch(row.id, "appointment_type", v)}
                              variant="cell"
                              ariaLabel="Mode of appointment"
                            />
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
                                <Dropdown
                                  value={current}
                                  options={[
                                    { value: "", label: "— Assign Doctor" },
                                    ...opts.map((d) => ({ value: d, label: d })),
                                  ]}
                                  onChange={(v) => patch(row.id, "doctor_name", v)}
                                  variant="cell"
                                  ariaLabel="Doctor"
                                />
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

                          <td>
                            {(() => {
                              const lm = lastMo[row.patient_id];
                              if (!lm?.name)
                                return <span className="muted">No MO or doctor recorded</span>;
                              const age = daysAgo(lm.date);
                              const stale = age != null && age > STALE_MO_DAYS;
                              const isDoctor = lm.kind === "doctor";
                              return (
                                <div className="lastmo-cell">
                                  <span className="lastmo-name">
                                    {lm.name}
                                    {isDoctor && (
                                      <span
                                        className="lastmo-tag"
                                        title="No MO recorded — showing the doctor seen on the last visit."
                                      >
                                        Doctor
                                      </span>
                                    )}
                                  </span>
                                  {lm.date && (
                                    <span
                                      className={`lastmo-date ${stale ? "lastmo-date--stale" : ""}`}
                                      title={
                                        stale
                                          ? `This is the last visit that named ${isDoctor ? "a doctor" : "an MO"} — more recent visits recorded none.`
                                          : undefined
                                      }
                                    >
                                      {prettyDate(lm.date)}
                                      {age != null && ` · ${agoLabel(age)}`}
                                    </span>
                                  )}
                                </div>
                              );
                            })()}
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
                                    <Phone size={11} aria-hidden="true" />×{attempts}
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
                              <DatePicker
                                value={row.call_date || ""}
                                onChange={(v) => patch(row.id, "call_date", v)}
                                placeholder="—"
                                style={CELL_DATE_STYLE}
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
                            <Dropdown
                              value={row.preferred_doctor || ""}
                              options={[
                                { value: "", label: "— No preference" },
                                ...(row.preferred_doctor && !doctors.includes(row.preferred_doctor)
                                  ? [row.preferred_doctor, ...doctors]
                                  : doctors
                                ).map((d) => ({ value: d, label: d })),
                              ]}
                              onChange={(v) => patch(row.id, "preferred_doctor", v)}
                              variant="cell"
                              ariaLabel="Preferred doctor"
                            />
                          </td>

                          {/* Preferred date — date the patient wants (editable) */}
                          <td>
                            <DatePicker
                              value={row.preferred_date || ""}
                              onChange={(v) => patch(row.id, "preferred_date", v)}
                              minDate={todayStr()}
                              placeholder="—"
                              style={CELL_DATE_STYLE}
                            />
                          </td>

                          <td>
                            <Dropdown
                              value={row.preferred_time_slot || ""}
                              options={[
                                { value: "", label: "— No time given" },
                                ...(row.preferred_time_slot &&
                                !ARRIVAL_TIME_RANGES.includes(row.preferred_time_slot)
                                  ? [row.preferred_time_slot, ...ARRIVAL_TIME_RANGES]
                                  : ARRIVAL_TIME_RANGES
                                ).map((t) => ({ value: t, label: t })),
                              ]}
                              onChange={(v) => patch(row.id, "preferred_time_slot", v)}
                              variant="cell"
                              ariaLabel="Preferred time"
                            />
                          </td>

                          <td>
                            <ColorSelect
                              value={row.home_collection ? "yes" : "no"}
                              options={HOME_COLLECTION_OPTIONS}
                              onChange={(v) => patch(row.id, "home_collection", v === "yes")}
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
                          <CallHistoryPanel row={row} ccAgents={ccAgents} colSpan={colSpan} />
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── Load more (pagination) ── */}
          {showRows && (
            <div className="ghm__load-more">
              {listQuery.hasNextPage ? (
                <button
                  type="button"
                  className="ghm__load-more-btn"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : `Load More (${rows.length} of ${total})`}
                </button>
              ) : (
                rows.length > PAGE_SIZE && (
                  <div className="ghm__load-more-end">— Showing all {total} —</div>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
