import { useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { History, Phone } from "lucide-react";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import useAuthStore from "../../stores/authStore";
import { letterHref } from "../../queries/hooks/useGiniflowReferrals";
import { ATTEMPT_OUTCOMES, CALL_STATUSES, callColor } from "../../../shared/callStatuses.js";
import {
  ACTIVE_STATUSES,
  AVAILABILITY_LABEL,
  FOLLOWUP_STATUSES,
  FOLLOWUP_STATUS_LABEL,
  SOURCE_LABEL,
  UNREACHABLE_AFTER,
} from "../../../shared/careFollowups.js";
import { SPECIALTIES } from "../../../shared/specialties.js";
import useDebounced from "../../hooks/useDebounced";
import Dropdown from "../../components/ui/Dropdown.jsx";
import DatePicker from "../../components/DatePicker.jsx";
import { toast } from "../../stores/uiStore";
import Pagination from "../../components/ui/Pagination";
import { requestErrorOf } from "../../components/billing/format";
import {
  useCareFollowup,
  useCareFollowups,
  useCollectFollowupDay,
  useLogFollowupCall,
  useMarkFollowupBooked,
  useRefreshFollowups,
} from "../../queries/hooks/useCareFollowups";
import { useGhmDoctors } from "../../queries/hooks/useGhm";
import { NewAppointmentModal } from "../GHMPage";
import { OutcomeDialog, ReopenDialog } from "./FollowupDialogs";
import "../../styles/flow.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "../GHMPage.css";
import "./careFollowups.css";

const EMPTY_FILTERS = {
  status: "open",
  kind: "",
  availability: "",
  specialty: "",
  day: "",
  q: "",
  page: 1,
};

const CALL_LABEL = Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o.value, o.label]));

const NOT_FOR_REFERRALS = ["rescheduled", "cancelled", "no_call_needed"];
const CALL_OPTIONS = CALL_STATUSES.filter((s) => !NOT_FOR_REFERRALS.includes(s.value));

const callHref = (phone) => `tel:${String(phone).replace(/\D/g, "")}`;

const phoneText = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : phone;
};

const dayText = (day) =>
  day
    ? new Date(`${String(day).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
      })
    : "—";

const todayIso = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

const shiftDay = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const personKey = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\bdr\b\.?/g, "")
    .replace(/[^a-z]/g, "");

function bookingPrefill(item, doctors) {
  const wanted = personKey(item.suggestedDoctor || item.matchedDoctor?.fullName);
  const doctor = (wanted && doctors.find((d) => personKey(d) === wanted)) || "";
  const due = item.dueOn && item.dueOn > todayIso() ? item.dueOn : todayIso();
  return {
    patient_name: item.patient.name,
    file_no: item.patient.fileNo || "",
    phone: item.patient.phone || "",
    age: item.patient.age,
    sex: item.patient.sex,
    doctor_name: doctor,
    preferred_date: due,
    visit_type: "Follow Up",
    notes: [`Follow-up: ${item.target}`, item.detail].filter(Boolean).join(" · ").slice(0, 400),
  };
}

const deskSearchHref = (item) =>
  `/giniflow/station/referrals?q=${encodeURIComponent(item.patient.fileNo || item.patient.name)}`;

function DeskChip({ desk }) {
  return (
    <div className="cfu-desk">
      ↗ Referrals desk · {desk.statusLabel}
      {desk.letterSentAt ? " · letter sent" : desk.hasLetter ? " · letter ready" : ""}
    </div>
  );
}

function DeskCard({ item }) {
  const doctor = useAuthStore((s) => s.currentDoctor);
  const { desk } = item;
  const canOpen = hasCapability(doctor, CAPABILITIES.GINIFLOW_REFERRALS);
  return (
    <section className="cfu-card" aria-label="Referrals desk">
      <h3 className="cfu-drawer__sub">Referrals desk</h3>
      <dl className="cfu-facts">
        <Fact label="Desk status">{desk.statusLabel}</Fact>
        <Fact label="Urgency">{desk.urgencyLabel}</Fact>
        {desk.hospital ? <Fact label="Hospital">{desk.hospital}</Fact> : null}
        <Fact label="Letter">
          {desk.letterSentAt
            ? `Sent to ${desk.sentTo || "patient"} · ${whenText(desk.letterSentAt)}`
            : desk.hasLetter
              ? "Generated, not sent"
              : "Not generated yet"}
        </Fact>
        {desk.appointmentDate ? (
          <Fact label="Appointment">
            {dayText(desk.appointmentDate)}
            {desk.appointmentNote ? ` · ${desk.appointmentNote}` : ""}
          </Fact>
        ) : null}
      </dl>
      {canOpen ? (
        <div className="cfu-actions">
          <a
            className="flow-btn flow-btn-ghost flow-btn-mini"
            href={letterHref(desk.referralId)}
            target="_blank"
            rel="noreferrer"
          >
            📄 Open letter
          </a>
          <a className="flow-btn flow-btn-ghost flow-btn-mini" href={deskSearchHref(item)}>
            ↗ Open on Referrals desk
          </a>
        </div>
      ) : null}
    </section>
  );
}

function StatusCell({ item }) {
  return (
    <>
      <span className={`bill-status cfu-status cfu-status--${item.status}`}>
        {FOLLOWUP_STATUS_LABEL[item.status]}
      </span>
      {item.booked ? (
        <div className="dreq__muted">
          {item.booked.doctor} · {dayText(item.booked.day)}
          {item.booked.slot ? ` ${item.booked.slot}` : ""}
        </div>
      ) : null}
      {item.outcomeReason ? <div className="dreq__muted">{item.outcomeReason}</div> : null}
    </>
  );
}

function CallStatusCell({ item, onLog, busy }) {
  const active = ACTIVE_STATUSES.includes(item.status);
  const current = item.lastCall?.status || "pending";
  const unreachable =
    active && item.attempts >= UNREACHABLE_AFTER && item.lastCall?.status !== "called";
  return (
    <div className="callstat-cell">
      <Dropdown
        value={current}
        options={CALL_OPTIONS}
        onChange={(value) => value !== "pending" && onLog(item, value)}
        variant="color"
        disabled={!active || busy}
        title={active ? undefined : "Closed — reopen it to log a call"}
        ariaLabel={`Call status for ${item.patient.name}`}
      />
      {item.attempts > 0 && (
        <span className="cfu-calls">
          <Phone size={11} aria-hidden="true" />
          {item.attempts} {item.attempts === 1 ? "call" : "calls"}
          {item.lastCall?.at ? ` · last ${dayText(item.lastCall.at)}` : ""}
        </span>
      )}
      {unreachable && <span className="cfu-overdue">{item.attempts} tries — no answer</span>}
    </div>
  );
}

const whenText = (at) =>
  new Date(at).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

function HistoryEntry({ entry }) {
  const isCall = entry.kind === "call";
  const title = isCall
    ? "Call"
    : entry.kind === "auto"
      ? "Updated automatically"
      : entry.kind === "desk"
        ? "Referrals desk"
        : entry.kind === "booked"
          ? "Booked"
          : "Status changed";
  return (
    <li className={`cfu-tl__item cfu-tl__item--${entry.kind}`}>
      <span className="cfu-tl__dot" aria-hidden="true" />
      <div className="cfu-tl__head">
        <strong>{title}</strong>
        <span className="cfu-tl__when">{whenText(entry.at)}</span>
      </div>
      <div className="cfu-tl__body">
        {isCall ? (
          <span className={`csel csel--${callColor(entry.callStatus)} cfu-tl__chip`}>
            {CALL_LABEL[entry.callStatus] || entry.callStatus}
          </span>
        ) : (
          <span>
            {entry.from ? `${FOLLOWUP_STATUS_LABEL[entry.from] || entry.from} → ` : ""}
            <strong>{FOLLOWUP_STATUS_LABEL[entry.to] || entry.to}</strong>
          </span>
        )}
        <span className="cfu-tl__by">by {entry.actor || "—"}</span>
      </div>
      {entry.note ? <p className="cfu-tl__note">{entry.note}</p> : null}
    </li>
  );
}

function Fact({ label, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function Drawer({ id, onClose }) {
  const { data, isLoading, error } = useCareFollowup(id);
  const titleId = useId();
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const pt = data?.patient;
  return (
    <div className="cfu-drawer-back" onClick={onClose} role="presentation">
      <aside
        className="cfu-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cfu-drawer__head">
          <div>
            <p className="cfu-drawer__eyebrow">Follow-up history</p>
            <h2 id={titleId} className="cfu-drawer__name">
              {pt ? pt.name : "Follow-up"}
            </h2>
          </div>
          <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onClose}>
            Close
          </button>
        </div>
        {isLoading && <p className="dreq__muted">Loading…</p>}
        {error && <p className="bill-dialog__error">{requestErrorOf(error, "Could not load")}</p>}
        {data && (
          <>
            <section className="cfu-card" aria-label="Patient details">
              <h3 className="cfu-drawer__sub">Patient</h3>
              <div className="cfu-card__ids">
                <span className="pcell__file">{pt.fileNo || "no file no"}</span>
                {pt.age || pt.sex ? (
                  <span className="pcell__ageSex">
                    {[pt.sex, pt.age ? `${pt.age} yrs` : null].filter(Boolean).join(" · ")}
                  </span>
                ) : null}
              </div>
              <div className="cfu-card__phones">
                {pt.phone ? (
                  <a className="pcell__ph" href={callHref(pt.phone)} title={`Call ${pt.name}`}>
                    <Phone size={12} aria-hidden="true" />
                    {phoneText(pt.phone)}
                  </a>
                ) : (
                  <span className="pcell__ph pcell__ph--none">
                    <Phone size={12} aria-hidden="true" />
                    No phone number
                  </span>
                )}
                {pt.emergencyPhone ? (
                  <a
                    className="pcell__ph pcell__ph--alt"
                    href={callHref(pt.emergencyPhone)}
                    title="Call the emergency contact"
                  >
                    <Phone size={12} aria-hidden="true" />
                    {phoneText(pt.emergencyPhone)}
                    <em className="pcell__phtag">{pt.emergencyContact || "Emergency"}</em>
                  </a>
                ) : null}
              </div>
              <dl className="cfu-facts">
                {pt.address ? <Fact label="Address">{pt.address}</Fact> : null}
                <Fact label="Last visit">
                  {pt.lastVisit
                    ? `${dayText(pt.lastVisit.day)} · ${pt.lastVisit.doctor || "—"}`
                    : "None recorded"}
                </Fact>
                <Fact label="Next booked">
                  {pt.nextVisit
                    ? `${dayText(pt.nextVisit.day)}${pt.nextVisit.slot ? ` ${pt.nextVisit.slot}` : ""} · ${pt.nextVisit.doctor || "—"}`
                    : "Nothing booked"}
                </Fact>
              </dl>
            </section>

            <section className="cfu-card" aria-label="Referral">
              <h3 className="cfu-drawer__sub">Referral</h3>
              <div className="cfu-what">{data.target}</div>
              <span className={`cfu-avail cfu-avail--${data.availability}`}>
                {AVAILABILITY_LABEL[data.availability]}
              </span>
              {data.detail ? <p className="cfu-note">“{data.detail}”</p> : null}
              <dl className="cfu-facts">
                <Fact label="Referred by">
                  {data.orderedBy || "—"} · {dayText(data.orderedOn)}
                </Fact>
                <Fact label="Source">{SOURCE_LABEL[data.source]}</Fact>
                <Fact label="Calls">
                  {data.attempts
                    ? `${data.attempts} · last ${CALL_LABEL[data.lastCall?.status] || "—"}`
                    : "Not called yet"}
                </Fact>
                <Fact label="Status">
                  <StatusCell item={data} />
                </Fact>
              </dl>
            </section>

            {data.desk ? <DeskCard item={data} /> : null}

            {data.otherOpen.length > 0 && (
              <section className="cfu-card" aria-label="Other open follow-ups">
                <h3 className="cfu-drawer__sub">Also open for this patient</h3>
                <ul className="cfu-other">
                  {data.otherOpen.map((o) => (
                    <li key={o.id}>
                      <strong>{o.target}</strong>
                      <span className={`bill-status cfu-status cfu-status--${o.status}`}>
                        {FOLLOWUP_STATUS_LABEL[o.status]}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section aria-label="History">
              <h3 className="cfu-drawer__sub">History</h3>
              {data.history.length === 0 ? (
                <p className="dreq__muted">No calls or changes yet.</p>
              ) : (
                <ol className="cfu-tl">
                  {data.history.map((h, i) => (
                    <HistoryEntry key={`${h.at}-${i}`} entry={h} />
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  );
}

export default function CareFollowupsPage() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 300);
  const [dialog, setDialog] = useState(null);
  const [bookingFor, setBookingFor] = useState(null);
  const [params, setParams] = useSearchParams();
  const [drawer, setDrawerState] = useState(() => params.get("item") || null);
  const setDrawer = (id) => {
    setDrawerState(id);
    if (!id && params.has("item")) {
      const next = new URLSearchParams(params);
      next.delete("item");
      setParams(next, { replace: true });
    }
  };
  const { day, ...listFilters } = filters;
  const list = useCareFollowups({
    ...listFilters,
    from: day,
    to: day,
    q: q.length >= 2 ? q : "",
  });
  const collectDay = useCollectFollowupDay();
  const fetchedDays = useRef(new Set());
  const since = list.data?.since;
  useEffect(() => {
    if (!day || !since || day >= since || fetchedDays.current.has(day)) return;
    fetchedDays.current.add(day);
    collectDay.mutate(day, {
      onError: (e) => {
        fetchedDays.current.delete(day);
        toast(requestErrorOf(e, "Could not fetch referrals for that day"), "error");
      },
    });
  }, [day, since, collectDay]);
  const fetchingDay = collectDay.isPending && collectDay.variables === day;
  const refresh = useRefreshFollowups();
  const markBooked = useMarkFollowupBooked();
  const saveCall = useLogFollowupCall();
  const [callSaving, setCallSaving] = useState(null);
  const doctors = useGhmDoctors().data || [];
  const ids = {
    status: useId(),
    kind: useId(),
    availability: useId(),
    specialty: useId(),
    day: useId(),
  };

  useEffect(() => {
    setFilters((f) => (f.page === 1 ? f : { ...f, page: 1 }));
  }, [q]);

  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value, page: 1 }));
  const filtered =
    search.trim() !== "" ||
    Object.entries(EMPTY_FILTERS).some(([k, v]) => k !== "page" && filters[k] !== v);
  const counts = list.data?.counts || {};
  const rows = list.data?.rows || [];

  const done = (message) => {
    setDialog(null);
    toast(message, "success");
  };

  const runRefresh = async () => {
    try {
      const r = await refresh.mutateAsync();
      const added = Object.values(r.sources || {}).reduce((n, s) => n + (s.added || 0), 0);
      toast(
        r.alreadyRunning
          ? "Already refreshing — the list will update when it finishes"
          : `Refreshed — ${added} new, ${r.moved || 0} updated`,
        "success",
      );
    } catch (e) {
      toast(requestErrorOf(e, "Could not refresh"), "error");
    }
  };

  const onBooked = async (item, booked) => {
    setBookingFor(null);
    if (!booked?.id) {
      toast("Booked, but the follow-up could not be linked — mark it from the list", "error");
      return;
    }
    try {
      await markBooked.mutateAsync({ id: item.id, appointment_id: booked.id });
      toast(`${item.patient.name}: booked for ${dayText(booked.appointment_date)}`, "success");
    } catch (e) {
      toast(requestErrorOf(e, "Booked, but the follow-up could not be linked"), "error");
    }
  };

  const logCall = async (item, callStatus) => {
    setCallSaving(item.id);
    try {
      await saveCall.mutateAsync({ id: item.id, call_status: callStatus, note: null });
      toast(`${item.patient.name}: ${CALL_LABEL[callStatus] || callStatus}`, "success");
    } catch (e) {
      toast(requestErrorOf(e, "Could not save the call"), "error");
    } finally {
      setCallSaving(null);
    }
  };

  return (
    <main className="flow-root fset bill-ui cfu">
      <header className="cfu__head">
        <div>
          <h1 className="cfu__title">Follow-ups</h1>
          <p className="cfu__sub">
            Patients a consultant, MO or the Chief referred to another doctor or department. Call,
            book here, or record why not.
          </p>
        </div>
        <button
          type="button"
          className="flow-btn flow-btn-ghost"
          onClick={runRefresh}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Refreshing…" : "Refresh now"}
        </button>
      </header>

      <div className="flow-card bill-stack">
        <div className="cfu__filters">
          <div className="fset__field cfu__search">
            <label htmlFor="cfu-search">Search</label>
            <input
              id="cfu-search"
              type="search"
              className="jb-assign"
              placeholder="Search by patient name, file no, phone or what was asked"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="fset__field">
            <label htmlFor={ids.status}>Status</label>
            <select
              id={ids.status}
              className="jb-assign"
              value={filters.status}
              onChange={(e) => set("status", e.target.value)}
            >
              {FOLLOWUP_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label} ({counts[s.value] || 0})
                </option>
              ))}
              <option value="all">All</option>
            </select>
          </div>
          <div className="fset__field">
            <label htmlFor={ids.kind}>Type</label>
            <select
              id={ids.kind}
              className="jb-assign"
              value={filters.kind}
              onChange={(e) => set("kind", e.target.value)}
            >
              <option value="">All</option>
              <option value="consultant">Consultant / MO / Chief</option>
              <option value="specialty">Department / specialty</option>
            </select>
          </div>
          <div className="fset__field">
            <label htmlFor={ids.availability}>At GHM</label>
            <select
              id={ids.availability}
              className="jb-assign"
              value={filters.availability}
              onChange={(e) => set("availability", e.target.value)}
            >
              <option value="">All</option>
              {Object.entries(AVAILABILITY_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="fset__field">
            <label htmlFor={ids.specialty}>Specialty</label>
            <select
              id={ids.specialty}
              className="jb-assign"
              value={filters.specialty}
              onChange={(e) => set("specialty", e.target.value)}
            >
              <option value="">All</option>
              {SPECIALTIES.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fset__field">
            <span id={ids.day}>Referred on</span>
            <div className="cfu-day" role="group" aria-labelledby={ids.day}>
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                aria-label="Previous day"
                onClick={() => set("day", shiftDay(day || todayIso(), -1))}
              >
                ◀
              </button>
              <DatePicker
                value={day}
                onChange={(v) => set("day", v || "")}
                maxDate={todayIso()}
                placeholder="All dates"
              />
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                aria-label="Next day"
                disabled={!day || day >= todayIso()}
                onClick={() => set("day", shiftDay(day, 1))}
              >
                ▶
              </button>
              {day !== todayIso() && (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  onClick={() => set("day", todayIso())}
                >
                  Today
                </button>
              )}
              {day && (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  onClick={() => set("day", "")}
                >
                  All dates
                </button>
              )}
            </div>
          </div>
          {filtered && (
            <button
              type="button"
              className="flow-btn flow-btn-ghost cfu__clear"
              onClick={() => {
                setFilters(EMPTY_FILTERS);
                setSearch("");
              }}
            >
              Clear filters
            </button>
          )}
        </div>

        {list.isLoading && (
          <div className="cfu__skeleton" aria-busy="true" aria-label="Loading follow-ups">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="cfu__skeleton-row" />
            ))}
          </div>
        )}
        {list.error && (
          <div className="cxl-empty" role="alert">
            <strong>Unable to load follow-ups.</strong>
            <span>Please try again. If it keeps failing, tell an administrator.</span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => list.refetch()}
            >
              Try again
            </button>
          </div>
        )}
        {fetchingDay && (
          <p className="cfu__fetching" role="status">
            Fetching referrals for {dayText(day)}…
          </p>
        )}
        {!list.isLoading && !list.error && !fetchingDay && rows.length === 0 && (
          <div className="cxl-empty">
            <strong>No follow-ups found</strong>
            <span>
              {day && !search.trim() && filters.status === EMPTY_FILTERS.status
                ? `No open referrals made on ${dayText(day)}.`
                : filtered
                  ? "No follow-ups match the current filters."
                  : "Nothing is waiting. New referrals appear here within 15 minutes."}
            </span>
            {filtered && (
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setSearch("");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <div className="tbl-wrap cfu-sheet">
            <table className="tbl" aria-label="Follow-ups">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>#</th>
                  <th className="tl" style={{ minWidth: 200 }}>
                    Patient
                  </th>
                  <th className="tl" style={{ minWidth: 240 }}>
                    Referred to
                  </th>
                  <th className="tl" style={{ minWidth: 150 }}>
                    Referred by
                  </th>
                  <th style={{ minWidth: 170 }}>Call status</th>
                  <th className="tl" style={{ minWidth: 150 }}>
                    Status
                  </th>
                  <th style={{ minWidth: 220 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item, i) => {
                  const active = ACTIVE_STATUSES.includes(item.status);
                  const rowClass = [
                    "tbl__row",
                    item.status === "booked" || item.status === "done" ? "tbl__row--came" : "",
                    active && item.lastCall?.status === "not_picked" ? "tbl__row--notpicked" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <tr key={item.id} className={rowClass}>
                      <td className="tc">
                        <span className="rnum">{(filters.page - 1) * 50 + i + 1}</span>
                      </td>
                      <td>
                        <div className="pcell">
                          <span className="pcell__name">{item.patient.name}</span>
                          {item.patient.phone ? (
                            <a
                              className="pcell__ph"
                              href={callHref(item.patient.phone)}
                              title={`Call ${item.patient.name}`}
                            >
                              <Phone size={12} aria-hidden="true" />
                              {phoneText(item.patient.phone)}
                            </a>
                          ) : (
                            <span className="pcell__ph pcell__ph--none">
                              <Phone size={12} aria-hidden="true" />
                              No phone number
                            </span>
                          )}
                          <span className="pcell__file">
                            {item.patient.fileNo || "no file no"}
                            {item.patient.age
                              ? ` · ${item.patient.age}${(item.patient.sex || "")[0] || ""}`
                              : ""}
                          </span>
                        </div>
                      </td>
                      <td className="tl">
                        <div className="cfu-what">{item.target}</div>
                        <span className={`cfu-avail cfu-avail--${item.availability}`}>
                          {AVAILABILITY_LABEL[item.availability]}
                        </span>
                        {item.detail ? <div className="cfu-note">“{item.detail}”</div> : null}
                        {item.desk ? <DeskChip desk={item.desk} /> : null}
                      </td>
                      <td className="tl">
                        {item.orderedBy || "—"}
                        <div className="muted">
                          {dayText(item.orderedOn)} · {SOURCE_LABEL[item.source]}
                        </div>
                      </td>
                      <td>
                        <CallStatusCell item={item} onLog={logCall} busy={callSaving === item.id} />
                      </td>
                      <td className="tl">
                        <StatusCell item={item} />
                      </td>
                      <td>
                        <div className="cfu-actions">
                          {item.status === "open" && (
                            <button
                              type="button"
                              className="flow-btn flow-btn-primary flow-btn-mini"
                              aria-label={`Book ${item.target} for ${item.patient.name}`}
                              onClick={() => setBookingFor(item)}
                            >
                              Book appointment
                            </button>
                          )}
                          {active ? (
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost flow-btn-mini"
                              aria-label={`Close the follow-up for ${item.patient.name}`}
                              onClick={() => setDialog({ type: "outcome", item })}
                            >
                              Close…
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost flow-btn-mini"
                              aria-label={`Reopen the follow-up for ${item.patient.name}`}
                              onClick={() => setDialog({ type: "reopen", item })}
                            >
                              Reopen…
                            </button>
                          )}
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost flow-btn-mini"
                            aria-label={`History for ${item.patient.name}`}
                            onClick={() => setDrawer(item.id)}
                          >
                            <History size={13} aria-hidden="true" /> History
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <Pagination
          page={filters.page}
          pageSize={list.data?.pageSize || 50}
          total={list.data?.total || 0}
          onChange={(page) => setFilters((f) => ({ ...f, page }))}
          disabled={list.isFetching}
          unit="follow-ups"
        />
      </div>

      {dialog?.type === "outcome" && (
        <OutcomeDialog
          item={dialog.item}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.type === "reopen" && (
        <ReopenDialog item={dialog.item} onClose={() => setDialog(null)} onDone={done} />
      )}
      {drawer && <Drawer id={drawer} onClose={() => setDrawer(null)} />}
      {bookingFor && (
        <NewAppointmentModal
          doctors={doctors}
          defaultDate={todayIso()}
          prefill={bookingPrefill(bookingFor, doctors)}
          onClose={() => setBookingFor(null)}
          onCreated={(_, booked) => onBooked(bookingFor, booked)}
        />
      )}
    </main>
  );
}
