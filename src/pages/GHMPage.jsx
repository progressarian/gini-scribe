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
  Maximize2,
  Minimize2,
  MoveDown,
  MoveRight,
  MoveUp,
  Pencil,
  Phone,
  PhoneCall,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  Smartphone,
  Star,
  Sunrise,
  Trash2,
  Users,
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
  NO_ATTEMPT_STATUSES,
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
import BlockedBadge from "../components/ui/BlockedBadge.jsx";
import { usePatientBlockStatus } from "../queries/hooks/usePatientBlocks.js";
import DatePicker from "../components/DatePicker.jsx";
import useBodyScrollLock from "../hooks/useBodyScrollLock.js";
import useViewportFill from "../hooks/useViewportFill.js";
import {
  PAGE_SIZE,
  fetchLastMo,
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
  usePatientsByPhone,
  useReassignAppointment,
  useUpdateAppointmentPatient,
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
const CALL_LOCK_HINT = "Set the call status first — these record who made the call and when.";

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

// The tab survives a reload even when the URL has been stripped (a bookmark, a
// sidebar link, a fresh window) — the URL stays the source of truth, this is the
// fallback behind it.
const TAB_STORE_KEY = "ghm_view_tab";

const readStoredTab = () => {
  try {
    return localStorage.getItem(TAB_STORE_KEY) || "";
  } catch {
    return "";
  }
};

const storeTab = (id) => {
  try {
    localStorage.setItem(TAB_STORE_KEY, id);
  } catch {
    /* private mode / storage disabled — the URL still carries the tab */
  }
};

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

// Compact mode cuts the Patient cell down to the name and the number people
// dial. What it drops has no column of its own, so it is read back here in the
// row's expander — nothing compact hides becomes unreachable.
const compactDetails = (row) =>
  [
    [
      "Sex / age",
      [row.disp_sex, row.disp_age != null ? `${row.disp_age} yrs` : null]
        .filter(Boolean)
        .join(" · "),
    ],
    ["Address", row.address],
    ["Condition", row.condition],
    ["Alternate mobile", altList(row.alt_phone).map(fmtPhone).join(", ")],
  ].map(([label, value]) => ({ label, value: value || "—" }));

// Every pill is a filter for its own bucket: clicking one asks the server for
// exactly the rows it counts, clicking it again clears it. `bucket` is the name
// the API takes and `key` the summary column it counts — both are the same word
// on the server (SUMMARY_BUCKETS), so a pill can never open rows it did not
// count. Total is the cleared state rather than a bucket of its own.
const APPT_PILLS = [
  { bucket: "", key: "total", label: "Total", color: "" },
  { bucket: "pending_show", key: "pending_show", label: "Pending", color: "gray" },
  { bucket: "follow_up", key: "follow_up", label: "Follow-up", color: "amber" },
  { bucket: "home_collection", key: "home_collection", label: "Home Collection", color: "purple" },
];

const CALL_PILLS = [
  { bucket: "not_called", key: "not_called", label: "Need to Call", color: "orange" },
  { bucket: "called", key: "called", label: "Spoke", color: "green" },
  { bucket: "not_picked", key: "not_picked", label: "Not Picked", color: "red" },
  { bucket: "unreachable", key: "unreachable", label: "Unreachable", color: "amber" },
  { bucket: "rescheduled", key: "rescheduled", label: "Rescheduled", color: "blue" },
];

const CATEGORY_PILLS = PATIENT_CATEGORIES.filter((c) => c.value).map((c) => ({
  bucket: `cat_${c.value}`,
  key: `cat_${c.value}`,
  label: c.label,
  color: c.color,
  category: c.value,
}));

function Pill({ pill, count, active, onSelect, title }) {
  return (
    <button
      type="button"
      className={`spill${pill.color ? ` spill--${pill.color}` : ""} spill--btn${active ? " is-on" : ""}`}
      aria-pressed={active}
      title={title}
      onClick={() => onSelect(active ? "" : pill.bucket)}
    >
      {count} {pill.label}
    </button>
  );
}

function PillGroup({ label, pills, summary, filter, onFilter, titleFor }) {
  return (
    <div className="summary__group">
      <div className="summary__label">{label}</div>
      <div className="summary__pills">
        {pills.map((p) => (
          <Pill
            key={p.key}
            pill={p}
            count={summary[p.key] || 0}
            active={filter === p.bucket}
            onSelect={onFilter}
            title={titleFor ? titleFor(p) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function Summary({ summary, categories, filter, onFilter }) {
  // The category pill counts the same rows the list holds, so clicking it lands
  // on that many rows. The day-wide tally — every appointment booked on the
  // date, filters ignored — stays available on hover.
  const categoryTitle = (p) => {
    const day = categories?.[p.category]?.count;
    const scope = day == null ? "" : ` · ${day} across the whole day`;
    return `${summary[p.key] || 0} ${p.label} in this list${scope}`;
  };

  return (
    <div className="summary">
      <PillGroup
        label="Appointments"
        pills={APPT_PILLS}
        summary={summary}
        filter={filter}
        onFilter={onFilter}
      />
      <div className="summary__sep" />
      <PillGroup
        label="Calling"
        pills={CALL_PILLS}
        summary={summary}
        filter={filter}
        onFilter={onFilter}
      />
      {categories && (
        <>
          <div className="summary__sep" />
          <PillGroup
            label="Categories"
            pills={CATEGORY_PILLS}
            summary={summary}
            filter={filter}
            onFilter={onFilter}
            titleFor={categoryTitle}
          />
        </>
      )}
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

const toAltList = (v) => {
  const list = (Array.isArray(v) ? v : String(v ?? "").split(/[,;/\s]+/))
    .map((x) => String(x ?? "").replace(/\D/g, ""))
    .filter(Boolean);
  return list.length ? list : [""];
};

const altList = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [String(v)] : []);

const BOOKING_STATUSES = [
  { value: "", label: "—", color: "gray" },
  { value: "booked", label: "Booked", color: "green" },
  { value: "cancelled", label: "Cancelled", color: "red" },
];

// Gender values the patients table accepts — the column has a CHECK on them.
const SEXES = ["Male", "Female", "Other"];

// The desk usually knows the age, not the date of birth. Either is accepted;
// when a DOB is there the age follows from it and is never typed by hand.
const ageFromDob = (dob) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dob || ""))) return "";
  const b = new Date(`${dob}T00:00:00`);
  if (Number.isNaN(b.getTime())) return "";
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age -= 1;
  return age >= 0 && age <= 120 ? String(age) : "";
};

const toDateInput = (v) => (v ? String(v).slice(0, 10) : "");

// Legacy rows carry "male"/"MALE" — match them to the canonical option so the
// dropdown shows what is stored instead of reading as "not set".
const canonSex = (v) => SEXES.find((s) => s.toLowerCase() === String(v || "").toLowerCase()) || "";

// Shared alternate-numbers editor — the booking form and the edit form keep
// the same list of extra numbers for a patient.
function AltPhoneFields({ list, onChange }) {
  const setAt = (i, v) =>
    onChange(list.map((x, j) => (j === i ? v.replace(/\D/g, "").slice(0, 10) : x)));
  const removeAt = (i) => {
    const next = list.filter((_, j) => j !== i);
    onChange(next.length ? next : [""]);
  };
  return (
    <div className="fld">
      <span>
        Alternate Numbers <em className="fld__opt">(optional)</em>
      </span>
      {list.map((v, i) => (
        <div className="altrow" key={i}>
          <input
            type="tel"
            inputMode="numeric"
            maxLength={10}
            value={v}
            onChange={(e) => setAt(i, e.target.value)}
            placeholder="10-digit number"
            aria-label={`Alternate number ${i + 1}`}
          />
          {(v || list.length > 1) && (
            <button
              type="button"
              className="altrow__x"
              onClick={() => removeAt(i)}
              aria-label={`Remove alternate number ${i + 1}`}
            >
              <X size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
      <button type="button" className="altrow__add" onClick={() => onChange([...list, ""])}>
        <Plus size={12} aria-hidden="true" />
        Add another number
      </button>
    </div>
  );
}

// Shared DOB / Age / Gender trio — the New Appointment form and the Edit
// Patient form capture exactly the same three facts.
function DemographicFields({ dob, age, sex, onChange }) {
  const derived = ageFromDob(dob);
  return (
    <>
      <label className="fld">
        <span>
          Date of Birth <em className="fld__opt">(optional)</em>
        </span>
        <input
          type="date"
          max={todayStr()}
          value={dob}
          onChange={(e) => onChange("dob", e.target.value)}
        />
      </label>
      <label className="fld">
        <span>Age {dob && <em className="fld__opt">— from date of birth</em>}</span>
        <input
          type="number"
          min="0"
          max="120"
          inputMode="numeric"
          value={dob ? derived : age}
          readOnly={!!dob}
          onChange={(e) => onChange("age", e.target.value.replace(/\D/g, "").slice(0, 3))}
          placeholder="Years"
        />
      </label>
      <label className="fld">
        <span>Gender</span>
        <select value={sex} onChange={(e) => onChange("sex", e.target.value)}>
          <option value="">— Select gender</option>
          {SEXES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

// ─── New Appointment modal ─────────────────────────────────────────────────
function NewAppointmentModal({ doctors, defaultDate, prefill, onClose, onCreated }) {
  const isPrefilled = !!prefill?.patient_name;
  const [form, setForm] = useState({
    patient_name: prefill?.patient_name || "",
    file_no: prefill?.file_no || "",
    phone: prefill?.phone || "",
    alt_phone: toAltList(prefill?.alt_phone),
    dob: toDateInput(prefill?.dob),
    age: prefill?.age != null ? String(prefill.age) : "",
    sex: canonSex(prefill?.sex),
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
      alt_phone: f.alt_phone.some(Boolean) ? f.alt_phone : toAltList(lookedUpPatient.alt_phone),
      dob: f.dob || toDateInput(lookedUpPatient.dob),
      age: f.age || (lookedUpPatient.age != null ? String(lookedUpPatient.age) : ""),
      sex: f.sex || canonSex(lookedUpPatient.sex),
      address: lookedUpPatient.address || f.address,
      visit_type: f.visit_type === "New" ? "Follow Up" : f.visit_type,
    }));
  }, [lookedUpPatient]);

  const [phoneQuery, setPhoneQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setPhoneQuery(form.phone.trim()), 350);
    return () => clearTimeout(t);
  }, [form.phone]);

  // A number can belong to several charts — families share one line. One match
  // fills the form as before; several must be chosen between, because guessing
  // books the appointment onto a sibling's chart. Booking a second person on a
  // known number is the same flow: "Someone else on this number".
  const { data: phoneMatches, isFetching: lookingUpPhone } = usePatientsByPhone(phoneQuery);
  const matches = useMemo(() => safeArr(phoneMatches), [phoneMatches]);
  const [pickedPhonePatient, setPickedPhonePatient] = useState(null);
  const filledFromPhoneRef = useRef("");

  const fillFromPatient = useCallback((p) => {
    setForm((f) => ({
      ...f,
      patient_name: p.name || f.patient_name,
      file_no: String(p.file_no || ""),
      address: p.address || f.address,
      alt_phone: f.alt_phone.some(Boolean) ? f.alt_phone : toAltList(p.alt_phone),
      dob: toDateInput(p.dob) || f.dob,
      age: p.age != null ? String(p.age) : f.age,
      sex: canonSex(p.sex) || f.sex,
      visit_type: f.visit_type === "New" ? "Follow Up" : f.visit_type,
    }));
  }, []);

  useEffect(() => {
    if (matches.length !== 1) return;
    const only = matches[0];
    const key = String(only.id || only.file_no || "");
    if (filledFromPhoneRef.current === key) return;
    filledFromPhoneRef.current = key;
    setPickedPhonePatient(only);
    setForm((f) => ({
      ...f,
      patient_name: f.patient_name.trim() || only.name || "",
      file_no: f.file_no.trim() || String(only.file_no || ""),
      address: f.address.trim() || only.address || "",
      alt_phone: f.alt_phone.some(Boolean) ? f.alt_phone : toAltList(only.alt_phone),
      dob: f.dob || toDateInput(only.dob),
      age: f.age || (only.age != null ? String(only.age) : ""),
      sex: f.sex || canonSex(only.sex),
      visit_type: f.visit_type === "New" ? "Follow Up" : f.visit_type,
    }));
  }, [matches]);

  // A new number, or one the desk edited, clears the earlier choice so the
  // chooser comes back instead of leaving a stale chart selected.
  useEffect(() => {
    setPickedPhonePatient(null);
    filledFromPhoneRef.current = "";
  }, [phoneQuery]);

  const chooseSharedPatient = (p) => {
    setPickedPhonePatient(p || { id: "new" });
    if (p) fillFromPatient(p);
    else
      setForm((f) => ({
        ...f,
        file_no: "",
        visit_type: "New",
      }));
  };

  const needsPhoneChoice = matches.length > 1 && !pickedPhonePatient;

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

  const save = async (allowDuplicate = false) => {
    const name = form.patient_name.trim();
    if (!name) return setErr("Patient name is required");
    if (!/^[A-Za-z.\s'-]+$/.test(name)) return setErr("Patient name should contain letters only");
    if (!form.doctor_name) return setErr("Please select a doctor");
    if (!form.appointment_date) return setErr("Please select a date");
    // Phone is optional, but if entered must be exactly 10 digits
    if (form.phone && !/^\d{10}$/.test(form.phone))
      return setErr("Mobile number must be exactly 10 digits");
    const alts = form.alt_phone.map((v) => v.trim()).filter(Boolean);
    if (alts.some((v) => !/^\d{10}$/.test(v)))
      return setErr("Each alternate number must be exactly 10 digits");
    if (alts.some((v) => v === form.phone))
      return setErr("An alternate number must be different from the mobile number");
    if (new Set(alts).size !== alts.length)
      return setErr("The same alternate number is entered twice");
    // A brand-new patient (no file no) needs a phone to be reachable
    if (!form.file_no.trim() && !form.phone)
      return setErr("Mobile number is required for a new patient");
    if (form.file_no && !/^[A-Za-z0-9_-]+$/.test(form.file_no.trim()))
      return setErr("File No can only contain letters, numbers, _ and -");
    // Several charts share this number and nobody has said which — booking now
    // would attach the visit to whichever one happened to sort first.
    if (needsPhoneChoice)
      return setErr("This number belongs to more than one patient — pick who this is for");
    if (form.dob && form.dob > todayStr()) return setErr("Date of birth cannot be in the future");
    if (!form.dob && form.age && +form.age > 120) return setErr("Age must be between 0 and 120");

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
          {needsPhoneChoice && (
            <div className="pickpt">
              <div className="pickpt__hdr">
                <Users size={14} aria-hidden="true" />
                {matches.length} patients share this number — who is this appointment for?
              </div>
              <ul className="pickpt__list">
                {matches.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="pickpt__opt"
                      onClick={() => chooseSharedPatient(p)}
                    >
                      <span className="pickpt__name">{p.name}</span>
                      <span className="pickpt__meta">
                        {[
                          p.file_no,
                          canonSex(p.sex),
                          p.age != null ? `${p.age} yrs` : null,
                          p.last_visit
                            ? `last visit ${prettyDate(String(p.last_visit).slice(0, 10))}`
                            : null,
                          p.visit_count ? `${p.visit_count} visits` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className="pickpt__opt pickpt__opt--new"
                    onClick={() => chooseSharedPatient(null)}
                  >
                    <span className="pickpt__name">Someone else on this number</span>
                    <span className="pickpt__meta">
                      Creates a new patient record with its own File No
                    </span>
                  </button>
                </li>
              </ul>
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
                {!lookingUpPhone && matches.length === 1 && (
                  <em className="fld__ok"> — {matches[0].name} found</em>
                )}
                {!lookingUpPhone && matches.length > 1 && (
                  <em className="fld__warn"> — {matches.length} patients on this number</em>
                )}
                {!lookingUpPhone && phoneQuery.length === 10 && matches.length === 0 && (
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
            <AltPhoneFields list={form.alt_phone} onChange={(next) => set("alt_phone", next)} />
            <DemographicFields
              dob={form.dob}
              age={form.age}
              sex={form.sex}
              onChange={(k, v) => set(k, v)}
            />
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

// ─── Edit Patient modal ────────────────────────────────────────────────────
// A booking is made on the phone, often before the desk has the patient's full
// details — so everything the booking form captures stays correctable from the
// row afterwards. File No is the one exception: it identifies the chart, and
// re-pointing a booking at a different patient is a reassignment, not an edit.
// The save writes the appointment and the patient master together, so the next
// booking starts from the corrected record.
function EditPatientModal({ row, doctors, onClose }) {
  const [form, setForm] = useState({
    patient_name: row.patient_name || "",
    phone: String(row.phone || "")
      .replace(/\D/g, "")
      .slice(-10),
    alt_phone: toAltList(row.alt_phone),
    dob: toDateInput(row.disp_dob),
    age: row.disp_age != null ? String(row.disp_age) : "",
    sex: canonSex(row.disp_sex),
    appointment_date: toDateInput(row.appointment_date),
    time_slot: row.time_slot || "",
    doctor_name: row.doctor_name || "",
    appointment_type: row.mode_of_appointment || row.appointment_type || "",
    condition: row.condition || "",
    address: row.address || "",
    booked_by_name: row.booked_by_name || "",
    notes: row.notes || "",
    home_collection: !!row.home_collection,
  });
  const [err, setErr] = useState("");

  useBodyScrollLock();

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const { data: availData } = useDayAvailability(form.doctor_name, form.appointment_date);
  const availSlots = availData ?? null;

  const updateMutation = useUpdateAppointmentPatient();
  const saving = updateMutation.isPending;

  // A slot that has gone unavailable since the booking is still the one this
  // patient holds — it stays selectable so an unrelated edit never silently
  // drops it. Only a fresh pick has to land on a free slot.
  //
  // It is listed verbatim rather than through withCurrent(): most bookings
  // carry a sheet ("05. 1-2PM") or HealthRay ("13:00") label that the catalog
  // never had, so tagging those "(retired)" would claim the patient's slot was
  // discontinued when it is only written in another format.
  const offered = slotOptions(availSlots).map((s) => ({
    value: s.slot_label,
    label: s.available
      ? s.slot_label
      : `${s.slot_label} — ${SLOT_REASON[s.blocked_by] || "Unavailable"}`,
    available: s.available,
  }));
  const slotList = offered.some((s) => s.value === form.time_slot)
    ? offered
    : [
        ...(form.time_slot
          ? [{ value: form.time_slot, label: `${form.time_slot} — booked`, available: true }]
          : []),
        ...offered,
      ];

  const doctorList = withCurrent(
    doctors.map((d) => ({ value: d, label: d })),
    form.doctor_name,
  );

  const save = async () => {
    const name = form.patient_name.trim();
    if (!name) return setErr("Patient name is required");
    if (!/^[A-Za-z.\s'-]+$/.test(name)) return setErr("Patient name should contain letters only");
    if (!form.doctor_name) return setErr("Please select a doctor");
    if (!form.appointment_date) return setErr("Please select a date");
    if (form.phone && !/^\d{10}$/.test(form.phone))
      return setErr("Mobile number must be exactly 10 digits");
    const alts = form.alt_phone.map((v) => v.trim()).filter(Boolean);
    if (alts.some((v) => !/^\d{10}$/.test(v)))
      return setErr("Each alternate number must be exactly 10 digits");
    if (alts.some((v) => v === form.phone))
      return setErr("An alternate number must be different from the mobile number");
    if (new Set(alts).size !== alts.length)
      return setErr("The same alternate number is entered twice");
    if (form.dob && form.dob > todayStr()) return setErr("Date of birth cannot be in the future");
    if (!form.dob && form.age && +form.age > 120) return setErr("Age must be between 0 and 120");

    setErr("");
    try {
      await updateMutation.mutateAsync({
        id: row.id,
        patient_name: name,
        phone: form.phone,
        alt_phone: alts,
        dob: form.dob,
        age: form.dob ? "" : form.age,
        sex: form.sex,
        appointment_date: form.appointment_date,
        time_slot: form.time_slot,
        doctor_name: form.doctor_name,
        appointment_type: form.appointment_type,
        condition: form.condition.trim(),
        address: form.address.trim(),
        booked_by_name: form.booked_by_name.trim(),
        notes: form.notes.trim(),
        home_collection: form.home_collection,
      });
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.error || "Could not save. Please try again.");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__hdr">
          <span className="modal__title">
            <Pencil size={16} aria-hidden="true" />
            {row.file_no ? `Edit Patient Details — ${row.file_no}` : "Edit Patient Details"}
          </span>
          <button className="modal__x" onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div className="modal__body">
          {err && <div className="modal__err">{err}</div>}

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
                onChange={(e) => set("phone", e.target.value.replace(/\D/g, "").slice(0, 10))}
                placeholder="10-digit number"
              />
            </label>
            <AltPhoneFields list={form.alt_phone} onChange={(next) => set("alt_phone", next)} />
            <DemographicFields
              dob={form.dob}
              age={form.age}
              sex={form.sex}
              onChange={(k, v) => set(k, v)}
            />
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
                {slotList.map((s) => (
                  <option
                    key={s.value}
                    value={s.value}
                    disabled={s.available === false && s.value !== form.time_slot}
                  >
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="fld fld--wide">
              <span>Doctor *</span>
              <select value={form.doctor_name} onChange={(e) => set("doctor_name", e.target.value)}>
                <option value="">— Select doctor</option>
                {doctorList.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
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
                {withCurrent(MODE_OPTIONS, form.appointment_type).map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
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
            File No is fixed: moving this booking to another patient is a reassignment, not an edit.
            <br />
            <Smartphone size={13} aria-hidden="true" /> Changing the date, slot, doctor or visit
            type regenerates the reporting time &amp; WhatsApp message.
          </p>
        </div>

        <div className="modal__foot">
          <button className="btn btn--ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Call history expandable row content ───────────────────────────────────
// The two per-patient actions. They live in the Patient cell normally and move
// into the row's expander in compact mode, where that cell is cut down to the
// name and number — so compact never costs the desk an action.
function RowActions({ row, onBookNext, onRecords, onEditPatient }) {
  return (
    <>
      <button
        className="edit-pt-btn"
        title="Edit this patient's name, number, age, gender and address"
        onClick={() => onEditPatient(row)}
      >
        <Pencil size={12} aria-hidden="true" />
        Edit details
      </button>
      <button
        className="book-next-btn"
        title="Book next appointment for this patient"
        onClick={() => onBookNext(row)}
      >
        <Plus size={12} aria-hidden="true" />
        Book next
      </button>
      {row.patient_id && (
        <button
          className="records-btn"
          title="View all documents, prescriptions, labs and past visits"
          onClick={() => onRecords({ id: row.patient_id, name: row.patient_name })}
        >
          <FolderOpen size={12} aria-hidden="true" />
          All records
        </button>
      )}
    </>
  );
}

function CallHistoryPanel({ row, ccAgents, colSpan, details, actions }) {
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
          {details && (
            <div className="rowdet">
              {details.map((d) => (
                <div className="rowdet__item" key={d.label}>
                  <span className="rowdet__lab">{d.label}</span>
                  <span className="rowdet__val">{d.value}</span>
                </div>
              ))}
              {actions && <div className="rowdet__actions">{actions}</div>}
              <div className="rowdet__hint">
                Shown in the Patient column when Compact rows is off.
              </div>
            </div>
          )}
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
  const initialTab =
    VIEW_TABS.find((t) => t.id === searchParams.get("tab")) ||
    VIEW_TABS.find((t) => t.id === readStoredTab()) ||
    VIEW_TABS[0];
  const [view, setView] = useState(initialTab.id); // by_date | tomorrow | fu3
  const [date, setDate] = useState(
    searchParams.get("date") ||
      (initialTab.offset !== null ? addDaysStr(initialTab.offset) : todayStr()),
  );
  const [showNew, setShowNew] = useState(false);
  const [newPrefill, setNewPrefill] = useState(null);
  const [doctor, setDoctor] = useState(searchParams.get("doctor") || "All");
  const [collectionFilter, setCollectionFilter] = useState(searchParams.get("collection") || "all");
  const [pillFilter, setPillFilter] = useState(searchParams.get("pill") || "");
  const [compact, setCompact] = useState(searchParams.get("rows") === "compact");
  const [fullscreen, setFullscreen] = useState(false);
  // Debounced copy of `search` — drives the date-independent Patient Lookup fetch
  const [debouncedSearch, setDebouncedSearch] = useState(searchParams.get("q") || "");
  const [search, setSearch] = useState(searchParams.get("q") || "");
  const [recordFor, setRecordFor] = useState(null);
  const [editPatientFor, setEditPatientFor] = useState(null);
  const [expanded, setExpanded] = useState(null); // appointment_id of open history row
  const EXPORT_PAGE_SIZE = 100;

  const doctors = useGhmDoctors().data || [];
  const ccAgents = useCcAgents().data || [];

  // ── Switch the day-view tab (also sets the date) ─────────────────────────
  // Only `view` moves here. The URL is written in one place (the sync effect
  // below) — writing `tab` here too raced that effect, which rebuilds the query
  // from the searchParams of the render it was created in and so could replay a
  // snapshot taken before this write and drop `tab` again.
  const switchView = (tab) => {
    setView(tab.id);
    setExpanded(null);
    if (tab.offset !== null) setDate(addDaysStr(tab.offset));
    else setDate(todayStr());
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
        next.set("tab", view);
        put("doctor", doctor, "All");
        put("collection", collectionFilter, "all");
        put("pill", pillFilter, "");
        put("rows", compact ? "compact" : "", "");
        put("q", searchQ, "");
        put("date", date, tabDefaultDate(view));
        return next;
      },
      { replace: true },
    );
  }, [doctor, collectionFilter, pillFilter, compact, searchQ, date, view, setSearchParams]);

  useEffect(() => {
    storeTab(view);
  }, [view]);

  // A stored or linked tab the role cannot open (Reassign is RECEPTION_OPS) would
  // otherwise leave the page on a tab with no visible button.
  useEffect(() => {
    if (visibleTabs.length && !visibleTabs.some((t) => t.id === view)) {
      switchView(visibleTabs[0]);
    }
  }, [view, visibleTabs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtersActive =
    doctor !== "All" ||
    collectionFilter !== "all" ||
    pillFilter !== "" ||
    searchQ !== "" ||
    date !== tabDefaultDate(view);

  const resetFilters = () => {
    setDoctor("All");
    setCollectionFilter("all");
    setPillFilter("");
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
      if (pillFilter) p.set("bucket", pillFilter);
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
    [date, doctor, collectionFilter, pillFilter, view, lookupQ, searchQ],
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
  const blockQuery = usePatientBlockStatus(patientIds);
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
  const blocks = blockQuery.data || {};
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
      // The sheet names the last consultant seen, which lives outside the row —
      // fetched for the exported rows, not just the ones on screen.
      const lastSeen = await fetchLastMo(all.map((r) => r.patient_id)).catch(() => ({}));
      const counts = await exportWatiWorkbook(
        all,
        view === "lookup" ? todayStr() : date,
        label,
        lastSeen,
      );
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

  const bookNext = useCallback((row) => {
    setNewPrefill({
      patient_name: row.patient_name,
      file_no: row.file_no,
      phone: row.phone,
      condition: row.condition,
      address: row.address,
      doctor_name: row.doctor_name,
      alt_phone: row.alt_phone,
      dob: row.disp_dob,
      age: row.disp_age,
      sex: row.disp_sex,
    });
    setShowNew(true);
  }, []);

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
      if (value && !NO_ATTEMPT_STATUSES.includes(value)) {
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
  // The table's columns in render order — the same order as the <thead> cells
  // and the row's <td>s below. Compact mode hides columns by position, and the
  // expander spans them, so both read this list instead of counting by hand.
  const columnKeys = useMemo(
    () =>
      [
        "calling",
        "num",
        showApptDate && "appt_date",
        showVisitStatus && "visit_status",
        "patient",
        "alt_phone",
        "biomarkers",
        "booking_status",
        "visit_type",
        "category",
        "mode",
        "doctor",
        "assigned_mo",
        "last_mo",
        "last_visit",
        "rx_by",
        showShowNoShow && "show_no_show",
        showCallStatus && "call_status",
        showRecovery && "recovery",
        showCalledBy && "called_by",
        showCallDate && "call_date",
        showFollowUpDate && "follow_up",
        "preferred_doctor",
        "preferred_date",
        "preferred_time",
        "home_collection",
        "notes",
      ].filter(Boolean),
    [
      showApptDate,
      showVisitStatus,
      showShowNoShow,
      showCallStatus,
      showRecovery,
      showCalledBy,
      showCallDate,
      showFollowUpDate,
    ],
  );

  const colSpan = columnKeys.length;

  const activeFilters =
    (doctor !== "All" ? 1 : 0) + (collectionFilter !== "all" ? 1 : 0) + (pillFilter ? 1 : 0);

  const typing = view === "lookup" && search.trim() !== debouncedSearch.trim();
  const searching = view === "lookup" && (typing || (listEnabled && loading));
  const busy = ((loading && rows.length > 0) || refreshing) && !searching;
  const coldLoading = (loading && rows.length === 0) || searching;
  const showRows = rows.length > 0 && !searching;

  const canFit = view !== "reassign" && showRows;
  const { ref: pageRef, height: pageHeight, fitted } = useViewportFill(canFit);

  // Full screen drops the header chrome so the list itself gets the whole
  // screen. It asks the browser for real fullscreen too, but the layout does
  // not depend on that being granted — the page covers the viewport either way,
  // and Escape leaves in both cases.
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {});
      setFullscreen(false);
      return;
    }
    setFullscreen(true);
    pageRef.current?.requestFullscreen?.().catch(() => {});
  }, [pageRef]);

  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    if (!fullscreen) return undefined;
    const onKey = (e) => {
      if (e.key !== "Escape" || document.fullscreenElement) return;
      setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  return (
    <div
      className={`ghm ${fitted ? "ghm--fit" : ""} ${fullscreen ? "ghm--full" : ""}`}
      ref={pageRef}
      style={fitted && !fullscreen ? { height: pageHeight } : undefined}
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
            <button
              type="button"
              className={`btn btn--ghost ${compact ? "btn--on" : ""}`}
              aria-pressed={compact}
              onClick={() => setCompact((v) => !v)}
              title={
                compact
                  ? "Back to the roomier row height"
                  : "Smaller text and tighter rows — every column stays, so more patients fit a screen"
              }
            >
              <Rows3 size={14} aria-hidden="true" />
              Compact rows
            </button>
            <button
              type="button"
              className={`btn btn--ghost ${fullscreen ? "btn--on" : ""}`}
              aria-pressed={fullscreen}
              onClick={toggleFullscreen}
              title={
                fullscreen
                  ? "Leave full screen (Esc)"
                  : "Hide the header and tabs so the list fills the screen"
              }
            >
              {fullscreen ? (
                <Minimize2 size={14} aria-hidden="true" />
              ) : (
                <Maximize2 size={14} aria-hidden="true" />
              )}
              {fullscreen ? "Exit full screen" : "Full screen"}
            </button>
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

      {editPatientFor && (
        <EditPatientModal
          row={editPatientFor}
          doctors={doctors}
          onClose={() => setEditPatientFor(null)}
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
          {(showRows || pillFilter) && (
            <Summary
              summary={summary}
              categories={categoryCounts}
              filter={pillFilter}
              onFilter={setPillFilter}
            />
          )}

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
              <table className={`tbl ${compact ? "tbl--compact" : ""}`}>
                <thead>
                  <tr>
                    <th style={{ width: 96 }}>Calling</th>
                    <th style={{ width: 36 }}>#</th>
                    {showApptDate && <th style={{ width: 120 }}>Appointment</th>}
                    {showVisitStatus && <th style={{ width: 120 }}>Visit Status</th>}
                    <th style={{ minWidth: 170 }}>Patient</th>
                    <th style={{ width: 140 }}>Alternate Mobile</th>
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
                    const callLogged = !NO_ATTEMPT_STATUSES.includes(callStat);
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
                                <BlockedBadge block={blocks[row.patient_id]} size="sm" />
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
                              {altList(row.alt_phone).map((alt) => (
                                <a
                                  key={alt}
                                  className="pcell__ph pcell__ph--alt"
                                  href={`tel:${String(alt).replace(/\D/g, "")}`}
                                  title="Call this patient on the alternate number"
                                >
                                  <Phone size={12} aria-hidden="true" />
                                  {fmtPhone(alt)}
                                  <em className="pcell__phtag">Alt</em>
                                </a>
                              ))}
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
                              {!compact && (
                                <RowActions
                                  row={row}
                                  onBookNext={bookNext}
                                  onRecords={setRecordFor}
                                  onEditPatient={setEditPatientFor}
                                />
                              )}
                            </div>
                          </td>

                          {/* Alternate mobile — editable, so old patients can be filled in */}
                          <td>
                            <InlineEdit
                              value={altList(row.alt_phone).join(", ")}
                              onChange={(v) => patch(row.id, "alt_phone", v)}
                              placeholder="Add alt numbers"
                            />
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

                          {/* Called by — auto-fills logged-in user, editable, with dropdown.
                          Locked until the call status says a call happened: a name
                          filled in beside "Not Called Yet" reads as a call nobody made. */}
                          {showCalledBy && (
                            <td>
                              <input
                                list="cc-agents-list"
                                defaultValue={
                                  callLogged
                                    ? row.call_made_by ||
                                      activeCall?.calling_by ||
                                      loggedInName ||
                                      ""
                                    : row.call_made_by || ""
                                }
                                key={`cb-${row.id}-${row.call_made_by}-${activeCall?.calling_by || ""}-${callLogged ? 1 : 0}`}
                                disabled={!callLogged}
                                title={callLogged ? undefined : CALL_LOCK_HINT}
                                onBlur={(e) => {
                                  const v = e.target.value.trim();
                                  if (v !== (row.call_made_by || ""))
                                    patch(row.id, "call_made_by", v);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") e.target.blur();
                                }}
                                placeholder={callLogged ? "CC name" : "Set call status"}
                                className="cc-input"
                              />
                            </td>
                          )}

                          {/* Call date — locked with Called By, for the same reason */}
                          {showCallDate && (
                            <td title={callLogged ? undefined : CALL_LOCK_HINT}>
                              <DatePicker
                                value={row.call_date || ""}
                                onChange={(v) => patch(row.id, "call_date", v)}
                                placeholder="—"
                                disabled={!callLogged}
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
                          <CallHistoryPanel
                            row={row}
                            ccAgents={ccAgents}
                            colSpan={colSpan}
                            details={compact ? compactDetails(row) : null}
                            actions={
                              compact ? (
                                <RowActions
                                  row={row}
                                  onBookNext={bookNext}
                                  onRecords={setRecordFor}
                                  onEditPatient={setEditPatientFor}
                                />
                              ) : null
                            }
                          />
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
