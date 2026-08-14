import { useMemo, useState } from "react";
import { useFlowReports } from "../../queries/hooks/useFlow";
import "../../styles/flow.css";

// Local calendar date, NOT toISOString() — that converts to UTC first, so any
// IST time before 05:30 would report the previous day and "Today" would load
// yesterday's visits.
const iso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7", label: "Last 7 days" },
  { value: "last_30", label: "Last 30 days" },
  { value: "week", label: "This week" },
  { value: "last_week", label: "Last week" },
  { value: "month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom date / range…" },
];

function rangeFor(preset) {
  const now = new Date();
  const end = new Date(now);
  const start = new Date(now);
  if (preset === "week") start.setDate(now.getDate() - now.getDay());
  else if (preset === "last_week") {
    start.setDate(now.getDate() - now.getDay() - 7);
    end.setDate(now.getDate() - now.getDay() - 1);
  } else if (preset === "month") start.setDate(1);
  else if (preset === "last_month") {
    start.setMonth(now.getMonth() - 1, 1);
    end.setMonth(now.getMonth(), 0); // day 0 of this month = last day of previous
  } else if (preset === "yesterday") {
    start.setDate(now.getDate() - 1);
    end.setDate(now.getDate() - 1);
  } else if (preset === "last_7") start.setDate(now.getDate() - 6);
  else if (preset === "last_30") start.setDate(now.getDate() - 29);
  else if (preset === "today") {
    /* same day */
  }
  return { start: iso(start), end: iso(end) };
}

// Human-readable range for the header — collapses to a single date when the
// range is one day, which is the common "show me that Tuesday" case.
function rangeLabel(start, end) {
  const fmt = (s) =>
    new Date(s + "T00:00:00").toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  return start === end ? fmt(start) : `${fmt(start)} → ${fmt(end)}`;
}

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

// "120" → "2 hr", "90" → "1 hr 30 min", "45" → "45 min". Minutes-only targets
// read as arithmetic ("≤120m"); hours read as a promise a person can picture.
const durationLabel = (min) => {
  const m = Number(min) || 0;
  return `${m} min`;
};
// One definition of "good / borderline / poor" for compliance, shared by the
// headline stat, the per-type bars and the daily table. The headline used to
// be hardcoded green, so 62% compliance rendered green at the top of the page
// and red in the breakdown directly below it.
const BENCH_GOOD = 85;
const BENCH_WARN = 70;
const benchColor = (p) =>
  p >= BENCH_GOOD ? "var(--fgn)" : p >= BENCH_WARN ? "var(--fam)" : "var(--fre)";
const benchTint = (p) =>
  p >= BENCH_GOOD ? "var(--fgnl)" : p >= BENCH_WARN ? "var(--faml)" : "var(--frel)";
const benchBadge = (p) => (p >= BENCH_GOOD ? "fb-grn" : p >= BENCH_WARN ? "fb-amb" : "fb-red");

// A step needs at least this many completed cases before its timing means
// anything. Without the floor, a single click-through (n=1, median = that one
// value) ranks alongside a step measured over hundreds of patients.
const MIN_CASES = 5;

// Timing figures for one bottleneck row, rounded the way they are displayed so
// the ranking, the recommendation and the row can never disagree by a decimal.
const stepTiming = (b) => {
  const planned = Math.round(Number(b.avg_budget));
  const mean = Number(b.avg_actual);
  const med = b.median_actual == null ? null : Number(b.median_actual);
  const typical = Math.round(med != null ? med : mean);
  return { planned, mean, med, typical, extra: typical - planned };
};

export default function FlowReportsPage() {
  const today = iso(new Date());
  const [preset, setPreset] = useState("week");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);

  const { start, end } = useMemo(() => {
    if (preset !== "custom") return rangeFor(preset);
    // Tolerate a reversed pair rather than querying an empty window — someone
    // picking the end date first shouldn't get "no visits".
    const a = customStart || today;
    const b = customEnd || a;
    return a <= b ? { start: a, end: b } : { start: b, end: a };
  }, [preset, customStart, customEnd, today]);

  const { data, isLoading } = useFlowReports(start, end);

  // Inclusive span, so a single date reads "1 day" rather than "0 days".
  const dayCount = useMemo(() => {
    const ms = new Date(end + "T00:00:00") - new Date(start + "T00:00:00");
    return Math.max(1, Math.round(ms / 86400000) + 1);
  }, [start, end]);

  const s = data?.summary || {};
  const compliance = data?.compliance || [];
  const bottlenecks = data?.bottlenecks || [];
  const daily = data?.daily || [];
  const compliancePct = pct(s.completed - s.breached, s.completed);
  const breachRate = pct(s.breached, s.completed);
  // Bottlenecks arrive sorted by (median − budget). Drop steps with too few
  // cases to be evidence, then keep only those actually over budget — the
  // card used to pad to six rows regardless, so within-budget steps appeared
  // as "bottleneck #3". The headline tile and the recommendation read from
  // this same list so they can never name a step the card doesn't show.
  const { rankedBn, withinBudget, lowData } = useMemo(() => {
    const enough = bottlenecks.filter((b) => Number(b.total_count) >= MIN_CASES);
    const over = enough.filter((b) => stepTiming(b).extra > 0);
    return {
      rankedBn: over,
      withinBudget: enough.length - over.length,
      lowData: bottlenecks.length - enough.length,
    };
  }, [bottlenecks]);
  const topBn = rankedBn[0];
  const topOver = topBn ? stepTiming(topBn).extra : 0;

  // Rule-based recommendations from the period's data.
  const recs = [];
  if (topBn && topOver > 3)
    recs.push(
      `"${topBn.step_name}" is the #1 bottleneck — the typical case runs +${topOver} min over budget. Add capacity or rebalance load here.`,
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
              Benchmark compliance · step duration trends · {rangeLabel(start, end)}
            </div>
          </div>
          <div className="flow-toolbar">
            <select
              className="flow-select"
              value={preset}
              onChange={(e) => setPreset(e.target.value)}
              aria-label="Reporting period"
            >
              {PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>

            {preset === "custom" && (
              <div className="flow-daterange">
                <input
                  type="date"
                  value={customStart}
                  max={today}
                  aria-label="From date"
                  onChange={(e) => setCustomStart(e.target.value)}
                />
                <span className="flow-daterange-sep" aria-hidden>
                  →
                </span>
                <input
                  type="date"
                  value={customEnd}
                  max={today}
                  aria-label="To date"
                  onChange={(e) => setCustomEnd(e.target.value)}
                />
              </div>
            )}

            <span className="flow-daybadge">
              {dayCount} day{dayCount === 1 ? "" : "s"}
            </span>

            {/* Only offered when it would actually change something — a
                permanently-disabled button is just noise in the header. */}
            {preset === "custom" && start !== end && (
              <button
                type="button"
                className="flow-btn-mini"
                onClick={() => setCustomEnd(customStart)}
                title="Narrow to the From date only"
              >
                Single day
              </button>
            )}
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
              <div
                className="flow-stat"
                style={{
                  borderColor: benchColor(compliancePct),
                  background: benchTint(compliancePct),
                }}
              >
                <div className="flow-stat-val" style={{ color: benchColor(compliancePct) }}>
                  {compliancePct}%
                </div>
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
                  {topBn ? `+${topOver}m` : "—"}
                </div>
                <div className="flow-stat-lbl">Top bottleneck (typical)</div>
                <div className="flow-stat-sub">{topBn ? topBn.step_name : "none"}</div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              {/* Compliance by type — same plain-language row as the
                  bottleneck card, see .fbn-* in flow.css */}
              <div className="flow-card">
                <div className="flow-sec-title">Did visits finish on time?</div>
                <div
                  style={{ fontSize: 11, color: "var(--fink3)", marginTop: -6, marginBottom: 10 }}
                >
                  Share of patients whose <strong>whole visit</strong> — arrival to finish — fitted
                  inside the time promised for their appointment type.
                </div>
                {compliance.length === 0 && <div className="flow-muted">No data.</div>}
                {[...compliance]
                  // Worst first, matching the bottleneck card. The API returns
                  // these ordered by target length, which buries the problem.
                  .sort((a, b) => pct(a.within_target, a.total) - pct(b.within_target, b.total))
                  .map((c) => {
                    const p = pct(c.within_target, c.total);
                    const late = c.total - c.within_target;
                    const tone = benchColor(p);
                    const tint = benchTint(p);
                    const verdict =
                      p >= BENCH_GOOD
                        ? "on target"
                        : p >= BENCH_WARN
                          ? "slightly behind"
                          : "needs attention";
                    return (
                      <div
                        key={c.visit_type_id}
                        className="fbn-row"
                        style={{ background: tint, borderColor: tone }}
                      >
                        <div className="fbn-rank" style={{ background: tone }}>
                          {p >= BENCH_GOOD ? "✓" : "!"}
                        </div>
                        <div className="fbn-body">
                          <div className="fbn-head">
                            <span className="fbn-name">{c.label}</span>
                            <span className="fbn-verdict" style={{ color: tone }}>
                              {verdict}
                            </span>
                          </div>
                          <div className="fbn-bar-row">
                            <span className="fbn-bar-lbl">On time</span>
                            <div className="fbn-track">
                              <div
                                className="fbn-fill"
                                style={{ width: `${p}%`, background: tone }}
                              />
                            </div>
                            <span className="fbn-bar-val" style={{ color: tone }}>
                              {p}%
                            </span>
                          </div>
                          <div className="fbn-foot">
                            {c.within_target} of {c.total} patients finished within the{" "}
                            {durationLabel(c.max_time_min)} promised for this type.
                          </div>
                        </div>
                        <div className="fbn-extra" style={{ color: tone }}>
                          {late > 0 ? (
                            <>
                              <span className="fbn-extra-num">{late}</span>
                              <span className="fbn-extra-unit">RAN LATE</span>
                            </>
                          ) : (
                            <span className="fbn-extra-num">✓</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Bottlenecks — plain-language rows, see .fbn-* in flow.css */}
              <div className="flow-card">
                <div className="flow-sec-title">Where the time goes</div>
                <div
                  style={{ fontSize: 11, color: "var(--fink3)", marginTop: -6, marginBottom: 10 }}
                >
                  Steps that take a <strong>typical patient</strong> longer than the time planned
                  for them. Worst first.
                </div>
                {bottlenecks.length === 0 ? (
                  <div className="flow-muted">No completed steps yet.</div>
                ) : rankedBn.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--fgn)", padding: "6px 0" }}>
                    ✓ No step runs over budget for a typical patient.
                  </div>
                ) : (
                  rankedBn.slice(0, 6).map((b, i) => {
                    const { planned, mean, med, typical, extra } = stepTiming(b);
                    const times = planned > 0 ? typical / planned : 0;
                    const overPct = pct(b.exceeded_count, b.total_count);
                    // Every row here is over budget, so the only question is
                    // how badly: >5 min over is red, anything less is amber.
                    const tone = extra > 5 ? "var(--fre)" : "var(--fam)";
                    const tint = extra > 5 ? "var(--frel)" : "var(--faml)";
                    const skewed = med != null && mean > med * 1.5;
                    const rowScale = Math.max(planned, typical, 1);
                    return (
                      <div
                        key={b.step_name}
                        className="fbn-row"
                        style={{ background: tint, borderColor: tone }}
                      >
                        <div className="fbn-rank" style={{ background: tone }}>
                          {i + 1}
                        </div>
                        <div className="fbn-body">
                          <div className="fbn-head">
                            <span className="fbn-name">{b.step_name}</span>
                            <span className="fbn-verdict" style={{ color: tone }}>
                              {times >= 10 ? Math.round(times) : times.toFixed(1)}× longer than
                              planned
                            </span>
                          </div>
                          <div className="fbn-bar-row">
                            <span className="fbn-bar-lbl">Planned</span>
                            <div className="fbn-track">
                              <div
                                className="fbn-fill fbn-fill-plan"
                                style={{ width: `${(planned / rowScale) * 100}%` }}
                              />
                            </div>
                            <span className="fbn-bar-val">{planned} min</span>
                          </div>
                          <div className="fbn-bar-row">
                            <span className="fbn-bar-lbl">Actual</span>
                            <div className="fbn-track">
                              <div
                                className="fbn-fill"
                                style={{
                                  width: `${(typical / rowScale) * 100}%`,
                                  background: tone,
                                }}
                              />
                            </div>
                            <span className="fbn-bar-val" style={{ color: tone }}>
                              {typical} min
                            </span>
                          </div>
                          <div className="fbn-foot">
                            {overPct}% of patients ({b.exceeded_count} of {b.total_count}) took
                            longer than planned here.
                            {skewed &&
                              ` A few very long cases drag the average up to ${Math.round(mean)} min.`}
                          </div>
                        </div>
                        <div className="fbn-extra" style={{ color: tone }}>
                          <span className="fbn-extra-num">+{extra}</span>
                          <span className="fbn-extra-unit">MIN EXTRA</span>
                        </div>
                      </div>
                    );
                  })
                )}
                {/* Never silently truncate: say what was left out and why. */}
                {(withinBudget > 0 || lowData > 0) && (
                  <div style={{ fontSize: 10, color: "var(--fink3)", marginTop: 9 }}>
                    {withinBudget > 0 &&
                      `${withinBudget} other step${withinBudget === 1 ? "" : "s"} finished within the planned time.`}
                    {withinBudget > 0 && lowData > 0 && " "}
                    {lowData > 0 &&
                      `${lowData} step${lowData === 1 ? "" : "s"} not shown — fewer than ${MIN_CASES} completed cases, too few to judge.`}
                  </div>
                )}
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
                      const cls = benchBadge(p);
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
                    Recommendations for {rangeLabel(start, end)}
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
