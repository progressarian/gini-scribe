import { memo, useCallback, useEffect, useRef, useState } from "react";
import api from "../../services/api";
import "./PreVisitBrief.css";
import "../Shimmer.css";

function fmtDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(iso);
  }
}

const PostVisitSummary = memo(function PostVisitSummary({ patientId, appointmentId, prefetched }) {
  const [loading, setLoading] = useState(!prefetched);
  const [data, setData] = useState(prefetched || null);
  const hasFiredRef = useRef(!!prefetched);

  const loadSummary = useCallback(
    ({ regenerate = false } = {}) => {
      if (!patientId) return;
      const params = new URLSearchParams();
      if (appointmentId) params.set("appointmentId", String(appointmentId));
      if (regenerate) params.set("regenerate", "true");
      const qs = params.toString();
      const url = `/api/patients/${patientId}/post-visit-summary${qs ? "?" + qs : ""}`;
      setLoading(true);
      return api
        .get(url)
        .then(({ data }) => setData(data))
        .catch(() => {})
        .finally(() => setLoading(false));
    },
    [patientId, appointmentId],
  );

  useEffect(() => {
    if (!patientId || hasFiredRef.current) return;
    hasFiredRef.current = true;
    loadSummary();
  }, [patientId, loadSummary]);

  if (loading) {
    return (
      <div className="pvb-card pvb-loading">
        <div className="pvb-label">✦ Post-visit summary</div>
        <div className="shimmer pvb-shimmer-line" style={{ width: "96%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "92%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "88%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "75%" }} />
      </div>
    );
  }

  if (!data?.ready || !data?.narrative) return null;

  const paragraphs = String(data.narrative)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) return null;

  return (
    <div className="pvb-card">
      <div
        className="pvb-label"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <span>
          ✦ Post-visit summary{data.visitDate ? ` — ${fmtDate(data.visitDate)}` : ""}
          {data.generatedAt && (
            <span style={{ marginLeft: 8, fontWeight: 400, opacity: 0.65, fontSize: 11 }}>
              v{" "}
              {new Date(data.generatedAt).toLocaleString("en-IN", {
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {data.cached ? " · cached" : ""}
            </span>
          )}
        </span>
        <button
          className="bx bx-n"
          onClick={() => loadSummary({ regenerate: true })}
          disabled={loading}
          title="Regenerate summary from latest data"
          style={{ fontSize: 12 }}
        >
          {loading ? "Regenerating…" : "↻ Regenerate"}
        </button>
      </div>
      {paragraphs.map((p, i) => (
        <p key={i} className="pvb-narrative" style={i > 0 ? { marginTop: 10 } : undefined}>
          {p}
        </p>
      ))}
    </div>
  );
});

export default PostVisitSummary;
