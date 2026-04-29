import { memo, useEffect, useRef, useState } from "react";
import api from "../../services/api";
import PreVisitBrief from "./PreVisitBrief";
import PostVisitSummary from "./PostVisitSummary";
import "./PreVisitBrief.css";
import "../Shimmer.css";

const VisitBrief = memo(function VisitBrief({ patientId, appointmentId, patient, doctor }) {
  const [loading, setLoading] = useState(true);
  const [postData, setPostData] = useState(null);
  const hasFiredRef = useRef(false);

  useEffect(() => {
    if (!patientId || hasFiredRef.current) return;
    hasFiredRef.current = true;
    const url = appointmentId
      ? `/api/patients/${patientId}/post-visit-summary?appointmentId=${appointmentId}`
      : `/api/patients/${patientId}/post-visit-summary`;
    api
      .get(url)
      .then(({ data }) => setPostData(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [patientId, appointmentId]);

  if (loading) {
    return (
      <div className="pvb-card pvb-loading">
        <div className="pvb-label">✦ Visit brief</div>
        <div className="shimmer pvb-shimmer-line" style={{ width: "96%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "92%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "88%" }} />
        <div className="shimmer pvb-shimmer-line" style={{ width: "75%" }} />
      </div>
    );
  }

  const hasPost = !!(postData?.ready && postData?.narrative);

  if (hasPost) {
    return (
      <PostVisitSummary
        patientId={patientId}
        appointmentId={appointmentId}
        patient={patient}
        doctor={doctor}
        prefetched={postData}
      />
    );
  }

  return <PreVisitBrief patientId={patientId} appointmentId={appointmentId} />;
});

export default VisitBrief;
