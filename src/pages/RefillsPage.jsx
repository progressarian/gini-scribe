import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import Shimmer from "../components/Shimmer.jsx";

const STATUS_OPTIONS = [
  { value: "all", label: "All", color: "#475569", bg: "#f1f5f9" },
  { value: "pending", label: "Pending", color: "#92400e", bg: "#fef3c7" },
  { value: "approved", label: "Approved", color: "#047857", bg: "#d1fae5" },
  { value: "fulfilled", label: "Fulfilled", color: "#1d4ed8", bg: "#dbeafe" },
  { value: "rejected", label: "Rejected", color: "#b91c1c", bg: "#fee2e2" },
];

function statusStyle(s) {
  const opt = STATUS_OPTIONS.find((o) => o.value === s) || STATUS_OPTIONS[0];
  return { color: opt.color, background: opt.bg };
}

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

const PAGE_SIZE = 30;

function buildParams({ status, patientTerm, fromIso, toIso, page, includeStatus }) {
  const p = new URLSearchParams();
  if (includeStatus) p.set("status", status || "all");
  if (patientTerm) p.set("patient", patientTerm);
  if (fromIso) p.set("from", fromIso);
  if (toIso) p.set("to", toIso);
  if (page) p.set("page", String(page));
  p.set("limit", String(PAGE_SIZE));
  return p.toString();
}

export default function RefillsPage() {
  const queryClient = useQueryClient();
  const sentinelRef = useRef(null);

  const [status, setStatus] = useState("all");
  const [patientTerm, setPatientTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [expanded, setExpanded] = useState({});
  const [collapsed, setCollapsed] = useState({});

  // Debounce search to avoid hammering the backend on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTerm(patientTerm.trim()), 300);
    return () => clearTimeout(t);
  }, [patientTerm]);

  const fromIso = from ? new Date(from).toISOString() : "";
  const toIso = to ? new Date(`${to}T23:59:59`).toISOString() : "";

  const filterKey = { status, patient: debouncedTerm, from: fromIso, to: toIso };

  // Stats — independent of the status filter so switching pills doesn't
  // zero out the other counts.
  const statsQuery = useQuery({
    queryKey: ["refills", "stats", debouncedTerm, fromIso, toIso],
    queryFn: async () => {
      const qs = buildParams({
        status,
        patientTerm: debouncedTerm,
        fromIso,
        toIso,
        includeStatus: false,
      });
      const { data } = await api.get(`/api/refill-requests/stats?${qs}`);
      return data || { pending: 0, approved: 0, fulfilled: 0, rejected: 0, total: 0 };
    },
    staleTime: 30_000,
  });

  // Paginated list with infinite scroll.
  const listQuery = useInfiniteQuery({
    queryKey: ["refills", "list", filterKey],
    initialPageParam: 1,
    queryFn: async ({ pageParam = 1 }) => {
      const qs = buildParams({
        status,
        patientTerm: debouncedTerm,
        fromIso,
        toIso,
        page: pageParam,
        includeStatus: true,
      });
      const { data } = await api.get(`/api/refill-requests?${qs}`);
      return data;
    },
    getNextPageParam: (lastPage) => {
      if (!lastPage) return undefined;
      return lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined;
    },
  });

  const requests = useMemo(
    () => (listQuery.data?.pages || []).flatMap((p) => p?.rows || []),
    [listQuery.data],
  );
  const total = listQuery.data?.pages?.[0]?.total ?? 0;

  // IntersectionObserver-driven infinite scroll, mirrors FindPage.jsx.
  const handleObserver = useCallback(
    (entries) => {
      const entry = entries[0];
      if (entry.isIntersecting && listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
        listQuery.fetchNextPage();
      }
    },
    [listQuery],
  );

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(handleObserver, { threshold: 0.1 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleObserver, requests.length]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["refills"] });
  };

  const updateStatus = async (id, newStatus, reject_reason) => {
    try {
      const body = { status: newStatus };
      if (newStatus === "rejected") body.reject_reason = reject_reason || "";
      await api.patch(`/api/refill-requests/${id}`, body);
      refresh();
    } catch {
      /* errors are surfaced via the request not changing — keep silent for now */
    }
  };

  // Group requests by patient for rendering.
  const grouped = useMemo(() => {
    const map = new Map();
    requests.forEach((r) => {
      const key = r.patient_id;
      if (!map.has(key)) {
        map.set(key, {
          patient_id: r.patient_id,
          patient_name: r.patient_name,
          patient_phone: r.patient_phone,
          patient_file_no: r.patient_file_no,
          current: [],
          history: [],
          latestAt: r.requested_at,
          oldestCurrentAt: null,
        });
      }
      const g = map.get(key);
      const isCurrent = r.status === "pending" || r.status === "approved";
      (isCurrent ? g.current : g.history).push(r);
      if (new Date(r.requested_at) > new Date(g.latestAt)) g.latestAt = r.requested_at;
      if (
        isCurrent &&
        (!g.oldestCurrentAt || new Date(r.requested_at) < new Date(g.oldestCurrentAt))
      ) {
        g.oldestCurrentAt = r.requested_at;
      }
    });
    const arr = Array.from(map.values());
    arr.forEach((g) => {
      g.current.sort((a, b) => new Date(a.requested_at) - new Date(b.requested_at));
      g.history.sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));
    });
    arr.sort((a, b) => {
      if (a.oldestCurrentAt && b.oldestCurrentAt) {
        return new Date(a.oldestCurrentAt) - new Date(b.oldestCurrentAt);
      }
      if (a.oldestCurrentAt) return -1;
      if (b.oldestCurrentAt) return 1;
      return new Date(b.latestAt) - new Date(a.latestAt);
    });
    return arr;
  }, [requests]);

  const toggleExpand = (pid) => setExpanded((e) => ({ ...e, [pid]: !e[pid] }));
  const toggleCollapsed = (pid) => setCollapsed((c) => ({ ...c, [pid]: !c[pid] }));

  const stats = statsQuery.data || { pending: 0, approved: 0, fulfilled: 0, rejected: 0 };
  const isInitialLoading = listQuery.isLoading;

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
            💊 Medicine Refill Requests
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            All patient-initiated refill orders from the MyHealth Genie app
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

      {/* Stats strip */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 10,
          marginBottom: 14,
        }}
      >
        {[
          { key: "pending", label: "Pending", color: "#92400e", bg: "#fef3c7", border: "#fde68a" },
          {
            key: "approved",
            label: "Approved",
            color: "#047857",
            bg: "#d1fae5",
            border: "#a7f3d0",
          },
          {
            key: "fulfilled",
            label: "Fulfilled",
            color: "#1d4ed8",
            bg: "#dbeafe",
            border: "#bfdbfe",
          },
          {
            key: "rejected",
            label: "Rejected",
            color: "#b91c1c",
            bg: "#fee2e2",
            border: "#fecaca",
          },
        ].map((s) => (
          <div
            key={s.label}
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

      {/* Filters */}
      <div
        style={{
          background: "#fff",
          border: "1px solid #e2e8f0",
          borderRadius: 12,
          padding: 12,
          marginBottom: 14,
          display: "grid",
          gridTemplateColumns: "1fr 160px 160px auto",
          gap: 10,
          alignItems: "end",
        }}
      >
        <div>
          <label style={labelStyle}>Search</label>
          <input
            type="text"
            value={patientTerm}
            onChange={(e) => setPatientTerm(e.target.value)}
            placeholder="Patient ID or File No (e.g. 1234 or F-2025-009)"
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            style={inputStyle}
          />
        </div>
        <div>
          <label style={labelStyle}>To</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            style={inputStyle}
          />
        </div>
        <button
          onClick={() => {
            setPatientTerm("");
            setFrom("");
            setTo("");
            setStatus("all");
          }}
          style={{
            padding: "8px 12px",
            border: "1px solid #e2e8f0",
            background: "#fff",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            color: "#475569",
            cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>

      {/* Status pills */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
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

      {/* Grouped by patient */}
      {isInitialLoading ? (
        <div
          style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16 }}
        >
          <Shimmer type="list" count={5} />
        </div>
      ) : grouped.length === 0 ? (
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
          <div style={{ fontWeight: 700, color: "#334155" }}>
            No refill requests match these filters
          </div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Try clearing filters or switching status.
          </div>
        </div>
      ) : (
        grouped.map((g) => {
          const isOpen = !!expanded[g.patient_id];
          const isClosed = !!collapsed[g.patient_id];
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
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "12px 16px",
                  background: "#f8fafc",
                  borderBottom: "1px solid #e2e8f0",
                  gap: 12,
                }}
              >
                <div
                  style={{ display: "flex", alignItems: "center", gap: 12, flex: 1, minWidth: 0 }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 999,
                      background: "linear-gradient(135deg,#1e293b,#475569)",
                      color: "#fff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontWeight: 800,
                      fontSize: 15,
                      flexShrink: 0,
                    }}
                  >
                    {(g.patient_name || "?").charAt(0).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color: "#0f172a" }}>
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
                      background: "#fef3c7",
                      color: "#92400e",
                    }}
                  >
                    {g.current.length} CURRENT
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
                    {g.history.length} PAST
                  </span>
                  <button
                    onClick={() => toggleCollapsed(g.patient_id)}
                    title={isClosed ? "Expand" : "Close requests list"}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 999,
                      border: "1px solid #e2e8f0",
                      background: "#fff",
                      cursor: "pointer",
                      marginLeft: 4,
                      padding: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      color: "#475569",
                      lineHeight: 1,
                    }}
                  >
                    {isClosed ? "+" : "×"}
                  </button>
                </div>
              </div>

              {isClosed ? null : g.current.length === 0 ? (
                <div
                  style={{
                    padding: "12px 16px",
                    color: "#94a3b8",
                    fontSize: 12,
                    fontStyle: "italic",
                  }}
                >
                  No active requests for this patient.
                </div>
              ) : (
                g.current.map((r, i) => (
                  <RequestRow
                    key={r.id}
                    r={r}
                    isLast={i === g.current.length - 1 && !isOpen}
                    onAction={(st, reason) => updateStatus(r.id, st, reason)}
                  />
                ))
              )}

              {!isClosed && g.history.length > 0 && (
                <>
                  <button
                    onClick={() => toggleExpand(g.patient_id)}
                    style={{
                      width: "100%",
                      padding: "10px 16px",
                      background: isOpen ? "#f1f5f9" : "#fafbfc",
                      border: "none",
                      borderTop: "1px solid #e2e8f0",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      fontSize: 12,
                      fontWeight: 700,
                      color: "#475569",
                    }}
                  >
                    <span>
                      {isOpen ? "▼ Hide" : "▶ Show"} previous history ({g.history.length})
                    </span>
                    <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600 }}>
                      Fulfilled / rejected requests
                    </span>
                  </button>
                  {isOpen &&
                    g.history.map((r, i) => (
                      <RequestRow
                        key={r.id}
                        r={r}
                        isLast={i === g.history.length - 1}
                        onAction={(st, reason) => updateStatus(r.id, st, reason)}
                        muted
                      />
                    ))}
                </>
              )}
            </div>
          );
        })
      )}

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} style={{ minHeight: 1 }}>
        {listQuery.isFetchingNextPage ? (
          <div
            style={{
              background: "#fff",
              border: "1px solid #e2e8f0",
              borderRadius: 12,
              padding: 14,
              marginTop: 12,
            }}
          >
            <Shimmer type="list" count={2} />
          </div>
        ) : !listQuery.hasNextPage && requests.length > 0 ? (
          <div style={{ fontSize: 11, color: "#cbd5e1", padding: 10, textAlign: "center" }}>
            Showing all {total} request{total === 1 ? "" : "s"}
          </div>
        ) : null}
      </div>

      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, textAlign: "right" }}>
        {grouped.length} patient{grouped.length === 1 ? "" : "s"} · {requests.length} of {total}{" "}
        request{total === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function RequestRow({ r, isLast, onAction, muted = false }) {
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const submitReject = () => {
    onAction("rejected", rejectReason.trim());
    setRejecting(false);
    setRejectReason("");
  };

  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: isLast ? "none" : "1px solid #f1f5f9",
        background: muted ? "#fcfcfd" : "#fff",
        opacity: muted ? 0.92 : 1,
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
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 800,
                padding: "2px 8px",
                borderRadius: 999,
                ...statusStyle(r.status),
              }}
            >
              {(r.status || "pending").toUpperCase()}
            </span>
            <span style={{ fontSize: 11, color: "#64748b" }}>{fmtTime(r.requested_at)}</span>
          </div>
          <ul style={{ margin: "6px 0 4px 18px", padding: 0, fontSize: 13, color: "#334155" }}>
            {(r.items || []).map((it, j) => (
              <li key={j}>
                <strong>{it.quantity}×</strong> {it.medication_name}
                {it.dose ? ` (${it.dose})` : ""}
                {it.timing ? ` · ${it.timing}` : ""}
              </li>
            ))}
          </ul>
          {!!r.notes && (
            <div style={{ fontSize: 12, color: "#64748b", fontStyle: "italic", marginTop: 4 }}>
              Note: {r.notes}
            </div>
          )}
          {r.status === "rejected" && !!r.reject_reason && (
            <div
              style={{
                marginTop: 6,
                fontSize: 12,
                color: "#b91c1c",
                background: "#fef2f2",
                borderLeft: "3px solid #dc2626",
                borderRadius: 4,
                padding: "6px 10px",
                lineHeight: 1.4,
              }}
            >
              <strong style={{ fontWeight: 700 }}>Reason:</strong> {r.reject_reason}
            </div>
          )}
          {r.status_updated_at && r.status !== "pending" && (
            <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>
              {r.status} {fmtTime(r.status_updated_at)}
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: 6,
            flexShrink: 0,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          {r.status !== "approved" && r.status !== "fulfilled" && !rejecting && (
            <button
              onClick={() => onAction("approved")}
              style={btnStyle("#10b981", "#ecfdf5", "#047857")}
            >
              Approve
            </button>
          )}
          {r.status !== "fulfilled" && !rejecting && (
            <button
              onClick={() => onAction("fulfilled")}
              style={btnStyle("#2563eb", "#eff6ff", "#1d4ed8")}
            >
              Mark fulfilled
            </button>
          )}
          {r.status !== "rejected" && r.status !== "fulfilled" && !rejecting && (
            <button
              onClick={() => setRejecting(true)}
              style={btnStyle("#ef4444", "#fef2f2", "#b91c1c")}
            >
              Reject
            </button>
          )}
        </div>
      </div>

      {rejecting && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 8,
            background: "#fef2f2",
            border: "1px solid #fecaca",
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              color: "#b91c1c",
              marginBottom: 6,
              letterSpacing: 0.4,
            }}
          >
            REJECT REQUEST
          </div>
          <input
            type="text"
            autoFocus
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitReject();
              if (e.key === "Escape") {
                setRejecting(false);
                setRejectReason("");
              }
            }}
            placeholder="Reason (optional) — e.g. out of stock, prescription expired"
            style={{
              width: "100%",
              padding: "8px 10px",
              borderRadius: 6,
              border: "1px solid #fecaca",
              fontSize: 12,
              color: "#0f172a",
              background: "#fff",
              outline: "none",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
            <button
              onClick={() => {
                setRejecting(false);
                setRejectReason("");
              }}
              style={btnStyle("#cbd5e1", "#fff", "#475569")}
            >
              Cancel
            </button>
            <button onClick={submitReject} style={btnStyle("#ef4444", "#ef4444", "#fff")}>
              Confirm reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const labelStyle = {
  display: "block",
  fontSize: 10,
  fontWeight: 800,
  color: "#64748b",
  letterSpacing: 0.5,
  marginBottom: 4,
};

const inputStyle = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  fontSize: 13,
  color: "#0f172a",
  background: "#fff",
  outline: "none",
  boxSizing: "border-box",
};

function btnStyle(borderColor, bg, color) {
  return {
    fontSize: 11,
    fontWeight: 700,
    padding: "5px 12px",
    borderRadius: 6,
    border: `1px solid ${borderColor}`,
    background: bg,
    color,
    cursor: "pointer",
  };
}
