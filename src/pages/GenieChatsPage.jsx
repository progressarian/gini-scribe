import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";

// Read-only doctor view of a patient's conversation with the "Genie" AI
// assistant (the patient app's chat_messages). Scoped to gini-program
// patients (INT ids) — served by server/routes/genieChat.js straight from
// scribe's own Postgres. The doctor cannot post into the thread.

const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";
const fmtDay = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "";
const fmtRel = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay ? fmtTime(iso) : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
};

// actions JSONB → compact human labels. Tolerant of arbitrary shapes.
function actionLabels(actions) {
  if (!actions) return [];
  let arr = actions;
  if (typeof arr === "string") {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [arr.slice(0, 40)];
    }
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr
    .map((a) => {
      if (!a) return null;
      if (typeof a === "string") return a;
      const t = a.type || a.action || a.kind;
      if (!t) return null;
      return String(t).replace(/_/g, " ");
    })
    .filter(Boolean)
    .slice(0, 4);
}

export default function GenieChatsPage() {
  const [search, setSearch] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const [active, setActive] = useState(null); // { id, name, gini_patient_id }

  const queryClient = useQueryClient();

  const [msgs, setMsgs] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState(null);

  const scrollRef = useRef(null);
  const prevHeightRef = useRef(0);

  // ── Inbox list (paginated, infinite scroll — mirrors RefillsPage.jsx) ────
  // Debounce the search box into the query key.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedTerm(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const listQuery = useInfiniteQuery({
    queryKey: ["genie-chats", "list", debouncedTerm],
    initialPageParam: 1,
    queryFn: async ({ pageParam = 1 }) => {
      const { data } = await api.get("/api/genie-chats", {
        params: { page: pageParam, limit: 10, ...(debouncedTerm ? { search: debouncedTerm } : {}) },
      });
      return data;
    },
    getNextPageParam: (lastPage) =>
      lastPage && lastPage.page < lastPage.totalPages ? lastPage.page + 1 : undefined,
  });

  const list = useMemo(
    () => (listQuery.data?.pages || []).flatMap((p) => p?.rows || []),
    [listQuery.data],
  );
  const totalPatients = listQuery.data?.pages?.[0]?.total ?? 0;
  const listLoading = listQuery.isLoading;

  // ── Thread ─────────────────────────────────────────────────────────────
  const openPatient = useCallback(async (p) => {
    setActive(p);
    setMsgs([]);
    setError(null);
    setThreadLoading(true);
    try {
      const { data } = await api.get(`/api/patients/${p.id}/genie-chat`, {
        params: { limit: 50 },
      });
      setMsgs(Array.isArray(data?.data) ? data.data : []);
      setHasMore(!!data?.hasMore);
    } catch (e) {
      setError(e?.response?.data?.error || e?.message || "Failed to load conversation");
    } finally {
      setThreadLoading(false);
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (!active || !msgs.length || loadingOlder) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    if (el) prevHeightRef.current = el.scrollHeight;
    try {
      const { data } = await api.get(`/api/patients/${active.id}/genie-chat`, {
        params: { limit: 50, before: msgs[0].created_at },
      });
      const older = Array.isArray(data?.data) ? data.data : [];
      setMsgs((cur) => [...older, ...cur]);
      setHasMore(!!data?.hasMore);
    } catch {
      /* non-fatal */
    } finally {
      setLoadingOlder(false);
    }
  }, [active, msgs, loadingOlder]);

  // Auto-scroll to bottom on open; preserve position when prepending older.
  useEffect(() => {
    if (threadLoading) return;
    const el = scrollRef.current;
    if (el && prevHeightRef.current === 0) el.scrollTop = el.scrollHeight;
  }, [threadLoading, msgs.length]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && prevHeightRef.current > 0 && el.scrollHeight > prevHeightRef.current) {
      el.scrollTop = el.scrollHeight - prevHeightRef.current;
      prevHeightRef.current = 0;
    }
  }, [msgs.length]);

  const onScroll = (e) => {
    if (e.currentTarget.scrollTop < 60 && hasMore && !loadingOlder) loadOlder();
  };

  // Group consecutive messages by day for date separators.
  const rendered = useMemo(() => {
    const out = [];
    let lastDay = null;
    for (const m of msgs) {
      const day = fmtDay(m.created_at);
      if (day !== lastDay) {
        out.push({ kind: "day", day, key: `day-${day}` });
        lastDay = day;
      }
      out.push({ kind: "msg", m, key: m.id });
    }
    return out;
  }, [msgs]);

  const S = styles;

  // ── Detail view ──────────────────────────────────────────────────────────
  if (active) {
    return (
      <div>
        <div style={S.title}>🤖 Genie AI Chat</div>
        <button onClick={() => setActive(null)} style={S.backBtn}>
          ← Back to list
        </button>

        <div style={S.patientHeader}>
          <div style={S.avatar}>{(active.name || "P").charAt(0).toUpperCase()}</div>
          <div>
            <div style={S.patientName}>{active.name || `Patient ${active.id}`}</div>
            <div style={S.patientFile}>
              {active.gini_patient_id ? `File ${active.gini_patient_id} · ` : ""}AI assistant
              transcript (read-only)
            </div>
          </div>
        </div>

        <div style={S.threadScroll} ref={scrollRef} onScroll={onScroll}>
          {loadingOlder && <div style={S.olderLoader}>Loading older messages…</div>}
          {!loadingOlder && !hasMore && msgs.length > 0 && (
            <div style={S.olderEnd}>— Start of conversation —</div>
          )}
          {threadLoading ? (
            <div style={S.center}>Loading conversation…</div>
          ) : error ? (
            <div style={S.errorBox}>⚠ {error}</div>
          ) : msgs.length === 0 ? (
            <div style={S.center}>No Genie chat for this patient yet</div>
          ) : (
            rendered.map((r) =>
              r.kind === "day" ? (
                <div key={r.key} style={S.daySep}>
                  <span style={S.dayPill}>{r.day}</span>
                </div>
              ) : (
                <Bubble key={r.key} m={r.m} />
              ),
            )
          )}
        </div>
      </div>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────
  return (
    <div>
      <div style={S.title}>🤖 Genie AI Chats</div>

      <div style={S.inboxBar}>
        <div style={S.inboxInfo}>
          {totalPatients === 0
            ? "No Genie chats yet"
            : `${totalPatients} patient${totalPatients === 1 ? "" : "s"}`}
        </div>
        <button
          onClick={() => queryClient.invalidateQueries({ queryKey: ["genie-chats"] })}
          disabled={listQuery.isFetching}
          style={S.refreshBtn}
        >
          ↻ {listQuery.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div style={S.searchBar}>
        <span>🔍</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or file number…"
          style={S.searchInput}
        />
        {search && (
          <button onClick={() => setSearch("")} style={S.searchClear}>
            ✕
          </button>
        )}
      </div>

      {listLoading && list.length === 0 ? (
        <div style={S.center}>Loading…</div>
      ) : listQuery.isError && list.length === 0 ? (
        <div style={S.errorBox}>
          ⚠{" "}
          {listQuery.error?.response?.data?.error ||
            listQuery.error?.message ||
            "Failed to load chats"}
        </div>
      ) : list.length === 0 ? (
        <div style={S.empty}>
          <div style={{ fontSize: 30 }}>📭</div>
          <div>
            {debouncedTerm
              ? `No matches for "${debouncedTerm}"`
              : "No patient has chatted with Genie yet."}
          </div>
        </div>
      ) : (
        <>
          {list.map((c) => (
            <div key={c.id} onClick={() => openPatient(c)} style={S.threadCard}>
              <div style={S.threadHeader}>
                <div style={S.threadInfo}>
                  <div style={S.threadAvatar}>{(c.name || "P").charAt(0).toUpperCase()}</div>
                  <div>
                    <div style={S.threadName}>{c.name || `Patient ${c.id}`}</div>
                    <div style={S.threadFile}>
                      {c.gini_patient_id ? `File ${c.gini_patient_id} · ` : ""}
                      {c.msg_count} messages
                    </div>
                  </div>
                </div>
                <div style={S.threadDate}>{fmtRel(c.last_at)}</div>
              </div>
              {c.last_preview && <div style={S.threadPreview}>{c.last_preview}</div>}
            </div>
          ))}
          {listQuery.hasNextPage ? (
            <button
              onClick={() => listQuery.fetchNextPage()}
              disabled={listQuery.isFetchingNextPage}
              style={S.loadMoreBtn}
            >
              {listQuery.isFetchingNextPage
                ? "Loading…"
                : `Load more (${Math.max(0, totalPatients - list.length)} more)`}
            </button>
          ) : (
            list.length > 0 && <div style={S.olderEnd}>— Showing all {totalPatients} —</div>
          )}
        </>
      )}
    </div>
  );
}

function Bubble({ m }) {
  const isPatient = m.role === "user";
  const isSystem = m.role === "system";
  const labels = actionLabels(m.actions);
  const imgHttp = typeof m.image_uri === "string" && /^https?:\/\//.test(m.image_uri);

  if (isSystem) {
    return (
      <div style={{ textAlign: "center", margin: "8px 0" }}>
        <span style={styles.dayPill}>{m.content}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: isPatient ? "flex-end" : "flex-start",
        marginBottom: 8,
      }}
    >
      <div style={isPatient ? styles.bubblePatient : styles.bubbleGenie}>
        {m.image_uri ? (
          imgHttp ? (
            <img src={m.image_uri} alt="attachment" style={styles.bubbleImg} />
          ) : (
            <div style={styles.imgNote}>📎 Image attachment</div>
          )
        ) : null}
        {m.content ? <div style={styles.bubbleText}>{m.content}</div> : null}
        {labels.length > 0 && (
          <div style={styles.actionsRow}>
            {labels.map((l, i) => (
              <span key={i} style={styles.actionChip}>
                ⚡ {l}
              </span>
            ))}
          </div>
        )}
        <div style={styles.bubbleMeta}>
          {isPatient ? "Patient" : "Genie"} · {fmtTime(m.created_at)}
        </div>
      </div>
    </div>
  );
}

const styles = {
  title: { fontSize: 18, fontWeight: 800, color: "#0f172a", margin: "4px 0 14px" },
  backBtn: {
    background: "none",
    border: "none",
    color: "#2563eb",
    fontSize: 14,
    cursor: "pointer",
    padding: "2px 0",
    marginBottom: 10,
  },
  inboxBar: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  inboxInfo: { fontSize: 13, color: "#64748b" },
  refreshBtn: {
    fontSize: 12,
    fontWeight: 600,
    color: "#475569",
    background: "#f1f5f9",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: "5px 12px",
    cursor: "pointer",
  },
  searchBar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: "6px 12px",
    marginBottom: 12,
  },
  searchInput: { flex: 1, border: "none", outline: "none", fontSize: 14, color: "#0f172a" },
  searchClear: { background: "none", border: "none", color: "#94a3b8", cursor: "pointer" },
  center: { textAlign: "center", color: "#94a3b8", padding: 30, fontSize: 13 },
  empty: { textAlign: "center", color: "#94a3b8", padding: 30, fontSize: 14, lineHeight: 1.8 },
  errorBox: {
    fontSize: 13,
    color: "#b91c1c",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 8,
    padding: "10px 14px",
    margin: "8px 0",
  },
  threadCard: {
    background: "#fff",
    border: "1px solid #f1f5f9",
    borderLeft: "4px solid #c4b5fd",
    borderRadius: 10,
    padding: "10px 14px",
    marginBottom: 8,
    cursor: "pointer",
  },
  threadHeader: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  threadInfo: { display: "flex", alignItems: "center", gap: 10 },
  threadAvatar: {
    width: 34,
    height: 34,
    borderRadius: "50%",
    background: "#ede9fe",
    color: "#6d28d9",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
  },
  threadName: { fontSize: 14, fontWeight: 700, color: "#0f172a" },
  threadFile: { fontSize: 12, color: "#94a3b8" },
  threadDate: { fontSize: 11, color: "#94a3b8" },
  threadPreview: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 6,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  patientHeader: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 14px",
    background: "#faf5ff",
    border: "1px solid #ede9fe",
    borderRadius: 10,
    marginBottom: 10,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: "50%",
    background: "#ede9fe",
    color: "#6d28d9",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 18,
  },
  patientName: { fontSize: 15, fontWeight: 700, color: "#0f172a" },
  patientFile: { fontSize: 12, color: "#94a3b8" },
  threadScroll: {
    height: "calc(100vh - 230px)",
    overflowY: "auto",
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: 14,
  },
  daySep: { textAlign: "center", margin: "10px 0" },
  dayPill: {
    fontSize: 11,
    color: "#64748b",
    background: "#e2e8f0",
    borderRadius: 999,
    padding: "2px 10px",
  },
  olderLoader: { textAlign: "center", color: "#94a3b8", fontSize: 12, padding: 6 },
  olderEnd: { textAlign: "center", color: "#cbd5e1", fontSize: 11, padding: 6 },
  loadMoreBtn: {
    display: "block",
    width: "100%",
    marginTop: 8,
    padding: "10px 0",
    fontSize: 13,
    fontWeight: 600,
    color: "#6d28d9",
    background: "#f5f3ff",
    border: "1px solid #ede9fe",
    borderRadius: 10,
    cursor: "pointer",
  },
  bubblePatient: {
    maxWidth: "72%",
    background: "#7c3aed",
    color: "#fff",
    borderRadius: "14px 14px 4px 14px",
    padding: "8px 12px",
  },
  bubbleGenie: {
    maxWidth: "72%",
    background: "#fff",
    color: "#0f172a",
    border: "1px solid #e2e8f0",
    borderRadius: "14px 14px 14px 4px",
    padding: "8px 12px",
  },
  bubbleText: { fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word" },
  bubbleImg: { maxWidth: "100%", borderRadius: 8, marginBottom: 6, display: "block" },
  imgNote: { fontSize: 12, opacity: 0.85, marginBottom: 4 },
  bubbleMeta: { fontSize: 10, opacity: 0.7, marginTop: 4 },
  actionsRow: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 },
  actionChip: {
    fontSize: 10,
    fontWeight: 600,
    background: "rgba(15,23,42,0.08)",
    color: "inherit",
    borderRadius: 999,
    padding: "1px 7px",
  },
};
