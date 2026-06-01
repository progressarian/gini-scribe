import { useState, useEffect, useCallback, useRef } from "react";
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
    </div>
  );
}

// ─── Main page ─────────────────────────────────────────────────────────────
export default function GHMPage() {
  const [date, setDate] = useState(todayStr());
  const [doctor, setDoctor] = useState("All");
  const [doctors, setDoctors] = useState([]);
  const [ccAgents, setCcAgents] = useState([]);
  const [filter, setFilter] = useState("all"); // all | need_call | came | no_show
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState([]);
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
      setRows(safeArr(res?.data));
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
        </div>
      </div>

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
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 115 }}>Time Slot</th>
                <th style={{ minWidth: 170 }}>Patient</th>
                <th style={{ width: 100 }}>Visit Type</th>
                <th style={{ width: 140 }}>Doctor</th>
                <th style={{ width: 150 }}>Show / No Show</th>
                <th style={{ width: 170 }}>Call Status</th>
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

                return (
                  <tr
                    key={row.id}
                    className={[
                      "tbl__row",
                      showStat === "Show" ? "tbl__row--came" : "",
                      showStat === "No Show" ? "tbl__row--noshow" : "",
                      callStat === "not_picked" ? "tbl__row--notpicked" : "",
                      isSaving ? "tbl__row--saving" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
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
                      </div>
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

                    {/* Doctor */}
                    <td>
                      <span className="fs12 muted">{row.doctor_name || "—"}</span>
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
                      <ColorSelect
                        value={callStat}
                        options={CALL_STATUSES}
                        onChange={(v) => handleCallStatus(row, v)}
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
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
