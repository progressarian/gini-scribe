import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import api from "../services/api.js";
import useAuthStore from "../stores/authStore.js";

// Doctor's review queue for patient-initiated lab test bookings.
// Mirrors the DoseChangeRequestsPage layout so the two stay visually
// consistent in the staff dashboard.

const STATUS_TABS = [
  { value: "all", label: "All", color: "#334155", bg: "#f1f5f9", border: "#e2e8f0" },
  { value: "pending", label: "Pending", color: "#92400e", bg: "#fef3c7", border: "#fde68a" },
  { value: "approved", label: "Approved", color: "#047857", bg: "#d1fae5", border: "#a7f3d0" },
  { value: "rejected", label: "Rejected", color: "#b91c1c", bg: "#fee2e2", border: "#fecaca" },
];

// Per-card status pill (derived from STATUS_TABS, keyed by status value).
const STATUS_BADGE = Object.fromEntries(
  STATUS_TABS.filter((t) => t.value !== "all").map((t) => [
    t.value,
    { label: t.label, color: t.color, bg: t.bg },
  ]),
);

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export default function LabRequestsPage() {
  const queryClient = useQueryClient();
  const currentDoctor = useAuthStore((s) => s.currentDoctor);
  const reviewerName = currentDoctor?.name || currentDoctor?.email || "";

  const [status, setStatus] = useState("pending");

  const listQuery = useQuery({
    queryKey: ["labRequests", "list", status],
    queryFn: async () => {
      const { data } = await api.get(`/api/lab-requests?status=${encodeURIComponent(status)}`);
      return Array.isArray(data) ? data : [];
    },
    staleTime: 15_000,
  });

  // Tab badge counts — pending list drives the highlight; others are
  // shown as raw counts so the doctor can see how the queue is moving.
  const statsQuery = useQuery({
    queryKey: ["labRequests", "stats"],
    queryFn: async () => {
      const [pending, approved, rejected] = await Promise.all(
        ["pending", "approved", "rejected"].map(async (s) => {
          const { data } = await api.get(`/api/lab-requests?status=${s}`);
          return Array.isArray(data) ? data.length : 0;
        }),
      );
      return { pending, approved, rejected, all: pending + approved + rejected };
    },
    staleTime: 15_000,
  });

  const rows = useMemo(() => listQuery.data || [], [listQuery.data]);
  const stats = statsQuery.data || { pending: 0, approved: 0, rejected: 0, all: 0 };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["labRequests"] });

  const decide = async (id, decision, note) => {
    try {
      await api.patch(`/api/lab-requests/${id}`, {
        status: decision,
        review_note: note || null,
        reviewed_by: reviewerName || null,
      });
      refresh();
    } catch (err) {
      // Best-effort — the next refresh will reconcile UI state if the
      // PATCH actually went through despite the error response.
      console.warn("[labRequests] decide failed:", err?.message);
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
            🧪 Lab Test Requests
          </div>
          <div style={{ fontSize: 12, color: "#64748b", marginTop: 2 }}>
            Patient-initiated lab bookings awaiting your review
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

      {/* Status tabs */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 10,
          marginBottom: 14,
        }}
      >
        {STATUS_TABS.map((t) => {
          const active = status === t.value;
          return (
            <button
              key={t.value}
              onClick={() => setStatus(t.value)}
              style={{
                cursor: "pointer",
                padding: "10px 14px",
                borderRadius: 10,
                border: `1px solid ${active ? t.color : t.border}`,
                background: active ? t.color : t.bg,
                color: active ? "#fff" : t.color,
                fontWeight: 700,
                fontSize: 12.5,
                textAlign: "left",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{t.label}</span>
              <span
                style={{
                  fontSize: 14,
                  fontWeight: 800,
                  background: active ? "rgba(255,255,255,0.2)" : "#fff",
                  color: active ? "#fff" : t.color,
                  padding: "2px 8px",
                  borderRadius: 8,
                }}
              >
                {stats[t.value] ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      {/* Request list */}
      {listQuery.isLoading ? (
        <div style={{ padding: 30, textAlign: "center", color: "#64748b", fontSize: 13 }}>
          Loading…
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            padding: 40,
            textAlign: "center",
            color: "#94a3b8",
            fontSize: 13,
            background: "#f8fafc",
            border: "1px dashed #e2e8f0",
            borderRadius: 12,
          }}
        >
          {status === "all" ? "No lab requests yet." : `No ${status} requests.`}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((req) => (
            <LabRequestCard key={req.id} req={req} onDecide={decide} />
          ))}
        </div>
      )}
    </div>
  );
}

// Single card. Inline approve/reject — clicking either reveals an optional
// note field, then the actual PATCH fires when the doctor confirms.
function LabRequestCard({ req, onDecide }) {
  const [mode, setMode] = useState(null); // null | 'approve' | 'reject'
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setMode(null);
    setNote("");
  }, [req.id]);

  const isPending = req.status === "pending";
  const isHome = req.collection_type === "home";

  const submit = async () => {
    if (submitting || !mode) return;
    setSubmitting(true);
    try {
      await onDecide(req.id, mode === "approve" ? "approved" : "rejected", note.trim());
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        padding: 14,
        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 800, color: "#0f172a" }}>
            {req.patient_name || `Patient #${req.patient_id}`}
            {req.patient_file_no ? (
              <span style={{ color: "#64748b", fontWeight: 600, marginLeft: 8, fontSize: 12 }}>
                · {req.patient_file_no}
              </span>
            ) : null}
          </div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            Requested {fmtDate(req.created_at)}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
          {STATUS_BADGE[req.status] ? (
            <div
              style={{
                background: STATUS_BADGE[req.status].bg,
                color: STATUS_BADGE[req.status].color,
                padding: "4px 10px",
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {STATUS_BADGE[req.status].label}
            </div>
          ) : null}
          <div
            style={{
              background: isHome ? "#ede9fe" : "#dbeafe",
              color: isHome ? "#5b21b6" : "#1e40af",
              padding: "4px 10px",
              borderRadius: 10,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {isHome ? "🏠 Home collection" : "🏥 At hospital"}
          </div>
        </div>
      </div>

      {/* Tests */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
        {(req.test_names || []).map((t, i) => (
          <span
            key={i}
            style={{
              background: "#f1f5f9",
              color: "#334155",
              padding: "3px 9px",
              borderRadius: 10,
              fontSize: 11,
              fontWeight: 700,
            }}
          >
            {t}
          </span>
        ))}
      </div>

      {/* Address (home only) */}
      {isHome ? (
        <div
          style={{
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: 10,
            padding: 10,
            marginBottom: 10,
            fontSize: 12,
            color: "#334155",
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4 }}>📍 Collection address</div>
          <div>{req.address_house}</div>
          <div>{req.address_street}</div>
          <div>{req.address_landmark}</div>
          <div style={{ marginTop: 2 }}>
            <strong>{req.address_pincode}</strong>
          </div>
        </div>
      ) : null}

      {/* Existing decision context for non-pending rows */}
      {!isPending && req.review_note ? (
        <div
          style={{
            background: req.status === "approved" ? "#ecfdf5" : "#fef2f2",
            color: req.status === "approved" ? "#065f46" : "#7f1d1d",
            border: `1px solid ${req.status === "approved" ? "#a7f3d0" : "#fecaca"}`,
            borderRadius: 10,
            padding: 8,
            fontSize: 12,
            marginBottom: 10,
          }}
        >
          <strong>{req.reviewed_by || "Doctor"}:</strong> {req.review_note}
        </div>
      ) : null}

      {/* Action area */}
      {isPending ? (
        mode === null ? (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setMode("approve")}
              style={{
                flex: 1,
                background: "#059669",
                color: "#fff",
                border: "none",
                padding: "9px 14px",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              ✓ Approve
            </button>
            <button
              onClick={() => setMode("reject")}
              style={{
                flex: 1,
                background: "#fff",
                color: "#b91c1c",
                border: "1px solid #fecaca",
                padding: "9px 14px",
                borderRadius: 8,
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              ✕ Reject
            </button>
          </div>
        ) : (
          <div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                mode === "approve"
                  ? "Optional — scheduling note for the patient (e.g. 'Come Tue 9 AM fasting')"
                  : "Reason for rejection (shown to the patient)"
              }
              rows={2}
              style={{
                width: "100%",
                border: "1px solid #e2e8f0",
                borderRadius: 8,
                padding: 8,
                fontSize: 12,
                marginBottom: 8,
                boxSizing: "border-box",
                fontFamily: "inherit",
              }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  setMode(null);
                  setNote("");
                }}
                disabled={submitting}
                style={{
                  background: "#fff",
                  color: "#475569",
                  border: "1px solid #e2e8f0",
                  padding: "8px 14px",
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={submitting}
                style={{
                  flex: 1,
                  background: mode === "approve" ? "#059669" : "#dc2626",
                  color: "#fff",
                  border: "none",
                  padding: "8px 14px",
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: 12,
                  cursor: submitting ? "wait" : "pointer",
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting
                  ? "Saving…"
                  : mode === "approve"
                    ? "✓ Confirm approve"
                    : "✕ Confirm reject"}
              </button>
            </div>
          </div>
        )
      ) : null}
    </div>
  );
}
