import { Fragment, useEffect, useMemo, useState } from "react";
import api from "../services/api.js";

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

export default function AppPatientsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(null); // genie_id of the open row
  const [logsById, setLogsById] = useState({}); // genie_id -> logs payload

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

  useEffect(() => {
    let alive = true;
    api
      .get("/api/app-patients/non-gini")
      .then((res) => {
        if (alive) setRows(res.data?.data || []);
      })
      .catch((e) => {
        if (alive) setError(e?.response?.data?.error || e.message || "Failed to load");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name?.toLowerCase().includes(q) || r.phone?.includes(q));
  }, [rows, search]);

  return (
    <div style={{ padding: 20, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#0f172a", margin: 0 }}>
            📱 App-only Patients
          </h1>
          <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0 0" }}>
            Registered on the MyHealth Genie app but not (yet) Gini Hospital patients —{" "}
            {loading ? "…" : `${rows.length} total`}
          </p>
        </div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="🔍 Search name, phone, file no…"
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1.5px solid #e2e8f0",
            fontSize: 13,
            minWidth: 240,
            outline: "none",
          }}
        />
      </div>

      {loading && <div style={{ color: "#64748b", fontSize: 14, padding: 30 }}>Loading…</div>}
      {!!error && !loading && (
        <div style={{ color: "#dc2626", fontSize: 14, padding: 20 }}>⚠️ {error}</div>
      )}
      {!loading && !error && visible.length === 0 && (
        <div style={{ color: "#64748b", fontSize: 14, padding: 30, textAlign: "center" }}>
          {rows.length === 0 ? "No app-only patients yet." : "No patients match this search."}
        </div>
      )}

      {!loading && !error && visible.length > 0 && (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 14,
            overflow: "auto",
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
              {visible.map((r, i) => (
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
                    <td style={{ ...cellStyle, color: "#94a3b8" }}>{i + 1}</td>
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
    </div>
  );
}
