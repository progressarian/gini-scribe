import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import useAuthStore from "../stores/authStore.js";
import Shimmer from "../components/Shimmer.jsx";
import DoseChangeRequestCard from "../components/doseChange/DoseChangeRequestCard.jsx";

const STATUS_OPTIONS = [
  { value: "all", label: "All", color: "#475569", bg: "#f1f5f9" },
  { value: "pending", label: "Pending", color: "#92400e", bg: "#fef3c7" },
  { value: "approved", label: "Approved", color: "#047857", bg: "#d1fae5" },
  { value: "rejected", label: "Rejected", color: "#b91c1c", bg: "#fee2e2" },
  { value: "cancelled", label: "Cancelled", color: "#475569", bg: "#f1f5f9" },
];

const PAGE_SIZE = 30;

function buildQs({ status, patient, page, includeStatus }) {
  const p = new URLSearchParams();
  if (includeStatus) p.set("status", status || "all");
  if (patient) p.set("patient", patient);
  if (page) p.set("page", String(page));
  p.set("limit", String(PAGE_SIZE));
  return p.toString();
}

export default function DoseChangeRequestsPage() {
  const queryClient = useQueryClient();
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const doctorId = currentDoctor?.id || currentDoctor?.email || "";

  const [status, setStatus] = useState("pending");
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filterKey = { status, patient: debounced };

  const statsQuery = useQuery({
    queryKey: ["doseChange", "stats", debounced],
    queryFn: async () => {
      const qs = buildQs({ status, patient: debounced, includeStatus: false });
      const { data } = await api.get(`/api/dose-change-requests/stats?${qs}`);
      return data || { pending: 0, approved: 0, rejected: 0, cancelled: 0, total: 0 };
    },
    staleTime: 30_000,
  });

  const listQuery = useInfiniteQuery({
    queryKey: ["doseChange", "list", filterKey],
    initialPageParam: 1,
    queryFn: async ({ pageParam = 1 }) => {
      const qs = buildQs({
        status,
        patient: debounced,
        page: pageParam,
        includeStatus: true,
      });
      const { data } = await api.get(`/api/dose-change-requests?${qs}`);
      return data;
    },
    getNextPageParam: (lp) => (lp && lp.page < lp.totalPages ? lp.page + 1 : undefined),
  });

  const rows = useMemo(() => {
    const raw = (listQuery.data?.pages || []).flatMap((p) => p?.rows || []);
    const ts = (r) => new Date(r.requested_at || 0).getTime();
    if (status === "pending") {
      return [...raw].sort((a, b) => ts(a) - ts(b));
    }
    if (status === "all") {
      const pending = raw
        .filter((r) => (r.status || "pending") === "pending")
        .sort((a, b) => ts(a) - ts(b));
      const others = raw
        .filter((r) => (r.status || "pending") !== "pending")
        .sort((a, b) => ts(b) - ts(a));
      return [...pending, ...others];
    }
    return [...raw].sort((a, b) => ts(b) - ts(a));
  }, [listQuery.data, status]);
  const total = listQuery.data?.pages?.[0]?.total ?? 0;
  const stats = statsQuery.data || { pending: 0, approved: 0, rejected: 0, cancelled: 0 };

  // Infinite scroll: fetch the next page once a sentinel near the bottom of
  // the list scrolls into view.
  const sentinelRef = useRef(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const io = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        if (e?.isIntersecting && listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
          listQuery.fetchNextPage();
        }
      },
      { rootMargin: "200px 0px" },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [listQuery.hasNextPage, listQuery.isFetchingNextPage, listQuery.fetchNextPage]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["doseChange"] });

  const decide = async (id, payload) => {
    try {
      await api.patch(`/api/dose-change-requests/${id}`, { ...payload, doctor_id: doctorId });
      refresh();
    } catch {
      /* swallow — UI will be reconciled on refresh */
    }
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
            ⚕️ Dose Change Requests
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            Patient-initiated dose adjustments awaiting your review
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
          { key: "pending", label: "Pending", color: "#92400e", bg: "#fef3c7", border: "#fde68a" },
          {
            key: "approved",
            label: "Approved",
            color: "#047857",
            bg: "#d1fae5",
            border: "#a7f3d0",
          },
          {
            key: "rejected",
            label: "Rejected",
            color: "#b91c1c",
            bg: "#fee2e2",
            border: "#fecaca",
          },
          {
            key: "cancelled",
            label: "Cancelled",
            color: "#475569",
            bg: "#f1f5f9",
            border: "#e2e8f0",
          },
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
          placeholder="Search by patient name, ID or file no"
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

      {listQuery.isLoading ? (
        <div
          style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 16 }}
        >
          <Shimmer type="list" count={5} />
        </div>
      ) : rows.length === 0 ? (
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
            No dose-change requests in this view
          </div>
        </div>
      ) : (
        rows.map((r) => (
          <DoseChangeRequestCard
            key={r.id}
            request={r}
            onDecide={(payload) => decide(r.id, payload)}
          />
        ))
      )}

      <div ref={sentinelRef} style={{ height: 1 }} />
      {listQuery.isFetchingNextPage && (
        <div style={{ textAlign: "center", padding: 14, color: "#64748b", fontSize: 12 }}>
          Loading more…
        </div>
      )}
      {!listQuery.hasNextPage && rows.length > 0 && (
        <div style={{ textAlign: "center", padding: 10, color: "#cbd5e1", fontSize: 11 }}>
          — End of list —
        </div>
      )}

      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6, textAlign: "right" }}>
        {rows.length} of {total} request{total === 1 ? "" : "s"}
      </div>
    </div>
  );
}
