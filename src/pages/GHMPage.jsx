import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import {
  ArrowRight,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Download,
  FileText,
  FolderOpen,
  MapPin,
  MoveDown,
  MoveRight,
  MoveUp,
  Phone,
  PhoneCall,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Star,
  Sunrise,
  Trash2,
  X,
  RotateCcw,
} from "lucide-react";
import { useSearchParams } from "react-router-dom";
import "./GHMPage.css";
import useAuthStore from "../stores/authStore";
import { SLOT_REASON, slotOptions, ARRIVAL_TIME_RANGES } from "../lib/slotAvailability.js";
import { exportWatiWorkbook } from "../lib/ghmWatiExport.js";
import { CAPABILITIES as CAP, hasAnyCapability } from "../../shared/permissions";
import { PATIENT_CATEGORIES } from "../../shared/patientCategories.js";
import {
  ATTEMPT_OUTCOMES,
  CALL_STATUSES,
  UNREACHABLE_STATUSES,
  callColor,
  callLabel,
} from "../../shared/callStatuses.js";
import { slotStartHour } from "../../shared/slotHour.js";
import { followUpTiming } from "../lib/followUp.js";
import PatientRecordModal from "../components/ghm/PatientRecordModal.jsx";
import Dropdown from "../components/ui/Dropdown.jsx";
import FilterPopover from "../components/ui/FilterPopover.jsx";
import SearchBox from "../components/ui/SearchBox.jsx";
import DatePicker from "../components/DatePicker.jsx";
import useBodyScrollLock from "../hooks/useBodyScrollLock.js";
import useViewportFill from "../hooks/useViewportFill.js";
import {
  PAGE_SIZE,
  useActiveCalls,
  useAppointmentChanges,
  useCallAttemptCounts,
  useCategoryCounts,
  useCallAttempts,
  useCallClaim,
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
  useGhmSlotCounts,
  useGhmList,
  useLogCallAttempt,
  usePatchAppointment,
  usePatientByFileNo,
  usePatientByPhone,
  useReassignAppointment,
} from "../queries/hooks/useGhm";
import { qk } from "../queries/keys";
import { visitStatus } from "../lib/visitStatus.js";

const safeArr = (v) => (Array.isArray(v) ? v : []);

const STALE_MO_DAYS = 90;

// How loaded an arrival window already is on a row's date: booked appointments
// in that hour plus the patients whose preferred time is that window. Shown as
// a badge so a narrow cell truncates the time text, never the number.
const slotCountDate = (row) =>
  String(row?.preferred_date || row?.appointment_date || "").slice(0, 10) || null;

const slotBooked = (slot, counts, row) => {
  const hour = slotStartHour(slot);
  if (hour === null) return 0;
  return counts?.[slotCountDate(row)]?.[hour] || 0;
};

// Colour of the load badge. A clinic hour runs comfortably up to about a dozen
// patients; past that the window is crowded and past twenty it is effectively
// full, so the badge warns before the slot is promised.
const SLOT_BUSY = 12;
const SLOT_FULL = 20;

const slotTone = (n) => (n >= SLOT_FULL ? "high" : n >= SLOT_BUSY ? "mid" : "low");

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
const EXPORT_LABELS = {
  by_date: "ghm-by-date",
  tomorrow: "ghm-tomorrow",
  fu3: "wati-appt-confirmation",
  lookup: "ghm-patient-lookup",
};

const VIEW_TABS = [
  { id: "by_date", label: "Today", Icon: CalendarDays, offset: 0 },
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

const APPOINTMENT_MODES = ["Physical", "Online"];

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
  ...APPOINTMENT_MODES.map((m) => ({ value: m, label: m })),
];

// A cell whose stored value is no longer offered (a retired mode, a doctor who
// left) still has to show it — a dropdown that renders blank reads as "not set"
// and the next edit would wipe the real value.
const withCurrent = (options, value) =>
  !value || options.some((o) => o.value === value)
    ? options
    : [...options, { value, label: `${value} (retired)` }];

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
    (UNREACHABLE_STATUSES.includes(v) ? "unreachable" : null) ||
    (!v || v === "pending" ? "not_called" : null),
  show_no_show: (v) => (v === "Show" ? "came" : v === "No Show" ? "no_show" : "pending_show"),
};

// Discount-category tallies for the whole day, so the desk sees the day's mix
// without counting rows.
function CategoryTallies({ categories }) {
  return (
    <>
      <div className="summary__sep" />
      <div className="summary__group">
        <div className="summary__label">Categories (whole day)</div>
        <div className="summary__pills">
          {PATIENT_CATEGORIES.filter((c) => c.value).map((c) => (
            <span
              key={c.value}
              className={`spill spill--${c.color}`}
              title={`${categories?.[c.value]?.count || 0} ${c.label} patient(s) today`}
            >
              {categories?.[c.value]?.count || 0} {c.label}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function Summary({ summary, categories }) {
  const total = summary.total || 0;
  const came = summary.came || 0;
  const noShow = summary.no_show || 0;
  const pendingShow = summary.pending_show || 0;
  const called = summary.called || 0;
  const notPicked = summary.not_picked || 0;
  const unreachable = summary.unreachable || 0;
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
          <span className="spill spill--amber">{unreachable} Unreachable</span>
          <span className="spill spill--blue">{rescheduled} Rescheduled</span>
        </div>
      </div>
      {categories && <CategoryTallies categories={categories} />}
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

const BOOKING_STATUSES = [
  { value: "", label: "—", color: "gray" },
  { value: "booked", label: "Booked", color: "green" },
  { value: "cancelled", label: "Cancelled", color: "red" },
];

// ─── New Appointment modal ─────────────────────────────────────────────────
function NewAppointmentModal({ doctors, defaultDate, prefill, onClose, onCreated }) {
  const isPrefilled = !!prefill?.patient_name;
  const [form, setForm] = useState({
    patient_name: prefill?.patient_name || "",
    file_no: prefill?.file_no || "",
    phone: prefill?.phone || "",
    alt_phone: prefill?.alt_phone || "",
    doctor_name: prefill?.doctor_name || doctors[0] || "",
    appointment_date: defaultDate,
    time_slot: "",
    // A repeat booking for a known patient is almost always a follow-up
    visit_type: isPrefilled ? "Follow Up" : "New",
    appointment_type: "Physical",
    address: prefill?.address || "",
    condition: prefill?.condition || "",
    booked_by_name: "",
    notes: "",
    home_collection: false,
  });
  const [err, setErr] = useState("");
  const [dup, setDup] = useState(null);
  const [booked, setBooked] = useState(null);

  useBodyScrollLock();

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const [fileNoQuery, setFileNoQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setFileNoQuery(form.file_no.trim()), 350);
    return () => clearTimeout(t);
  }, [form.file_no]);

  const { data: lookedUpPatient, isFetching: lookingUp } = usePatientByFileNo(fileNoQuery);
  const filledFromRef = useRef("");

  useEffect(() => {
    if (!lookedUpPatient) return;
    const key = String(lookedUpPatient.file_no || "");
    if (filledFromRef.current === key) return;
    filledFromRef.current = key;
    setForm((f) => ({
      ...f,
      patient_name: lookedUpPatient.name || f.patient_name,
      phone: String(lookedUpPatient.phone || f.phone || "")
        .replace(/\D/g, "")
        .slice(0, 10),
      alt_phone:
        f.alt_phone.trim() ||
        String(lookedUpPatient.alt_phone || "")
          .replace(/\D/g, "")
          .slice(0, 10),
      address: lookedUpPatient.address || f.address,
      visit_type: f.visit_type === "New" ? "Follow Up" : f.visit_type,
    }));
  }, [lookedUpPatient]);

  const [phoneQuery, setPhoneQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setPhoneQuery(form.phone.trim()), 350);
    return () => clearTimeout(t);
  }, [form.phone]);

  const { data: phonePatient, isFetching: lookingUpPhone } = usePatientByPhone(phoneQuery);
  const filledFromPhoneRef = useRef("");

  useEffect(() => {
    if (!phonePatient) return;
    const key = String(phonePatient.phone || "");
    if (filledFromPhoneRef.current === key) return;
    filledFromPhoneRef.current = key;
    setForm((f) => ({
      ...f,
      patient_name: f.patient_name.trim() || phonePatient.name || "",
      file_no: f.file_no.trim() || String(phonePatient.file_no || ""),
      address: f.address.trim() || phonePatient.address || "",
      alt_phone:
        f.alt_phone.trim() ||
        String(phonePatient.alt_phone || "")
          .replace(/\D/g, "")
          .slice(0, 10),
      visit_type: f.visit_type === "New" ? "Follow Up" : f.visit_type,
    }));
  }, [phonePatient]);

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
  const setAltPhone = (v) => set("alt_phone", v.replace(/\D/g, "").slice(0, 10));

  const save = async (allowDuplicate = false) => {
    const name = form.patient_name.trim();
    if (!name) return setErr("Patient name is required");
    if (!/^[A-Za-z.\s'-]+$/.test(name)) return setErr("Patient name should contain letters only");
    if (!form.doctor_name) return setErr("Please select a doctor");
    if (!form.appointment_date) return setErr("Please select a date");
    // Phone is optional, but if entered must be exactly 10 digits
    if (form.phone && !/^\d{10}$/.test(form.phone))
      return setErr("Mobile number must be exactly 10 digits");
    if (form.alt_phone && !/^\d{10}$/.test(form.alt_phone))
      return setErr("Alternate number must be exactly 10 digits");
    if (form.alt_phone && form.alt_phone === form.phone)
      return setErr("Alternate number must be different from the mobile number");
    // A brand-new patient (no file no) needs a phone to be reachable
    if (!form.file_no.trim() && !form.phone)
      return setErr("Mobile number is required for a new patient");
    if (form.file_no && !/^[A-Za-z0-9_-]+$/.test(form.file_no.trim()))
      return setErr("File No can only contain letters, numbers, _ and -");

    setErr("");
    setDup(null);
    try {
      const created = await createMutation.mutateAsync(
        allowDuplicate ? { ...form, allow_duplicate: true } : form,
      );
      setBooked({
        patient_name: form.patient_name.trim(),
        file_no: created?.file_no || form.file_no.trim(),
        phone: form.phone,
        doctor_name: form.doctor_name,
        appointment_date: form.appointment_date,
        time_slot: form.time_slot,
        reporting_time_slot: created?.reporting_time_slot || "",
      });
    } catch (e) {
      const data = e?.response?.data;
      if (data?.error === "duplicate_booking") return setDup(data.detail || {});
      setErr(data?.error || "Could not save. Please try again.");
    }
  };

  const done = () => onCreated(booked?.appointment_date || form.appointment_date);

  if (booked) {
    return (
      <div className="modal-overlay" onClick={done}>
        <div className="modal modal--sm" onClick={(e) => e.stopPropagation()}>
          <div className="modal__hdr">
            <span className="modal__title">
              <Check size={16} aria-hidden="true" />
              Appointment Booked
            </span>
            <button className="modal__x" onClick={done} aria-label="Close">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className="modal__body">
            <div className="booked">
              <div className="booked__line">
                <strong>{booked.patient_name}</strong>
                {booked.file_no ? ` · ${booked.file_no}` : ""}
                {booked.phone ? ` · ${booked.phone}` : ""}
              </div>
              <div className="booked__date">
                Booked for <strong>{prettyDate(booked.appointment_date)}</strong>
                {booked.time_slot ? ` · ${booked.time_slot}` : ""}
              </div>
              <div className="booked__line">
                With <strong>{booked.doctor_name}</strong>
              </div>
              {booked.reporting_time_slot && (
                <div className="booked__line booked__line--muted">
                  Reporting time: {booked.reporting_time_slot}
                </div>
              )}
              <div className="booked__line booked__line--muted">
                Tell the patient this date and slot before ending the call.
              </div>
            </div>
          </div>
          <div className="modal__foot">
            <button className="btn btn--primary" onClick={done}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

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
          {dup && (
            <div className="modal__err">
              This patient already has an appointment on {form.appointment_date}
              {dup.doctor_name ? ` with ${dup.doctor_name}` : ""}
              {dup.time_slot ? ` at ${dup.time_slot}` : ""}
              {dup.booked_by_name ? `, booked by ${dup.booked_by_name}` : ""}.
              <button type="button" className="btn btn--ghost" onClick={() => save(true)}>
                Book anyway
              </button>
            </div>
          )}
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
                {lookingUp && <em className="fld__opt"> — searching…</em>}
                {!lookingUp && lookedUpPatient && (
                  <em className="fld__ok"> — {lookedUpPatient.name} found</em>
                )}
                {!lookingUp && fileNoQuery.length >= 3 && !lookedUpPatient && (
                  <em className="fld__warn"> — no match</em>
                )}
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
                {lookingUpPhone && <em className="fld__opt"> — searching…</em>}
                {!lookingUpPhone && phonePatient && (
                  <em className="fld__ok"> — {phonePatient.name} found</em>
                )}
                {!lookingUpPhone && phoneQuery.length === 10 && !phonePatient && (
                  <em className="fld__warn"> — no match</em>
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
              <span>
                Alternate Number <em className="fld__opt">(optional)</em>
                {form.alt_phone && form.alt_phone.length !== 10 && (
                  <em className="fld__warn"> {form.alt_phone.length}/10</em>
                )}
              </span>
              <input
                type="tel"
                inputMode="numeric"
                maxLength={10}
                value={form.alt_phone}
                onChange={(e) => setAltPhone(e.target.value)}
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
              <select
                value={form.appointment_type}
                onChange={(e) => set("appointment_type", e.target.value)}
              >
                {APPOINTMENT_MODES.map((v) => (
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
            <label className="fld fld--wide">
              <span>Address</span>
              <input
                value={form.address}
                onChange={(e) => set("address", e.target.value)}
                placeholder="House / street, area, city, pincode"
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
          <button className="btn btn--primary" onClick={() => save()} disabled={saving}>
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
                  <span className={`badge badge--${callColor(h.outcome)}`}>
                    {callLabel(h.outcome)}
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
                Change History (Doctor / Preferred Date / Called By / Booking Status)
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
                    {c.changed_by && <span className="chg-by">by {c.changed_by}</span>}
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
              className={`csel csel--${callColor(outcome)}`}
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
                <span className={`badge badge--${callColor(confirmDel.outcome)}`}>
                  {callLabel(confirmDel.outcome)}
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

// ─── "Calling now" flag ────────────────────────────────────────────────────
// One patient, one caller: an OBT agent marks the row before dialling so the
// rest of the team sees the call in progress instead of ringing the patient a
// second time. The claim expires server-side, so a closed tab never leaves a
// row locked.
function callMinsAgo(ts) {
  if (!ts) return 0;
  return Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
}

function CallingFlag({ row, active, mine, claim, release }) {
  const [error, setError] = useState("");
  const busy =
    (claim.isPending && claim.variables === row.id) ||
    (release.isPending && release.variables === row.id);

  const toggle = async () => {
    setError("");
    try {
      if (mine) await release.mutateAsync(row.id);
      else await claim.mutateAsync(row.id);
    } catch (e) {
      setError(e?.response?.data?.error || "Could not update the calling flag");
    }
  };

  if (active && !mine) {
    const mins = callMinsAgo(active.calling_since);
    return (
      <span
        className="calling-flag calling-flag--other"
        title={`${active.calling_by} is calling this patient — started ${mins} min ago`}
      >
        <PhoneCall size={11} aria-hidden="true" />
        <span className="calling-flag__who">{active.calling_by}</span>
        {mins > 0 && <span className="calling-flag__mins">{mins}m</span>}
      </span>
    );
  }

  return (
    <>
      <button
        className={`calling-flag calling-flag--btn${mine ? " calling-flag--mine" : ""}`}
        onClick={toggle}
        disabled={busy}
        aria-pressed={mine}
        title={
          mine
            ? "You marked this call in progress — click to clear it"
            : "Tell the team you are calling this patient now"
        }
      >
        <PhoneCall size={11} aria-hidden="true" />
        {mine ? "You" : "Calling"}
      </button>
      {error && <span className="calling-flag__err">{error}</span>}
    </>
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
    searchParams.get("date") ||
      (initialTab.offset !== null ? addDaysStr(initialTab.offset) : todayStr()),
  );
  const [showNew, setShowNew] = useState(false);
  const [newPrefill, setNewPrefill] = useState(null);
  const [doctor, setDoctor] = useState(searchParams.get("doctor") || "All");
  const [collectionFilter, setCollectionFilter] = useState(searchParams.get("collection") || "all");
  // Debounced copy of `search` — drives the date-independent Patient Lookup fetch
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get("q") || "");
  const [search, setSearch] = useState(searchParams.get("q") || "");
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

  const tabDefaultDate = (id) => {
    const t = VIEW_TABS.find((x) => x.id === id);
    return t && t.offset !== null ? addDaysStr(t.offset) : todayStr();
  };

  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const put = (k, v, def) => (v && v !== def ? next.set(k, v) : next.delete(k));
        put("doctor", doctor, "All");
        put("collection", collectionFilter, "all");
        put("q", searchQ, "");
        put("date", date, tabDefaultDate(view));
        return next;
      },
      { replace: true },
    );
  }, [doctor, collectionFilter, searchQ, date, view, setSearchParams]);

  const filtersActive =
    doctor !== "All" ||
    collectionFilter !== "all" ||
    searchQ !== "" ||
    date !== tabDefaultDate(view);

  const resetFilters = () => {
    setDoctor("All");
    setCollectionFilter("all");
    setSearch("");
    setDebouncedSearch("");
    setDate(tabDefaultDate(view));
  };

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
  const activeCallQuery = useActiveCalls(appointmentIds);
  const categoryQuery = useCategoryCounts(view === "lookup" ? null : date);
  const { claim: claimCall, release: releaseCall } = useCallClaim();
  // The date a row's preferred time applies to: the preferred date once one is
  // set, otherwise the appointment's own date.
  const preferredDates = useMemo(() => rows.map(slotCountDate), [rows]);
  const slotCountQuery = useGhmSlotCounts(preferredDates);
  const slotCounts = slotCountQuery.data || {};
  const biomarkers = biomarkerQuery.data || {};
  const lastMo = lastMoQuery.data || {};
  const attemptCounts = attemptQuery.data || {};
  const activeCalls = activeCallQuery.data || {};
  const categoryCounts = categoryQuery.data || null;

  // Category options carry the day's headcount as a badge, the same way the
  // preferred-time options show how full a slot already is — the OBT agent sees
  // the mix while choosing, not only in the summary bar.
  const categoryOptions = useMemo(
    () =>
      PATIENT_CATEGORIES.map((c) => {
        const count = c.value ? categoryCounts?.[c.value]?.count || 0 : 0;
        return {
          ...c,
          badge: count || undefined,
          badgeTitle: count
            ? `${count} patient${count > 1 ? "s" : ""} in this category today`
            : undefined,
        };
      }),
    [categoryCounts],
  );
  // Any request still in flight while rows are already on screen — a refetch on
  // focus, a stale-time refresh or the per-page batches catching up. The rows
  // shown are the previous answer until it lands, so the header says so.
  const refreshing =
    !listQuery.isPending &&
    (listQuery.isFetching ||
      biomarkerQuery.isFetching ||
      lastMoQuery.isFetching ||
      slotCountQuery.isFetching ||
      attemptQuery.isFetching);

  const exportMutation = useExportPages(buildQuery, EXPORT_PAGE_SIZE);
  const exporting = exportMutation.isPending;

  // Exports whatever the current tab is showing, filters included — the file is
  // named after the tab and its date so a By Date and a Follow-up export of the
  // same day do not overwrite each other in the downloads folder.
  const exportWati = useCallback(async () => {
    try {
      const all = await exportMutation.mutateAsync();
      if (!all.length) {
        window.alert("Nothing to export for this view.");
        return;
      }
      const label = EXPORT_LABELS[view] || "ghm-export";
      const counts = await exportWatiWorkbook(all, view === "lookup" ? todayStr() : date, label);
      if (!counts.total) window.alert("No patients with a phone number to export.");
    } catch (e) {
      // Without this the whole export failed into an unhandled rejection and
      // the button just looked broken.
      console.error("[GHM export] failed", e);
      window.alert(`Export failed: ${e?.response?.data?.error || e?.message || e}`);
    }
  }, [exportMutation, date, view]);

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
  // Per-tab column visibility
  const showShowNoShow = false; // Show/No-Show column hidden on all tabs
  const showRecovery = false; // Recovery column hidden on all tabs
  const showCallStatus = true;
  const showCalledBy = true;
  const showCallDate = true;
  const showFollowUpDate = true;
  // Lookup spans every date, so each row needs to say which visit it is showing.
  // The other tabs are pinned to one date and would just repeat it 50 times.
  const showApptDate = view === "lookup";
  // Where the patient is in the day — the same states the OPD board shows.
  // Only once the day has arrived: on a future date nobody has checked in yet,
  // so every row would read "Pending".
  const showVisitStatus = view === "by_date" && date <= todayStr();
  const colSpan =
    17 +
    (showApptDate ? 1 : 0) +
    (showVisitStatus ? 1 : 0) +
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
            {filtersActive && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={resetFilters}
                title="Clear search, doctor, collection and date filters"
              >
                <RotateCcw size={14} aria-hidden="true" />
                Reset filters
              </button>
            )}
            {view !== "reassign" && (
              <button
                type="button"
                className="btn btn--ghost"
                onClick={exportWati}
                disabled={exporting || !listEnabled || total === 0}
                title={
                  total === 0 ? "Nothing to export in this view" : "Download this list as Excel"
                }
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
              {/* The By Date tab is "Today" until another date is picked — then
                  it says so, with the date underneath, rather than still
                  claiming to show today. */}
              {t.id === "by_date" && view === t.id && date !== todayStr() ? "By Date" : t.label}
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
          {showRows && <Summary summary={summary} categories={categoryCounts} />}

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
                    <th style={{ width: 96 }}>Calling</th>
                    <th style={{ width: 36 }}>#</th>
                    {showApptDate && <th style={{ width: 120 }}>Appointment</th>}
                    {showVisitStatus && <th style={{ width: 120 }}>Visit Status</th>}
                    <th style={{ minWidth: 170 }}>Patient</th>
                    <th style={{ width: 155 }}>Biomarkers (auto)</th>
                    <th style={{ width: 140 }}>Booking Status</th>
                    <th style={{ width: 100 }}>Visit Type</th>
                    <th style={{ width: 165 }}>Category</th>
                    <th style={{ width: 110 }}>Mode</th>
                    <th style={{ width: 220 }}>Doctor</th>
                    <th style={{ width: 150 }}>Assigned MO</th>
                    <th style={{ width: 140 }}>Last Consultant Seen</th>
                    <th style={{ width: 120 }}>Last Visit Date</th>
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
                    <th style={{ width: 195 }}>Preferred Time</th>
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
                    const activeCall = activeCalls[row.id] || null;
                    const callingIsMine =
                      !!activeCall &&
                      (activeCall.calling_by_id === currentDoctor?.id ||
                        (!activeCall.calling_by_id && activeCall.calling_by === loggedInName));

                    return (
                      <Fragment key={row.id}>
                        <tr
                          className={[
                            "tbl__row",
                            showStat === "Show" ? "tbl__row--came" : "",
                            showStat === "No Show" ? "tbl__row--noshow" : "",
                            callStat === "not_picked" ? "tbl__row--notpicked" : "",
                            activeCall && !callingIsMine ? "tbl__row--calling" : "",
                            isSaving ? "tbl__row--saving" : "",
                            isOpen ? "tbl__row--open" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {/* Chevron toggle + the team-wide "calling now" flag.
                              First column so a call in progress is the first
                              thing any OBT agent sees on the row. */}
                          <td className="tc">
                            <div className="callcol">
                              <button
                                className={`chev ${isOpen ? "chev--open" : ""}`}
                                title={isOpen ? "Hide call history" : "Show call history"}
                                aria-label={isOpen ? "Hide call history" : "Show call history"}
                                aria-expanded={isOpen}
                                onClick={() => setExpanded(isOpen ? null : row.id)}
                              >
                                <ChevronRight size={16} aria-hidden="true" />
                                <span className="chev__txt">History</span>
                              </button>
                              <CallingFlag
                                row={row}
                                active={activeCall}
                                mine={callingIsMine}
                                claim={claimCall}
                                release={releaseCall}
                              />
                            </div>
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

                          {showVisitStatus && (
                            <td>
                              {(() => {
                                const st = visitStatus(row.status);
                                return (
                                  <span className={`badge badge--${st.tone}`}>{st.label}</span>
                                );
                              })()}
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
                                {row.booking_status === "booked" && (
                                  <span className="booked-tag">Booked</span>
                                )}
                                {row.booking_status === "cancelled" && (
                                  <span className="cancel-tag">Cancelled</span>
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
                              {row.alt_phone && (
                                <a
                                  className="pcell__ph pcell__ph--alt"
                                  href={`tel:${String(row.alt_phone).replace(/\D/g, "")}`}
                                  title="Call this patient on the alternate number"
                                >
                                  <Phone size={12} aria-hidden="true" />
                                  {fmtPhone(row.alt_phone)}
                                  <em className="pcell__phtag">Alt</em>
                                </a>
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
                                    address: row.address,
                                    doctor_name: row.doctor_name,
                                    alt_phone: row.alt_phone,
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

                          {/* Booking status — OBT marks a cancellation from the call */}
                          <td>
                            <ColorSelect
                              value={row.booking_status || ""}
                              options={BOOKING_STATUSES}
                              onChange={(v) => patch(row.id, "booking_status", v)}
                            />
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

                          {/* Discount category — editable */}
                          <td>
                            <ColorSelect
                              value={row.patient_category || ""}
                              options={categoryOptions}
                              onChange={(v) => patch(row.id, "patient_category", v)}
                            />
                          </td>

                          {/* Mode of appointment — editable */}
                          <td>
                            <Dropdown
                              value={row.mode_of_appointment || ""}
                              options={withCurrent(MODE_OPTIONS, row.mode_of_appointment)}
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

                          <td>
                            {row.last_visit_date ? (
                              <span className="fu-date">{prettyDate(row.last_visit_date)}</span>
                            ) : (
                              <span className="muted" title="No earlier attended visit on record">
                                —
                              </span>
                            )}
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
                                defaultValue={
                                  row.call_made_by || activeCall?.calling_by || loggedInName || ""
                                }
                                key={`cb-${row.id}-${row.call_made_by}-${activeCall?.calling_by || ""}`}
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
                                const rawTiming = hr.timing || "";
                                const hrTiming = followUpTiming(rawTiming);
                                const hrNotes = [hrTiming ? "" : rawTiming, hr.notes || ""]
                                  .filter(Boolean)
                                  .join(" · ");
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
                                ).map((t) => {
                                  const booked = slotBooked(t, slotCounts, row);
                                  return {
                                    value: t,
                                    label: t,
                                    badge: booked || undefined,
                                    badgeTone: slotTone(booked),
                                    badgeTitle: booked
                                      ? `${booked} patient${booked > 1 ? "s" : ""} already in this slot`
                                      : undefined,
                                  };
                                }),
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
