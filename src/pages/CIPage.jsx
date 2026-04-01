import { useEffect } from "react";
import "./CIPage.css";
import useReportsStore from "../stores/reportsStore";
import Shimmer from "../components/Shimmer.jsx";
import api from "../services/api.js";

export default function CIPage() {
  const ciData = useReportsStore((s) => s.ciData);
  const ciLoading = useReportsStore((s) => s.ciLoading);
  const ciPeriod = useReportsStore((s) => s.ciPeriod);
  const setCiPeriod = useReportsStore((s) => s.setCiPeriod);
  const ciExpandedCr = useReportsStore((s) => s.ciExpandedCr);
  const setCiExpandedCr = useReportsStore((s) => s.setCiExpandedCr);
  const ciExpandedRx = useReportsStore((s) => s.ciExpandedRx);
  const setCiExpandedRx = useReportsStore((s) => s.setCiExpandedRx);
  const loadCIReport = useReportsStore((s) => s.loadCIReport);

  useEffect(() => {
    loadCIReport(ciPeriod);
  }, [loadCIReport, ciPeriod]);

  return (
    <div className="ci">
      <div className="ci__header">
        <div>
          <div className="ci__title">🧠 Clinical Intelligence</div>
          <div className="ci__subtitle">AI performance & clinical reasoning capture</div>
        </div>
        <div className="ci__controls">
          <div className="ci__period-toggle">
            {[
              ["month", "Month"],
              ["quarter", "Quarter"],
              ["year", "Year"],
              ["all", "All"],
            ].map(([v, l]) => (
              <button
                key={v}
                onClick={() => setCiPeriod(v)}
                className="ci__period-btn"
                style={{
                  background: ciPeriod === v ? "#0f172a" : "white",
                  color: ciPeriod === v ? "white" : "#64748b",
                }}
              >
                {l}
              </button>
            ))}
          </div>
          <button onClick={() => loadCIReport()} className="ci__refresh-btn">
            ↻
          </button>
        </div>
      </div>

      {ciLoading ? (
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
          <Shimmer type="stats" count={3} />
          <Shimmer type="cards" count={4} />
        </div>
      ) : !ciData ? (
        <div className="ci__empty">
          <button onClick={() => loadCIReport()} className="ci__load-btn">
            📊 Load Report
          </button>
        </div>
      ) : (
        <>
          <div className="ci__overview">
            {[
              {
                label: "Reasoning Captured",
                value: ciData.overview.cr_total,
                sub: `${ciData.overview.cr_month} this month`,
                icon: "🧠",
                bg: "linear-gradient(135deg,#e0f2fe,#bae6fd)",
                color: "#0369a1",
              },
              {
                label: "Rx Reviews",
                value: ciData.overview.rx_total,
                sub: `${ciData.overview.rx_month} this month`,
                icon: "💊",
                bg: "linear-gradient(135deg,#f5f3ff,#ede9fe)",
                color: "#7c3aed",
              },
              {
                label: "Agreement Rate",
                value: (() => {
                  const a = ciData.overview.agreement;
                  const tot = a.reduce((s, r) => s + parseInt(r.count), 0);
                  const agree = a.find((r) => r.agreement_level === "agree");
                  return tot ? Math.round((parseInt(agree?.count || 0) / tot) * 100) + "%" : "—";
                })(),
                sub: "AI accuracy",
                icon: "✅",
                bg: "linear-gradient(135deg,#f0fdf4,#dcfce7)",
                color: "#059669",
              },
              {
                label: "Audio Hours",
                value: ciData.overview.audio_hours || 0,
                sub: "recordings",
                icon: "🎙️",
                bg: "linear-gradient(135deg,#fffbeb,#fef3c7)",
                color: "#d97706",
              },
            ].map((c, i) => (
              <div key={i} className="ci__overview-card" style={{ background: c.bg }}>
                <div className="ci__overview-label">
                  {c.icon} {c.label}
                </div>
                <div className="ci__overview-value" style={{ color: c.color }}>
                  {c.value}
                </div>
                <div className="ci__overview-sub">{c.sub}</div>
              </div>
            ))}
          </div>

          {ciData.overview.agreement.length > 0 && (
            <div className="ci__panel">
              <div className="ci__panel-title">📊 AI Review Breakdown</div>
              <div className="ci__agreement-row">
                {ciData.overview.agreement.map((a, i) => {
                  const total = ciData.overview.agreement.reduce(
                    (s, r) => s + parseInt(r.count),
                    0,
                  );
                  const pct = Math.round((parseInt(a.count) / total) * 100);
                  const colors = {
                    agree: "#059669",
                    partially_agree: "#d97706",
                    disagree: "#dc2626",
                  };
                  const labels = {
                    agree: "✅ Agree",
                    partially_agree: "🔶 Partial",
                    disagree: "❌ Disagree",
                  };
                  return (
                    <div key={i} className="ci__agreement-item">
                      <div
                        className="ci__agreement-pct"
                        style={{ color: colors[a.agreement_level] }}
                      >
                        {pct}%
                      </div>
                      <div className="ci__agreement-label">{labels[a.agreement_level]}</div>
                      <div className="ci__agreement-bar">
                        <div
                          className="ci__agreement-fill"
                          style={{ background: colors[a.agreement_level], width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {ciData.disagreement_tags?.length > 0 && (
            <div className="ci__panel">
              <div className="ci__panel-title">⚠️ Top Disagreement Reasons</div>
              {ciData.disagreement_tags.map((t, i) => (
                <div key={i} className="ci__tag-row">
                  <div className="ci__tag-name">{t.tag}</div>
                  <div className="ci__tag-bar">
                    <div
                      className="ci__tag-fill"
                      style={{ width: `${Math.min(100, parseInt(t.count) * 20)}%` }}
                    />
                  </div>
                  <div className="ci__tag-count">{t.count}</div>
                </div>
              ))}
            </div>
          )}

          {ciData.doctor_stats?.length > 0 && (
            <div className="ci__panel">
              <div className="ci__panel-title">👨‍⚕️ Doctor Contributions</div>
              {ciData.doctor_stats.map((d, i) => (
                <div
                  key={i}
                  className="ci__doctor-row"
                  style={{
                    borderBottom: i < ciData.doctor_stats.length - 1 ? "1px solid #f8fafc" : "none",
                  }}
                >
                  <div className="ci__doctor-name">{d.doctor_name || "Unknown"}</div>
                  <div className="ci__doctor-stats">
                    <span className="ci__doctor-stat--reasoning">
                      🧠 {d.reasoning_count} reasoning
                    </span>
                    <span className="ci__doctor-stat--rx">💊 {d.rx_count} reviews</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="ci__panel">
            <div className="ci__panel-title">🧠 Clinical Reasoning Feed</div>
            {ciData.reasoning_feed?.length === 0 && (
              <div className="ci__feed-empty">
                No entries yet — start capturing reasoning in consultations
              </div>
            )}
            {ciData.reasoning_feed?.map((cr, i) => (
              <div
                key={cr.id}
                onClick={() => setCiExpandedCr(ciExpandedCr === cr.id ? null : cr.id)}
                className="ci__feed-item"
                style={{
                  borderBottom: i < ciData.reasoning_feed.length - 1 ? "1px solid #f8fafc" : "none",
                }}
              >
                <div className="ci__feed-header">
                  <div className="ci__feed-meta">
                    <span className="ci__feed-condition">{cr.primary_condition || "General"}</span>
                    <span className="ci__feed-patient">{cr.file_no || cr.patient_name}</span>
                    <span className="ci__feed-doctor">by {cr.doctor_name}</span>
                  </div>
                  <div className="ci__feed-date-group">
                    {cr.audio_url && <span className="ci__feed-audio-icon">🎙️</span>}
                    <span className="ci__feed-date">
                      {new Date(cr.created_at).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                      })}
                    </span>
                  </div>
                </div>
                {ciExpandedCr === cr.id && (
                  <div className="ci__feed-expanded">
                    {cr.reasoning_text && <div>{cr.reasoning_text}</div>}
                    {cr.audio_transcript && (
                      <div className="ci__feed-transcript">🎙️ {cr.audio_transcript}</div>
                    )}
                    {cr.reasoning_tags?.length > 0 && (
                      <div className="ci__feed-tags">
                        {cr.reasoning_tags.map((t, ti) => (
                          <span key={ti} className="ci__feed-tag">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="ci__panel">
            <div className="ci__panel-title">💊 Rx Review Feedback Feed</div>
            {ciData.rx_feed?.length === 0 && (
              <div className="ci__feed-empty">
                No feedback yet — review AI prescriptions to generate data
              </div>
            )}
            {ciData.rx_feed?.map((rf, i) => {
              const agColors = {
                agree: "#059669",
                partially_agree: "#d97706",
                disagree: "#dc2626",
              };
              const agLabels = {
                agree: "✅ Agree",
                partially_agree: "🔶 Partial",
                disagree: "❌ Disagree",
              };
              return (
                <div
                  key={rf.id}
                  onClick={() => setCiExpandedRx(ciExpandedRx === rf.id ? null : rf.id)}
                  className="ci__rx-item"
                  style={{
                    borderBottom: i < ciData.rx_feed.length - 1 ? "1px solid #f8fafc" : "none",
                  }}
                >
                  <div className="ci__rx-header">
                    <div className="ci__rx-meta">
                      <span
                        className="ci__rx-badge"
                        style={{
                          background: agColors[rf.agreement_level] + "15",
                          color: agColors[rf.agreement_level],
                        }}
                      >
                        {agLabels[rf.agreement_level]}
                      </span>
                      <span className="ci__rx-patient">{rf.file_no || rf.patient_name}</span>
                      {rf.severity && (
                        <span
                          className={`ci__rx-severity ${rf.severity === "major" ? "ci__rx-severity--major" : "ci__rx-severity--minor"}`}
                        >
                          {rf.severity}
                        </span>
                      )}
                    </div>
                    <span className="ci__rx-date">
                      {new Date(rf.created_at).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                      })}
                    </span>
                  </div>
                  {ciExpandedRx === rf.id && (
                    <div className="ci__rx-expanded">
                      {rf.feedback_text && (
                        <div>
                          <strong>Feedback:</strong> {rf.feedback_text}
                        </div>
                      )}
                      {rf.correct_approach && (
                        <div className="ci__rx-correct">
                          <strong>Correct approach:</strong> {rf.correct_approach}
                        </div>
                      )}
                      {rf.reason_for_difference && (
                        <div className="ci__rx-difference">
                          <strong>Why AI was wrong:</strong> {rf.reason_for_difference}
                        </div>
                      )}
                      {rf.disagreement_tags?.length > 0 && (
                        <div className="ci__rx-tags">
                          {rf.disagreement_tags.map((t, ti) => (
                            <span key={ti} className="ci__rx-tag">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="ci__export">
            <button
              onClick={async () => {
                const resp = await api.get("/api/reports/clinical-intelligence/export");
                const blob = new Blob([JSON.stringify(resp.data, null, 2)], {
                  type: "application/json",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `clinical-intelligence-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
              }}
              className="ci__export-btn"
            >
              📥 Export All Data (JSON)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
