import { memo, useEffect, useRef, useState } from "react";
import api from "../../services/api";
import "./PostVisitSummary.css";
import "../Shimmer.css";

const PHASE_CLASS = {
  "Phase 1 · Control": "pvs-phase-amber",
  "Phase 2 · Stabilize": "pvs-phase-blue",
  "Phase 3 · Sustain": "pvs-phase-green",
};

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

const PostVisitSummary = memo(function PostVisitSummary({
  patientId,
  appointmentId,
  patient,
  doctor,
}) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const hasFiredRef = useRef(false);

  useEffect(() => {
    if (!patientId || hasFiredRef.current) return;
    hasFiredRef.current = true;
    const url = appointmentId
      ? `/api/patients/${patientId}/post-visit-summary?appointmentId=${appointmentId}`
      : `/api/patients/${patientId}/post-visit-summary`;
    api
      .get(url)
      .then(({ data }) => setData(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [patientId, appointmentId]);

  if (loading) return null;
  if (!data?.ready || !data?.narrative) return null;

  const phaseClass = (data.carePhase && PHASE_CLASS[data.carePhase]) || "pvs-phase-amber";
  const paragraphs = String(data.narrative)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const subBits = [];
  if (doctor?.name) subBits.push(`Dr. ${String(doctor.name).replace(/^dr\.?\s*/i, "")}`);
  if (data.totalVisits) subBits.push(`Visit ${data.totalVisits}`);

  return (
    <div className="pvs-card">
      <div className="pvs-header">
        <div>
          <div className="pvs-title">Visit Summary — {fmtDate(data.visitDate)}</div>
          {subBits.length > 0 && <div className="pvs-sub">{subBits.join(" · ")}</div>}
        </div>
        {data.carePhase && <span className={`pvs-phase ${phaseClass}`}>{data.carePhase}</span>}
      </div>
      <div className="pvs-body">
        {paragraphs.map((p, i) => (
          <p key={i} className="pvs-narrative">
            {p}
          </p>
        ))}
      </div>
    </div>
  );
});

export default PostVisitSummary;
