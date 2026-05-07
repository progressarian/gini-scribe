import { useEffect, useState } from "react";
import api from "../../services/api";

// Renders the symptoms + free-text the patient logged from the Genie app
// before this visit. Sourced from `appointments.pre_visit_symptoms`,
// `pre_visit_notes`, `pre_visit_symptoms_at`. Hidden when the patient
// hasn't submitted anything yet.
export default function VisitPreVisitSymptoms({ appointmentId }) {
  const [appt, setAppt] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!appointmentId) {
      setAppt(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get(`/api/appointments/${appointmentId}`)
      .then((r) => {
        if (!cancelled) setAppt(r.data || null);
      })
      .catch(() => {
        if (!cancelled) setAppt(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appointmentId]);

  if (!appointmentId || loading || !appt) return null;

  const symptoms = Array.isArray(appt.pre_visit_symptoms) ? appt.pre_visit_symptoms : [];
  const notes = (appt.pre_visit_notes || "").trim();
  const submittedAt = appt.pre_visit_symptoms_at;

  if (symptoms.length === 0 && !notes) return null;

  const submittedLabel = submittedAt
    ? (() => {
        const d = new Date(submittedAt);
        if (Number.isNaN(d.getTime())) return null;
        const now = new Date();
        const sameDay =
          d.getFullYear() === now.getFullYear() &&
          d.getMonth() === now.getMonth() &&
          d.getDate() === now.getDate();
        const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        if (sameDay) return `Today ${time}`;
        const date = d.toLocaleDateString([], { day: "numeric", month: "short" });
        return `${date} ${time}`;
      })()
    : null;

  return (
    <section
      className="card"
      style={{
        margin: "10px 0",
        padding: 14,
        background: "var(--violet-light, #f5f0ff)",
        border: "1px solid var(--violet-border, #d9c8ff)",
        borderRadius: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--violet, #6d4ef5)" }}>
          📝 Patient logged before this visit
        </div>
        {submittedLabel ? (
          <div style={{ fontSize: 11, color: "var(--t3, #6c6c80)" }}>
            Submitted {submittedLabel}
          </div>
        ) : null}
      </div>

      {symptoms.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: notes ? 10 : 0 }}>
          {symptoms.map((s, i) => (
            <span
              key={`${s}-${i}`}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--red-dark, #b22222)",
                background: "var(--red-light, #fde8e8)",
                border: "1px solid var(--red, #e53e3e)",
                borderRadius: 20,
                padding: "5px 11px",
              }}
            >
              {s}
            </span>
          ))}
        </div>
      ) : null}

      {notes ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--text, #1a1a2e)",
            background: "rgba(255,255,255,0.7)",
            border: "1px solid var(--violet-border, #d9c8ff)",
            borderRadius: 8,
            padding: "8px 10px",
            whiteSpace: "pre-wrap",
            lineHeight: 1.4,
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "var(--violet, #6d4ef5)",
              textTransform: "uppercase",
              letterSpacing: 0.4,
              marginRight: 6,
            }}
          >
            Patient note
          </span>
          {notes}
        </div>
      ) : null}
    </section>
  );
}
