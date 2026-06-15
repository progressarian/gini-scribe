import { useMemo, useState } from "react";
import { useFlowReports } from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

const iso = (d) => d.toISOString().split("T")[0];
function rangeFor(preset) {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  if (preset === "week") start.setDate(now.getDate() - now.getDay());
  else if (preset === "last_week") {
    start.setDate(now.getDate() - now.getDay() - 7);
    end.setDate(now.getDate() - now.getDay() - 1);
  } else if (preset === "month") start.setDate(1);
  else if (preset === "today") {
    /* same day */
  }
  return { start: iso(start), end: iso(end) };
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

export default function FlowReportsPage() {
  const [preset, setPreset] = useState("week");
  const { start, end } = useMemo(() => rangeFor(preset), [preset]);
  const { data, isLoading } = useFlowReports(start, end);

  const s = data?.summary || {};
  const compliance = data?.compliance || [];
  const bottlenecks = data?.bottlenecks || [];
  const daily = data?.daily || [];
  const compliancePct = pct(s.completed - s.breached, s.completed);
  const breachRate = pct(s.breached, s.completed);
  const topBn = bottlenecks[0];
  const topOver = topBn ? Number(topBn.avg_actual) - Number(topBn.avg_budget) : 0;

  // Rule-based recommendations from the period's data.
  const recs = [];
  if (topBn && topOver > 3)
    recs.push(
      `"${topBn.step_name}" is the #1 bottleneck — avg +${topOver.toFixed(1)} min over budget. Add capacity or rebalance load here.`,
    );
  compliance.forEach((c) => {
    const p = pct(c.within_target, c.total);
    if (c.total >= 2 && p < 70)
      recs.push(
        `${c.label} compliance is low (${p}%) — review the ≤${c.max_time_min}m target or process.`,
      );
  });
  if (breachRate > 15)
    recs.push(`Overall breach rate is ${breachRate}% — focus on the top bottlenecks above.`);
  if (!recs.length && s.total_visits)
    recs.push("All key metrics are within target this period. 👍");

  return (
    <div className="flow-root">
      <div className="flow-wrap">
        <div className="flow-header">
          <div>
            <div className="flow-title">📊 Wait-Time Reports & Bottlenecks</div>
            <div className="flow-sub">
              Benchmark compliance · step duration trends · {start} → {end}
            </div>
          </div>
          <div className="flow-header-right">
            <div className="flow-field" style={{ minWidth: 150 }}>
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                <option value="today">Today</option>
                <option value="week">This week</option>
                <option value="last_week">Last week</option>
                <option value="month">This month</option>
              </select>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="flow-card flow-empty">Loading…</div>
        ) : !s.total_visits ? (
          <div className="flow-card flow-empty">No completed visits in this range yet.</div>
        ) : (
          <>
            {/* Summary */}
            <div className="flow-stats">
              <div className="flow-stat">
                <div className="flow-stat-val">{s.total_visits}</div>
                <div className="flow-stat-lbl">Total visits</div>
              </div>
              <div className="flow-stat" style={{ borderColor: "var(--fgn)" }}>
                <div className="flow-stat-val f-grn">{compliancePct}%</div>
                <div className="flow-stat-lbl">Within benchmark</div>
                <div className="flow-stat-sub">
                  {s.completed - s.breached}/{s.completed} completed
                </div>
              </div>
              <div
                className="flow-stat"
                style={{ borderColor: "var(--fre)", background: "var(--frel)" }}
              >
                <div className="flow-stat-val f-red">{s.breached}</div>
                <div className="flow-stat-lbl">Breached</div>
              </div>
              <div className="flow-stat">
                <div className="flow-stat-val">{s.avg_visit_min ?? "—"}</div>
                <div className="flow-stat-lbl">Avg visit (min)</div>
              </div>
              <div className="flow-stat" style={{ borderColor: "var(--fam)" }}>
                <div className="flow-stat-val f-amb" style={{ fontSize: 18 }}>
                  {topBn ? `+${topOver.toFixed(1)}m` : "—"}
                </div>
                <div className="flow-stat-lbl">Top bottleneck</div>
                <div className="flow-stat-sub">{topBn ? topBn.step_name : "none"}</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {/* Compliance by type */}
              <div className="flow-card">
                <div className="flow-sec-title">Compliance by patient type</div>
                {compliance.length === 0 && <div className="flow-muted">No data.</div>}
                {compliance.map((c) => {
                  const p = pct(c.within_target, c.total);
                  const col = p >= 85 ? "var(--fgn)" : p >= 70 ? "var(--fam)" : "var(--fre)";
                  return (
                    <div
                      key={c.visit_type_id}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0" }}
                    >
                      <span style={{ width: 150, fontWeight: 600, fontSize: 12 }}>
                        {c.label} <span className="flow-muted">(≤{c.max_time_min}m)</span>
                      </span>
                      <div
                        style={{
                          flex: 1,
                          height: 18,
                          background: "var(--fbd)",
                          borderRadius: 3,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            width: `${p}%`,
                            background: col,
                            display: "flex",
                            alignItems: "center",
                            paddingLeft: 6,
                            fontSize: 9,
                            fontWeight: 700,
                            color: "#fff",
                          }}
                        >
                          {p}%
                        </div>
                      </div>
                      <span
                        style={{
                          width: 52,
                          textAlign: "right",
                          fontSize: 12,
                          color: col,
                          fontWeight: 600,
                        }}
                      >
                        {c.within_target}/{c.total}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Bottlenecks */}
              <div className="flow-card">
                <div className="flow-sec-title">
                  Top bottlenecks{" "}
                  <span className="flow-muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                    steps over budget
                  </span>
                </div>
                {bottlenecks.length === 0 && (
                  <div className="flow-muted">No completed steps yet.</div>
                )}
                {bottlenecks.slice(0, 6).map((b) => {
                  const over = (Number(b.avg_actual) - Number(b.avg_budget)).toFixed(1);
                  const isOver = over > 0;
                  const bg = over > 5 ? "var(--frel)" : isOver ? "var(--faml)" : "var(--fgnl)";
                  const bd = over > 5 ? "var(--fre)" : isOver ? "var(--fam)" : "var(--fgn)";
                  return (
                    <div
                      key={b.step_name}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "8px 10px",
                        borderRadius: 6,
                        background: bg,
                        border: `1px solid ${bd}`,
                        marginBottom: 6,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 12 }}>{b.step_name}</div>
                        <div style={{ fontSize: 10, color: bd }}>
                          Budget {b.avg_budget}m · actual {b.avg_actual}m · over in{" "}
                          {b.exceeded_count}/{b.total_count}
                        </div>
                      </div>
                      <div style={{ fontSize: 18, fontWeight: 600, color: bd }}>
                        {isOver ? `+${over}m` : "✓"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Daily breakdown */}
            <div className="flow-card" style={{ marginTop: 14 }}>
              <div className="flow-sec-title">Daily breakdown</div>
              {daily.length === 0 ? (
                <div className="flow-muted">No daily data.</div>
              ) : (
                <table className="flow-table" style={{ border: "none" }}>
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Patients</th>
                      <th>Avg visit</th>
                      <th>Compliance</th>
                      <th>Breaches</th>
                      <th>Worst breach</th>
                    </tr>
                  </thead>
                  <tbody>
                    {daily.map((d) => {
                      const p = pct(d.within_target, d.completed);
                      const cls = p >= 85 ? "fb-grn" : p >= 70 ? "fb-amb" : "fb-red";
                      return (
                        <tr key={d.day}>
                          <td style={{ fontWeight: 700 }}>
                            {new Date(d.day).toLocaleDateString("en-IN", {
                              weekday: "short",
                              day: "numeric",
                              month: "short",
                            })}
                          </td>
                          <td>{d.patients}</td>
                          <td>{d.avg_visit_min ?? "—"} min</td>
                          <td>
                            <span className={`flow-badge ${cls}`}>
                              {d.completed ? `${p}%` : "—"}
                            </span>
                          </td>
                          <td style={{ color: d.breaches ? "var(--fre)" : "inherit" }}>
                            {d.breaches}
                          </td>
                          <td className="flow-muted">
                            {d.worst_breach
                              ? `${d.worst_breach.patient_name} — ${d.worst_breach.mins}/${d.worst_breach.max_time_min}m`
                              : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Recommendations */}
            {recs.length > 0 && (
              <div className="flow-alert flow-alert-amb" style={{ marginTop: 14 }}>
                <span style={{ fontSize: 16 }}>💡</span>
                <div>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    Recommendations for {start} → {end}
                  </div>
                  <div style={{ lineHeight: 1.7 }}>
                    {recs.map((r, i) => (
                      <div key={i}>
                        {i + 1}. {r}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
