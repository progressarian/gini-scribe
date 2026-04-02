import { memo } from "react";
import { fmtDate } from "./helpers";

const VisitLoggedData = memo(function VisitLoggedData({ loggedData }) {
  const hasAny =
    loggedData.vitals?.length ||
    loggedData.activity?.length ||
    loggedData.symptoms?.length ||
    loggedData.meds?.length ||
    loggedData.meals?.length;

  // Compute summary stats
  const medsDays = loggedData.meds?.length || 0;
  const adherence = medsDays > 0 ? Math.round((medsDays / 30) * 100) : 0;
  const steps =
    loggedData.activity?.filter(
      (a) => a.activity_type === "Exercise" || a.value?.includes?.("step"),
    ) || [];
  const avgSteps =
    steps.length > 0
      ? Math.round(steps.reduce((s, a) => s + (parseFloat(a.value) || 0), 0) / steps.length)
      : 0;

  return (
    <div className="panel-body">
      <div className="sc">
        <div className="sch">
          <div className="sct">
            <div className="sci ic-b">📊</div>Patient App Data — Last 30 Days
          </div>
          <button className="bx bx-p">View All Data</button>
        </div>
        <div className="scb">
          {/* Summary cards */}
          <div className="log-grid">
            <div className="log-card">
              <div
                className="log-val"
                style={{ color: adherence >= 80 ? "var(--green)" : "var(--amber)" }}
              >
                {adherence > 0 ? `${adherence}%` : medsDays || 0}
              </div>
              <div className="log-lbl">
                {adherence > 0 ? "Medication Adherence" : "Med Doses Logged"}
              </div>
              {adherence > 0 && <div className="log-sub">{medsDays}/30 days logged</div>}
            </div>
            <div className="log-card">
              <div
                className="log-val"
                style={{ color: avgSteps >= 10000 ? "var(--green)" : "var(--amber)" }}
              >
                {avgSteps > 0 ? avgSteps.toLocaleString() : loggedData.vitals?.length || 0}
              </div>
              <div className="log-lbl">{avgSteps > 0 ? "Avg Daily Steps" : "Vitals Readings"}</div>
              {avgSteps > 0 && <div className="log-sub">Target: 10,000</div>}
            </div>
            <div className="log-card">
              <div className="log-val" style={{ color: "var(--green)" }}>
                {loggedData.meals?.length || 0}
              </div>
              <div className="log-lbl">Meals Logged</div>
              <div className="log-sub">Self-reported readings</div>
            </div>
          </div>

          {/* Blood sugar readings from vitals log */}
          {loggedData.vitals?.length > 0 && (
            <>
              <div className="subsec">Blood Sugar Readings — Self-Logged</div>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--rs)",
                  overflow: "hidden",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr 1fr",
                    padding: "6px 12px",
                    background: "var(--bg)",
                    gap: 6,
                  }}
                >
                  <span className="mthl">Date</span>
                  <span className="mthl">BP</span>
                  <span className="mthl">Blood Sugar</span>
                  <span className="mthl">Type</span>
                </div>
                {loggedData.vitals.slice(0, 20).map((v, i) => (
                  <div
                    key={v.id || i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr 1fr",
                      padding: "6px 12px",
                      borderTop: "1px solid var(--border)",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <span>{fmtDate(v.recorded_date)}</span>
                    <span>
                      {v.bp_systolic && v.bp_diastolic ? `${v.bp_systolic}/${v.bp_diastolic}` : "—"}
                    </span>
                    <span
                      style={{
                        fontWeight: 700,
                        color:
                          v.rbs > 180 ? "var(--red)" : v.rbs > 140 ? "var(--amber)" : "var(--text)",
                      }}
                    >
                      {v.rbs || "—"}
                    </span>
                    <span style={{ color: "var(--t3)" }}>{v.meal_type || ""}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Symptom logs */}
          {loggedData.symptoms?.length > 0 && (
            <>
              <div className="subsec">Reported Symptoms</div>
              <div className="syg">
                {loggedData.symptoms.slice(0, 8).map((s, i) => (
                  <div key={s.id || i} className="syi">
                    <div
                      className="sy-dot"
                      style={{
                        background:
                          s.severity > 6
                            ? "var(--red)"
                            : s.severity > 3
                              ? "var(--amber)"
                              : "var(--green)",
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div className="sy-nm">{s.symptom}</div>
                      <div className="sy-meta">
                        {fmtDate(s.log_date)}
                        {s.body_area ? ` · ${s.body_area}` : ""}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Meal logs */}
          {loggedData.meals?.length > 0 && (
            <>
              <div className="subsec">Recent Meals Logged</div>
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: "var(--rs)",
                  overflow: "hidden",
                  marginBottom: 10,
                }}
              >
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr 1fr",
                    padding: "6px 12px",
                    background: "var(--bg)",
                    gap: 6,
                  }}
                >
                  <span className="mthl">Date</span>
                  <span className="mthl">Meal Type</span>
                  <span className="mthl">Description</span>
                  <span className="mthl">Calories</span>
                </div>
                {loggedData.meals.slice(0, 15).map((m, i) => (
                  <div
                    key={m.id || i}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr 1fr",
                      padding: "6px 12px",
                      borderTop: "1px solid var(--border)",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    <span>{fmtDate(m.log_date || m.meal_date)}</span>
                    <span style={{ fontWeight: 600 }}>{m.meal_type || "—"}</span>
                    <span style={{ color: "var(--t2)" }}>
                      {m.description || m.food_items || "—"}
                    </span>
                    <span style={{ color: "var(--t3)" }}>
                      {m.calories ? `${m.calories} kcal` : "—"}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Activity warning */}
          {hasAny && (
            <div className="noticebar amb">
              <span>⚠️</span>
              <span className="ni amb">
                {avgSteps > 0
                  ? `Patient averaging ${avgSteps.toLocaleString()} steps (target 10,000). Encourage daily activity.`
                  : "Review patient logged data for trends. Encourage consistent logging."}
              </span>
            </div>
          )}

          {!hasAny && (
            <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
              No logged data from the patient app yet
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default VisitLoggedData;
