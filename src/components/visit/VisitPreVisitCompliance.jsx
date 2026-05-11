import { useEffect, useState } from "react";
import api from "../../services/api";

// Renders the medication-compliance log the patient submitted from the
// Genie app's "Before you go" section. Sourced from
// `appointments.pre_visit_compliance` (JSONB array) and
// `pre_visit_compliance_at`. Hidden when the patient hasn't submitted yet.
//
// Each row: { medication, schedule, adherence, notes }
//   adherence ∈ { 'always' | 'mostly' | 'sometimes' | 'missed' | null }

const ADHERENCE_STYLE = {
  always:    { label: "Always",    dot: "#10b981", fg: "#047857", bg: "#ecfdf5" },
  mostly:    { label: "Mostly",    dot: "#10b981", fg: "#047857", bg: "#ecfdf5" },
  sometimes: { label: "Sometimes", dot: "#f59e0b", fg: "#b45309", bg: "#fffbeb" },
  missed:    { label: "Missed",    dot: "#ef4444", fg: "#b91c1c", bg: "#fef2f2" },
};

const NOTE_PREVIEW_CHARS = 90;

export default function VisitPreVisitCompliance({ appointmentId }) {
  const [appt, setAppt] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});

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

  const items = Array.isArray(appt.pre_visit_compliance) ? appt.pre_visit_compliance : [];
  if (items.length === 0) return null;

  const submittedAt = appt.pre_visit_compliance_at;
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

  const validItems = items.filter((it) => String(it?.medication || "").trim());
  const counts = validItems.reduce(
    (acc, it) => {
      const k = String(it?.adherence || "").toLowerCase();
      if (k === "always" || k === "mostly") acc.good += 1;
      else if (k === "sometimes") acc.partial += 1;
      else if (k === "missed") acc.missed += 1;
      return acc;
    },
    { good: 0, partial: 0, missed: 0 },
  );

  return (
    <section
      className="card"
      style={{
        margin: "8px 0",
        padding: "8px 10px",
        background: "var(--violet-light, #f5f0ff)",
        border: "1px solid var(--violet-border, #d9c8ff)",
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--violet, #6d4ef5)" }}>
          💊 Patient compliance log
        </div>
        <span style={{ fontSize: 10.5, color: "var(--t3, #6c6c80)" }}>self-reported</span>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", alignItems: "center" }}>
          {counts.good > 0 && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#047857" }}>
              ● {counts.good} taking
            </span>
          )}
          {counts.partial > 0 && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#b45309" }}>
              ● {counts.partial} partial
            </span>
          )}
          {counts.missed > 0 && (
            <span style={{ fontSize: 10.5, fontWeight: 700, color: "#b91c1c" }}>
              ● {counts.missed} missed
            </span>
          )}
          {submittedLabel && (
            <span style={{ fontSize: 10.5, color: "var(--t3, #6c6c80)" }}>
              · {submittedLabel}
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(max(220px, calc(25% - 5px)), 1fr))",
          gap: 6,
          alignItems: "stretch",
        }}
      >
        {validItems.map((it, i) => {
          const med = String(it.medication).trim();
          const adh = ADHERENCE_STYLE[String(it?.adherence || "").toLowerCase()];
          const schedule = String(it?.schedule || "").trim();
          const notes = String(it?.notes || "").trim();
          return (
            (() => {
              const key = `${i}-${med}`;
              const isLong = notes.length > NOTE_PREVIEW_CHARS;
              const isOpen = !!expanded[key];
              const shownNote =
                notes && isLong && !isOpen ? `${notes.slice(0, NOTE_PREVIEW_CHARS).trimEnd()}…` : notes;
              return (
                <div
                  key={key}
                  style={{
                    background: "#fff",
                    border: "1px solid var(--violet-border, #d9c8ff)",
                    borderLeft: `3px solid ${adh?.dot || "#d9c8ff"}`,
                    borderRadius: 8,
                    padding: "6px 9px",
                    minWidth: 0,
                    boxShadow: "0 1px 2px rgba(20, 14, 50, 0.04)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 3,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 6,
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 12.5,
                        fontWeight: 600,
                        color: "var(--text, #1a1a2e)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flex: "1 1 auto",
                        minWidth: 0,
                      }}
                      title={med}
                    >
                      {med}
                    </span>
                    {adh ? (
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 700,
                          color: adh.fg,
                          background: adh.bg,
                          border: `1px solid ${adh.dot}33`,
                          borderRadius: 10,
                          padding: "1px 6px",
                          whiteSpace: "nowrap",
                          flex: "0 0 auto",
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                        }}
                      >
                        {adh.label}
                      </span>
                    ) : null}
                  </div>
                  {schedule ? (
                    <div
                      style={{
                        fontSize: 10.5,
                        color: "var(--t2, #44445c)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={schedule}
                    >
                      ⏱ {schedule}
                    </div>
                  ) : null}
                  {notes ? (
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--text, #1a1a2e)",
                        lineHeight: 1.4,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        background: "var(--violet-light, #f5f0ff)",
                        border: "1px solid var(--violet-border, #d9c8ff)",
                        borderRadius: 6,
                        padding: "4px 6px",
                        marginTop: "auto",
                      }}
                    >
                      <span style={{ color: "var(--t3, #6c6c80)", fontSize: 10 }}>📝 </span>
                      {shownNote}
                      {isLong ? (
                        <button
                          type="button"
                          onClick={() =>
                            setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))
                          }
                          style={{
                            marginLeft: 4,
                            background: "none",
                            border: "none",
                            padding: 0,
                            color: "var(--violet, #6d4ef5)",
                            fontSize: 10.5,
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          {isOpen ? "view less" : "view more"}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })()
          );
        })}
      </div>
    </section>
  );
}
