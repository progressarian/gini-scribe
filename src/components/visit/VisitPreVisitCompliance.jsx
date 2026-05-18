import { useEffect, useState } from "react";
import api from "../../services/api";

// Renders the medication-compliance summary shown on /visit. ONE shared
// box — patient (mobile) and coordinator (web OPD) both read & write
// `appointments.compliance` JSONB. We surface `medPct` as the chip and
// `missed` as the notes block. Hidden when neither is set.

function fmtSubmitted(iso) {
  if (!iso) return null;
  const d = new Date(iso);
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
}

function pctTone(pct) {
  if (pct >= 90) return { fg: "#047857", bg: "#ecfdf5", border: "#a7f3d0", label: "Good" };
  if (pct >= 70) return { fg: "#b45309", bg: "#fffbeb", border: "#fde68a", label: "Partial" };
  return { fg: "#b91c1c", bg: "#fef2f2", border: "#fecaca", label: "Low" };
}

export default function VisitPreVisitCompliance({ appointmentId }) {
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

  const raw = appt.compliance;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;

  const cleanStr = (v) => {
    if (typeof v !== "string") return "";
    const t = v.trim();
    if (!t) return "";
    const lower = t.toLowerCase();
    if (lower === "null" || lower === "undefined" || lower === "nan") return "";
    return t;
  };
  const pct = Number.isFinite(Number(raw.medPct)) ? Math.round(Number(raw.medPct)) : null;
  const notes = cleanStr(raw.missed);
  const diet = cleanStr(raw.diet);
  const exercise = cleanStr(raw.exercise);
  const stress = cleanStr(raw.stress);
  const extra = cleanStr(raw.extra);
  if (pct == null && !notes && !diet && !exercise && !stress && !extra) return null;

  const tone = pct != null ? pctTone(pct) : null;
  const lifestyleChips = [
    diet ? { label: "Diet", value: diet } : null,
    exercise ? { label: "Exercise", value: exercise } : null,
    stress ? { label: "Stress", value: stress } : null,
  ].filter(Boolean);
  // `pre_visit_compliance_at` is only bumped on patient-side saves, so it's
  // a useful hint of "when did the patient self-report this." Coordinator
  // edits don't change the timestamp.
  const submittedLabel = fmtSubmitted(appt.pre_visit_compliance_at);

  return (
    <section
      className="card"
      style={{
        margin: "8px 0",
        padding: "10px 12px",
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
          marginBottom: notes ? 8 : 0,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 700, color: "var(--violet, #6d4ef5)" }}>
          💊 Medication compliance
        </div>
        {pct != null && tone ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: tone.fg,
              background: tone.bg,
              border: `1px solid ${tone.border}`,
              borderRadius: 10,
              padding: "2px 9px",
              letterSpacing: 0.3,
            }}
          >
            {pct}% · {tone.label}
          </span>
        ) : null}
        {submittedLabel ? (
          <span style={{ fontSize: 10.5, color: "var(--t3, #6c6c80)", marginLeft: "auto" }}>
            patient logged {submittedLabel}
          </span>
        ) : null}
      </div>
      {notes ? (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text, #1a1a2e)",
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#fff",
            border: "1px solid var(--violet-border, #d9c8ff)",
            borderRadius: 8,
            padding: "6px 9px",
            marginBottom: lifestyleChips.length || extra ? 6 : 0,
          }}
        >
          <span style={{ color: "var(--t3, #6c6c80)", fontSize: 10, marginRight: 3 }}>📝</span>
          {notes}
        </div>
      ) : null}
      {lifestyleChips.length ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            marginBottom: extra ? 6 : 0,
          }}
        >
          {lifestyleChips.map((c) => (
            <span
              key={c.label}
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: "var(--text, #1a1a2e)",
                background: "#fff",
                border: "1px solid var(--violet-border, #d9c8ff)",
                borderRadius: 10,
                padding: "2px 8px",
              }}
            >
              <span style={{ color: "var(--t3, #6c6c80)", marginRight: 4 }}>{c.label}:</span>
              {c.value}
            </span>
          ))}
        </div>
      ) : null}
      {extra ? (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text, #1a1a2e)",
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#fff",
            border: "1px solid var(--violet-border, #d9c8ff)",
            borderRadius: 8,
            padding: "6px 9px",
          }}
        >
          <span style={{ color: "var(--t3, #6c6c80)", fontSize: 10, marginRight: 3 }}>💬</span>
          <span style={{ color: "var(--t3, #6c6c80)", fontSize: 10, marginRight: 4 }}>
            Patient added:
          </span>
          {extra}
        </div>
      ) : null}
    </section>
  );
}
