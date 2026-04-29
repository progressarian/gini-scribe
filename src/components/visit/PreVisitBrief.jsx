import { memo, useCallback, useEffect, useRef, useState } from "react";
import api from "../../services/api";
import "./PreVisitBrief.css";
import "../Shimmer.css";

const PreVisitBrief = memo(function PreVisitBrief({ patientId, appointmentId }) {
  const [loading, setLoading] = useState(true);
  const [narrative, setNarrative] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const hasFiredRef = useRef(false);

  const loadSummary = useCallback(
    ({ regenerate = false } = {}) => {
      if (!patientId) return;
      const params = new URLSearchParams();
      if (appointmentId) params.set("appointmentId", String(appointmentId));
      if (regenerate) params.set("regenerate", "true");
      const qs = params.toString();
      const url = `/api/patients/${patientId}/summary${qs ? "?" + qs : ""}`;
      setLoading(true);
      return api
        .get(url)
        .then(({ data }) => {
          setNarrative(data?.ai?.narrative || null);
          setGeneratedAt(data?.generatedAt || null);
          setFromCache(data?.cached ?? false);
        })
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
        <div className="pvb-label">✦ Pre-visit clinical brief</div>
        <div className="shimmer pvb-shimmer-line" style={{ width: "96%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "92%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "88%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "75%" }} />
      </div>
    );
  }

  if (!narrative) return null;

  const versionLabel = generatedAt
    ? `v ${new Date(generatedAt).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })}${fromCache ? " · cached" : ""}`
    : null;

  return (
    <div className="pvb-card">
      <div
        className="pvb-label"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <span>
          ✦ Pre-visit clinical brief
          {versionLabel && (
            <span style={{ marginLeft: 8, fontWeight: 400, opacity: 0.65, fontSize: 11 }}>
              {versionLabel}
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
      <p className="pvb-narrative">{narrative}</p>
    </div>
  );
});

export default PreVisitBrief;
