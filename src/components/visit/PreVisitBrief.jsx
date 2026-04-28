import { memo, useEffect, useRef, useState } from "react";
import api from "../../services/api";
import "./PreVisitBrief.css";
import "../Shimmer.css";

const PreVisitBrief = memo(function PreVisitBrief({ patientId, appointmentId }) {
  const [loading, setLoading] = useState(true);
  const [narrative, setNarrative] = useState(null);
  const hasFiredRef = useRef(false);

  useEffect(() => {
    if (!patientId || hasFiredRef.current) return;
    hasFiredRef.current = true;
    const url = appointmentId
      ? `/api/patients/${patientId}/summary?appointmentId=${appointmentId}`
      : `/api/patients/${patientId}/summary`;
    api
      .get(url)
      .then(({ data }) => setNarrative(data?.ai?.narrative || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [patientId, appointmentId]);

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

  return (
    <div className="pvb-card">
      <div className="pvb-label">✦ Pre-visit clinical brief</div>
      <p className="pvb-narrative">{narrative}</p>
    </div>
  );
});

export default PreVisitBrief;
