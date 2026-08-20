import { Fragment, useEffect, useMemo, useState } from "react";
import api from "../services/api.js";
import Dropdown from "../components/ui/Dropdown.jsx";
import FilterPopover from "../components/ui/FilterPopover.jsx";
import SearchBox from "../components/ui/SearchBox.jsx";

// Admin list of mobile-app users who are NOT real Gini hospital patients —
// fresh self-signups (no scribe link) and app-created GNI- shells. Served by
// GET /api/app-patients/non-gini (doctor-only).

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "—";
const fmtDateTime = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : "—";

const cellStyle = { padding: "10px 12px", fontSize: 13, color: "#0f172a", verticalAlign: "top" };

// counts → compact chips, only the non-zero ones.
const COUNT_LABELS = [
  ["chats", "💬 chats"],
  ["meals", "🍽️ meals"],
  ["activity", "🚶 activity"],
  ["symptoms", "🤒 symptoms"],
  ["med_logs", "💊 med logs"],
  ["vitals", "❤️ vitals"],
  ["labs", "🧪 labs"],
  ["medications", "℞ meds"],
  ["conditions", "🩺 conditions"],
  ["documents", "📄 reports"],
];

// ── Expanded-row log rendering ──────────────────────────────────────────────
// The genie tables have varied schemas; pick the most informative fields with
// graceful fallbacks so every row renders something readable.
const rowDate = (r) => r.created_at || r.log_date || r.recorded_at || r.logged_at || r.date || null;
const rowTitle = (r) =>
  r.description ||
  r.test_name ||
  r.name ||
  r.activity_type ||
  r.title ||
  r.file_name ||
  (r.content ? String(r.content).slice(0, 90) : null) ||
  r.meal_type ||
  "—";
const rowMeta = (r) =>
  [
    r.role,
    r.value !== undefined && r.value !== null ? `value ${r.value}` : null,
    r.unit,
    r.calories != null ? `${r.calories} kcal` : null,
    r.severity != null ? `severity ${r.severity}` : null,
    r.status,
    r.dose || r.dosage,
    r.meal_type,
  ]
    .filter(Boolean)
    .join(" · ");

// Chevron panel sections — chats intentionally excluded (count-only chip on
// the list row; conversations are read via the Genie Chats page).
const SECTION_TITLES = {
  meals: "🍽️ Meal logs",
  activity: "🚶 Activity logs",
  symptoms: "🤒 Symptom logs",
  med_logs: "💊 Medication logs",
  vitals: "❤️ Vitals",
  labs: "🧪 Lab results",
  medications: "℞ Medications",
  conditions: "🩺 Conditions",
  documents: "📄 Reports / documents",
};

function LogsPanel({ logs }) {
  if (!logs) return <div style={{ color: "#64748b", fontSize: 13, padding: 8 }}>Loading…</div>;
  const sections = Object.entries(SECTION_TITLES).filter(([k]) => (logs[k] || []).length > 0);
  if (sections.length === 0) {
    return <div style={{ color: "#94a3b8", fontSize: 13, padding: 8 }}>No data logged yet.</div>;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
        gap: 14,
        padding: 6,
      }}
    >
      {sections.map(([key, title]) => (
        <div
          key={key}
          style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 10, padding: 10 }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: "#334155", marginBottom: 6 }}>
            {title}{" "}
            <span style={{ color: "#94a3b8", fontWeight: 500 }}>
              ({logs[key].length}
              {logs[key].length === 30 ? "+" : ""})
            </span>
          </div>
          {logs[key].slice(0, 10).map((r, i) => (
            <div
              key={r.id || i}
              style={{
                fontSize: 12,
                color: "#0f172a",
                padding: "3px 0",
                borderTop: i ? "1px solid #f8fafc" : "none",
              }}
            >
              <span style={{ fontWeight: 500 }}>{rowTitle(r)}</span>
              {rowMeta(r) ? <span style={{ color: "#64748b" }}> — {rowMeta(r)}</span> : null}
              {rowDate(r) ? (
                <span style={{ color: "#94a3b8", fontSize: 11 }}>
                  {"  "}
                  {new Date(rowDate(r)).toLocaleString("en-IN", {
                    day: "2-digit",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              ) : null}
            </div>
          ))}
          {logs[key].length > 10 && (
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
              … and {logs[key].length - 10} more
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DataChips({ counts }) {
  const chips = COUNT_LABELS.filter(([k]) => (counts?.[k] || 0) > 0);
  if (chips.length === 0) {
    return <span style={{ color: "#94a3b8", fontSize: 12 }}>No data yet</span>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 320 }}>
      {chips.map(([k, label]) => (
        <span
          key={k}
          style={{
            background: "#f1f5f9",
            borderRadius: 8,
            padding: "2px 7px",
            fontSize: 11,
            color: "#334155",
            whiteSpace: "nowrap",
          }}
        >
          {counts[k]} {label}
        </span>
      ))}
    </div>
  );
}
const headStyle = {
  padding: "10px 12px",
  fontSize: 11,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  textAlign: "left",
  borderBottom: "2px solid #e2e8f0",
  whiteSpace: "nowrap",
};

const PAGE_SIZE = 25;

const PROFILE_OPTIONS = [
  { value: "all", label: "All profiles" },
  { value: "complete", label: "✓ Complete only" },
  { value: "incomplete", label: "Incomplete only" },
];

const SORT_OPTIONS = [
  { value: "created_at", label: "Registered" },
  { value: "name", label: "Name" },
  { value: "dob", label: "Date of birth" },
  { value: "phone", label: "Phone" },
  { value: "profile_complete", label: "Profile status" },
];

const DIR_OPTIONS = [
  { value: "desc", label: "↓ Newest / Z–A" },
  { value: "asc", label: "↑ Oldest / A–Z" },
];

const ctrlStyle = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1.5px solid #e2e8f0",
  fontSize: 13,
  outline: "none",
  background: "#fff",
};

function AppPatientFilters({
  profile,
  condition,
  conditionOptions,
  sort,
  dir,
  activeCount,
  onApply,
}) {
  const [draft, setDraft] = useState({ profile, condition, sort, dir });

  useEffect(() => {
    setDraft({ profile, condition, sort, dir });
  }, [profile, condition, sort, dir]);

  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  return (
    <FilterPopover
      activeCount={activeCount}
      onApply={() => onApply(draft)}
      onReset={() => setDraft({ profile: "all", condition: "", sort: "created_at", dir: "desc" })}
    >
      <div className="fpop__fld">
        <span>Profile status</span>
        <Dropdown
          value={draft.profile}
          options={PROFILE_OPTIONS}
          onChange={(v) => set("profile", v)}
          ariaLabel="Filter by profile status"
        />
      </div>
      <div className="fpop__fld">
        <span>Condition</span>
        <Dropdown
          value={draft.condition}
          options={conditionOptions}
          onChange={(v) => set("condition", v)}
          ariaLabel="Filter by condition"
        />
      </div>
      <div className="fpop__fld">
        <span>Sort by</span>
        <Dropdown
          value={draft.sort}
          options={SORT_OPTIONS}
          onChange={(v) => set("sort", v)}
          ariaLabel="Sort by"
        />
      </div>
      <div className="fpop__fld">
        <span>Order</span>
        <Dropdown
          value={draft.dir}
          options={DIR_OPTIONS}
          onChange={(v) => set("dir", v)}
          ariaLabel="Sort direction"
        />
      </div>
    </FilterPopover>
  );
}

export default function AppPatientsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [profile, setProfile] = useState("all");
  const [condition, setCondition] = useState("");
  const [conditions, setConditions] = useState([]);
  const [sort, setSort] = useState("created_at");
  const [dir, setDir] = useState("desc");
  const [expanded, setExpanded] = useState(null);
  const [logsById, setLogsById] = useState({});

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let alive = true;
    api
      .get("/api/app-patients/conditions")
      .then((res) => alive && setConditions(res.data?.data || []))
      .catch(() => alive && setConditions([]));
    return () => {
      alive = false;
    };
  }, []);

  // Every filter is a server query, so it spans all patients rather than the
  // page on screen. Changing one resets to page 1 — staying on page 4 of a
  // narrower result set lands on an empty table.
  const query = useMemo(() => {
    const p = new URLSearchParams({ page, limit: PAGE_SIZE, sort, dir });
    if (debouncedSearch.trim()) p.set("q", debouncedSearch.trim());
    if (profile !== "all") p.set("profile", profile);
    if (condition) p.set("condition", condition);
    return p.toString();
  }, [page, sort, dir, debouncedSearch, profile, condition]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, profile, condition, sort, dir]);

  useEffect(() => {
    let alive = true;
    setRefreshing(true);
    api
      .get(`/api/app-patients/non-gini?${query}`)
      .then((res) => {
        if (!alive) return;
        setRows(res.data?.data || []);
        setTotal(res.data?.total || 0);
        setTotalPages(res.data?.totalPages || 1);
        setError("");
      })
      .catch((e) => {
        if (alive) setError(e?.response?.data?.error || e.message || "Failed to load");
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      alive = false;
    };
  }, [query]);

  const toggleExpand = (genieId) => {
    const next = expanded === genieId ? null : genieId;
    setExpanded(next);
    if (next && !logsById[next]) {
      api
        .get(`/api/app-patients/${encodeURIComponent(next)}/logs`)
        .then((res) => setLogsById((m) => ({ ...m, [next]: res.data || {} })))
        .catch(() => setLogsById((m) => ({ ...m, [next]: {} })));
    }
  };

  const conditionOptions = useMemo(
    () => [
      { value: "", label: "All conditions" },
      ...conditions.map((c) => ({ value: c.name, label: `${c.name} (${c.patients})` })),
    ],
    [conditions],
  );

  const filtered = debouncedSearch.trim() || profile !== "all" || condition;
  const activeFilters = (profile !== "all" ? 1 : 0) + (condition ? 1 : 0);
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);

  return (
    <div style={{ padding: 20, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", margin: 0 }}>
            📱 App-only Patients
          </h1>
          <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
            Registered on the MyHealth Genie app but not (yet) Gini Hospital patients —{" "}
            {loading ? "…" : `${total} ${filtered ? "matching" : "total"}`}
            {refreshing && !loading && (
              <span style={{ color: "#2563eb", fontWeight: 600 }}> · updating…</span>
            )}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Search any app patient — name or phone"
            label="Search app patients"
          />
          <AppPatientFilters
            profile={profile}
            condition={condition}
            conditionOptions={conditionOptions}
            sort={sort}
            dir={dir}
            activeCount={activeFilters}
            onApply={(next) => {
              setProfile(next.profile);
              setCondition(next.condition);
              setSort(next.sort);
              setDir(next.dir);
            }}
          />
          {filtered && (
            <button
              type="button"
              onClick={() => {
                setSearch("");
                setProfile("all");
                setCondition("");
              }}
              style={{ ...ctrlStyle, cursor: "pointer", color: "#2563eb", fontWeight: 600 }}
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {loading && <div style={{ color: "#64748b", fontSize: 14, padding: 30 }}>Loading…</div>}
      {!!error && !loading && (
        <div style={{ color: "#dc2626", fontSize: 14, padding: 20 }}>⚠️ {error}</div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div style={{ color: "#64748b", fontSize: 14, padding: 30, textAlign: "center" }}>
          {filtered ? "No patients match these filters." : "No app-only patients yet."}
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 14,
            overflow: "auto",
            opacity: refreshing ? 0.6 : 1,
            transition: "opacity 0.15s",
          }}
        >
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...headStyle, width: 30 }}></th>
                <th style={headStyle}>#</th>
                <th style={headStyle}>Patient</th>
                <th style={headStyle}>Phone</th>
                <th style={headStyle}>Sex · DOB</th>
                <th style={headStyle}>Registered</th>
                <th style={headStyle}>Profile</th>
                <th style={headStyle}>Data</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <Fragment key={r.genie_id}>
                  <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={cellStyle}>
                      <button
                        onClick={() => toggleExpand(r.genie_id)}
                        title="Show this patient's logged data"
                        style={{
                          border: "none",
                          background: "none",
                          cursor: "pointer",
                          fontSize: 13,
                          color: "#64748b",
                          transform: expanded === r.genie_id ? "rotate(90deg)" : "none",
                          transition: "transform 0.15s",
                        }}
                      >
                        ▸
                      </button>
                    </td>
                    <td style={{ ...cellStyle, color: "#94a3b8" }}>{from + i}</td>
                    <td style={{ ...cellStyle, fontWeight: 600 }}>{r.name || "—"}</td>
                    <td style={cellStyle}>{r.phone || "—"}</td>
                    <td style={cellStyle}>
                      {[r.sex, r.dob ? fmtDate(r.dob) : null].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td style={cellStyle}>{fmtDateTime(r.created_at)}</td>
                    <td style={cellStyle}>
                      {r.profile_complete ? (
                        <span style={{ color: "#16a34a", fontWeight: 600 }}>✓ Complete</span>
                      ) : (
                        <span style={{ color: "#d97706", fontWeight: 600 }}>Incomplete</span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      <DataChips counts={r.counts} />
                    </td>
                  </tr>
                  {expanded === r.genie_id && (
                    <tr>
                      <td colSpan={8} style={{ background: "#f8fafc", padding: 10 }}>
                        <LogsPanel logs={logsById[r.genie_id]} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && total > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginTop: 12,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 12, color: "#64748b" }}>
            Showing {from}–{to} of {total}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setPage((n) => Math.max(1, n - 1))}
              disabled={page <= 1 || refreshing}
              style={{
                ...ctrlStyle,
                cursor: page <= 1 ? "not-allowed" : "pointer",
                opacity: page <= 1 ? 0.5 : 1,
              }}
            >
              ‹ Previous
            </button>
            <span style={{ fontSize: 12, color: "#475569", fontWeight: 600 }}>
              Page {page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((n) => Math.min(totalPages, n + 1))}
              disabled={page >= totalPages || refreshing}
              style={{
                ...ctrlStyle,
                cursor: page >= totalPages ? "not-allowed" : "pointer",
                opacity: page >= totalPages ? 0.5 : 1,
              }}
            >
              Next ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
