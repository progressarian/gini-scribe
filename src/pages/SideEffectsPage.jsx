import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import Shimmer from "../components/Shimmer.jsx";

const STATUS_OPTIONS = [
  { value: "all", label: "All", color: "#475569", bg: "#f1f5f9" },
  { value: "active", label: "Active", color: "#b91c1c", bg: "#fee2e2" },
  { value: "resolved", label: "Resolved", color: "#047857", bg: "#d1fae5" },
];

const SEVERITY_OPTIONS = [
  { value: "all", label: "All severities", color: "#475569", bg: "#f1f5f9" },
  { value: "warn", label: "⚠️ Warning", color: "#b91c1c", bg: "#fee2e2" },
  { value: "uncommon", label: "🟠 Uncommon", color: "#9a3412", bg: "#ffedd5" },
  { value: "common", label: "🟡 Common", color: "#92400e", bg: "#fef3c7" },
];

const SEVERITY_CHIP = {
  warn: { label: "⚠️ Warning", color: "#b91c1c", bg: "#fee2e2", border: "#fecaca" },
  uncommon: { label: "🟠 Uncommon", color: "#9a3412", bg: "#ffedd5", border: "#fed7aa" },
  common: { label: "🟡 Common", color: "#92400e", bg: "#fef3c7", border: "#fde68a" },
};

const STATUS_CHIP = {
  active: { label: "Active", color: "#b91c1c", bg: "#fee2e2" },
  resolved: { label: "Resolved", color: "#047857", bg: "#d1fae5" },
};

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "2-digit" });
}

function ResolveButton({ row, onDone }) {
  const queryClient = useQueryClient();
  const isResolved = row.status === "resolved";
  const mutation = useMutation({
    mutationFn: async () => {
      const next = isResolved ? "active" : "resolved";
      const { data } = await api.patch(`/api/side-effects/${row.id}`, { status: next });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["side-effects"] });
      onDone?.();
    },
  });

  const busy = mutation.isPending;
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!busy) mutation.mutate();
      }}
      disabled={busy}
      style={{
        fontSize: 11,
        fontWeight: 700,
        padding: "6px 12px",
        borderRadius: 6,
        border: `1px solid ${isResolved ? "#cbd5e1" : "#10b981"}`,
        background: isResolved ? "#fff" : "#10b981",
        color: isResolved ? "#475569" : "#fff",
        cursor: busy ? "not-allowed" : "pointer",
        opacity: busy ? 0.7 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {busy ? "Saving…" : isResolved ? "Re-open" : "✓ Mark resolved"}
    </button>
  );
}

export default function SideEffectsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState("all");
  const [severity, setSeverity] = useState("all");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());

  const togglePatient = (pid) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const listQuery = useQuery({
    queryKey: ["side-effects", "list", status, severity],
    queryFn: async () => {
      const params = {};
      if (status !== "all") params.status = status;
      if (severity !== "all") params.severity = severity;
      const { data } = await api.get("/api/side-effects", { params });
      return data?.data || [];
    },
    staleTime: 30_000,
  });

  const raw = listQuery.data || [];

  const statsQuery = useQuery({
    queryKey: ["side-effects", "stats"],
    queryFn: async () => {
      const { data } = await api.get("/api/side-effects");
      return data?.data || [];
    },
    staleTime: 30_000,
  });
  const allRows = statsQuery.data || [];
  const stats = useMemo(() => {
    const out = { active: 0, resolved: 0, warn: 0, total: allRows.length };
    for (const r of allRows) {
      if (r.status === "active") out.active++;
      if (r.status === "resolved") out.resolved++;
      if (r.severity === "warn") out.warn++;
    }
    return out;
  }, [allRows]);

  // Filter + group by patient. Sort patients by their most-recent active row
  // (oldest active first, so the longest-waiting patients surface), then
  // patients with only resolved rows (newest first). Mirrors the dose-change
  // sort rule applied at the patient-group level.
  const groups = useMemo(() => {
    let arr = raw;
    if (debounced) {
      arr = arr.filter((r) => {
        const hay = [
          r.patient_name,
          r.name,
          r.medication_name,
          r.patient_phone,
          String(r.patient_id),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(debounced);
      });
    }

    const byPatient = new Map();
    for (const r of arr) {
      const key = String(r.patient_id);
      if (!byPatient.has(key)) {
        byPatient.set(key, {
          patient_id: r.patient_id,
          patient_name: r.patient_name,
          patient_phone: r.patient_phone,
          patient_file_no: r.patient_file_no,
          rows: [],
        });
      }
      byPatient.get(key).rows.push(r);
    }

    const ts = (r) => new Date(r.reported_at || 0).getTime();
    const list = [...byPatient.values()].map((g) => {
      const active = g.rows.filter((r) => r.status === "active").sort((a, b) => ts(a) - ts(b)); // oldest active first
      const resolved = g.rows.filter((r) => r.status === "resolved").sort((a, b) => ts(b) - ts(a)); // newest resolved first
      return {
        ...g,
        rows: [...active, ...resolved],
        activeCount: active.length,
        resolvedCount: resolved.length,
        oldestActiveTs: active[0] ? ts(active[0]) : null,
        newestResolvedTs: resolved[0] ? ts(resolved[0]) : null,
      };
    });

    list.sort((a, b) => {
      // Groups with any active rows come first, ordered by oldest active asc.
      if (a.activeCount && b.activeCount) return a.oldestActiveTs - b.oldestActiveTs;
      if (a.activeCount && !b.activeCount) return -1;
      if (!a.activeCount && b.activeCount) return 1;
      // Both resolved-only: newest resolved first.
      return (b.newestResolvedTs || 0) - (a.newestResolvedTs || 0);
    });

    return list;
  }, [raw, debounced]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["side-effects"] });

  const openReceptionChat = (patientId) => {
    navigate(`/reception-inbox?patient=${patientId}`);
  };

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1180, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a" }}>
            💊 Patient-reported Side Effects
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            Grouped by patient. Mark resolved once the follow-up is done.
          </div>
        </div>
        <button
          onClick={refresh}
          style={{
            background: "#1e293b",
            color: "#fff",
            border: "none",
            padding: "8px 14px",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          ↻ Refresh
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 10,
          marginBottom: 14,
        }}
      >
        {[
          { key: "active", label: "Active", color: "#b91c1c", bg: "#fee2e2", border: "#fecaca" },
          {
            key: "resolved",
            label: "Resolved",
            color: "#047857",
            bg: "#d1fae5",
            border: "#a7f3d0",
          },
          { key: "warn", label: "Warnings", color: "#b91c1c", bg: "#fee2e2", border: "#fecaca" },
          { key: "total", label: "Total", color: "#475569", bg: "#f1f5f9", border: "#e2e8f0" },
        ].map((s) => (
          <div
            key={s.key}
            style={{
              background: s.bg,
              border: `1.5px solid ${s.border}`,
              borderRadius: 10,
              padding: "10px 12px",
            }}
          >
            <div style={{ fontSize: 22, fontWeight: 800, color: s.color, minHeight: 28 }}>
              {statsQuery.isLoading ? "…" : (stats[s.key] ?? 0)}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: s.color, opacity: 0.8 }}>
              {s.label.toUpperCase()}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 14, alignItems: "center" }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by patient name, symptom, medicine, phone"
          style={{
            flex: 1,
            padding: "9px 12px",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            fontSize: 13,
            outline: "none",
          }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {STATUS_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => setStatus(o.value)}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: status === o.value ? `2px solid ${o.color}` : "1px solid #e2e8f0",
              background: status === o.value ? o.bg : "#fff",
              color: status === o.value ? o.color : "#475569",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {SEVERITY_OPTIONS.map((o) => (
          <button
            key={o.value}
            onClick={() => setSeverity(o.value)}
            style={{
              padding: "6px 12px",
              borderRadius: 999,
              border: severity === o.value ? `2px solid ${o.color}` : "1px solid #e2e8f0",
              background: severity === o.value ? o.bg : "#fff",
              color: severity === o.value ? o.color : "#475569",
              fontWeight: 700,
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      {listQuery.isLoading ? (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 16,
          }}
        >
          <Shimmer type="list" count={5} />
        </div>
      ) : groups.length === 0 ? (
        <div
          style={{
            background: "#fff",
            border: "1px solid #e2e8f0",
            borderRadius: 12,
            padding: 40,
            textAlign: "center",
            color: "#64748b",
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 700, color: "#334155" }}>No side effects in this view</div>
        </div>
      ) : (
        groups.map((g) => {
          const isCollapsed = collapsed.has(g.patient_id);
          return (
            <div
              key={g.patient_id}
              style={{
                background: "#fff",
                border: "1px solid #e2e8f0",
                borderRadius: 12,
                marginBottom: 12,
                overflow: "hidden",
              }}
            >
              {/* Patient header — refills-style avatar + meta row + chips */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => togglePatient(g.patient_id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    togglePatient(g.patient_id);
                  }
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 16px",
                  background: "#f8fafc",
                  borderBottom: isCollapsed ? "none" : "1px solid #e2e8f0",
                  gap: 12,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    flex: 1,
                    minWidth: 0,
                  }}
                >
                  <span
                    aria-label={isCollapsed ? "Expand" : "Collapse"}
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 999,
                      background: "#fff",
                      border: "1px solid #e2e8f0",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      color: "#475569",
                      fontSize: 11,
                      fontWeight: 800,
                      lineHeight: 1,
                      transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                      transition: "transform 0.18s",
                    }}
                  >
                    ▾
                  </span>
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 999,
                      background: "linear-gradient(135deg, #1e293b, #475569)",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 800,
                      fontSize: 15,
                      flexShrink: 0,
                    }}
                  >
                    {(g.patient_name || "?").trim().charAt(0).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 15,
                        fontWeight: 800,
                        color: "#0f172a",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {g.patient_name || `Patient #${g.patient_id}`}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#64748b",
                        display: "flex",
                        gap: 10,
                        flexWrap: "wrap",
                        marginTop: 2,
                      }}
                    >
                      <span>ID #{g.patient_id}</span>
                      {g.patient_phone && <span>📱 {g.patient_phone}</span>}
                      {g.patient_file_no && <span>File {g.patient_file_no}</span>}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexShrink: 0, alignItems: "center" }}>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      padding: "3px 8px",
                      borderRadius: 999,
                      background: g.activeCount > 0 ? "#fef3c7" : "#f1f5f9",
                      color: g.activeCount > 0 ? "#92400e" : "#94a3b8",
                    }}
                  >
                    {g.activeCount} CURRENT
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      padding: "3px 8px",
                      borderRadius: 999,
                      background: "#f1f5f9",
                      color: "#475569",
                    }}
                  >
                    {g.resolvedCount} PAST
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openReceptionChat(g.patient_id);
                    }}
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      padding: "5px 10px",
                      borderRadius: 6,
                      border: "1px solid #2563eb",
                      background: "#eff6ff",
                      color: "#1d4ed8",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      marginLeft: 4,
                    }}
                  >
                    💬 Chat
                  </button>
                </div>
              </div>

              {/* Side-effect rows */}
              <div style={{ padding: isCollapsed ? 0 : "12px 16px" }}>
                {!isCollapsed &&
                  g.rows.map((r, idx) => {
                    const sev = SEVERITY_CHIP[r.severity] || SEVERITY_CHIP.common;
                    const st = STATUS_CHIP[r.status] || STATUS_CHIP.active;
                    return (
                      <div
                        key={r.id}
                        style={{
                          padding: idx === 0 ? "0 0 10px 0" : "10px 0",
                          borderTop: idx === 0 ? "none" : "1px dashed #f1f5f9",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "flex-start",
                            gap: 12,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                flexWrap: "wrap",
                                marginBottom: 4,
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 800,
                                  padding: "2px 8px",
                                  borderRadius: 999,
                                  background: st.bg,
                                  color: st.color,
                                  textTransform: "uppercase",
                                  letterSpacing: 0.3,
                                }}
                              >
                                {st.label}
                              </span>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontWeight: 800,
                                  padding: "2px 8px",
                                  borderRadius: 999,
                                  background: sev.bg,
                                  color: sev.color,
                                  border: `1px solid ${sev.border}`,
                                }}
                              >
                                {sev.label}
                              </span>
                              <span style={{ fontSize: 11, color: "#64748b" }}>
                                {fmtTime(r.reported_at)}
                              </span>
                            </div>
                            <div style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>
                              🩺 {r.name}
                              {r.medication_name ? (
                                <span style={{ color: "#475569", fontWeight: 500 }}>
                                  {" "}
                                  · {r.medication_name}
                                </span>
                              ) : null}
                            </div>
                            {r.patient_note && (
                              <div
                                style={{
                                  fontSize: 13,
                                  color: "#0f172a",
                                  background: "#f8fafc",
                                  border: "1px solid #e2e8f0",
                                  borderRadius: 8,
                                  padding: "6px 10px",
                                  marginTop: 6,
                                  lineHeight: 1.4,
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 800,
                                    color: "#64748b",
                                    letterSpacing: 0.4,
                                    marginBottom: 2,
                                  }}
                                >
                                  PATIENT NOTE
                                </div>
                                {r.patient_note}
                              </div>
                            )}
                          </div>
                          <ResolveButton row={r} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          );
        })
      )}

      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, textAlign: "right" }}>
        {groups.length} patient{groups.length === 1 ? "" : "s"} · {raw.length} side effect
        {raw.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}
