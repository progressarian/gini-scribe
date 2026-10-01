import { useMemo, useState } from "react";
import { useGiniflowReports } from "../../queries/hooks/useGiniflowBoard";
import "../../styles/giniflow-station.css";
import "./FlowReportsPage.css";

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
    end.setMonth(now.getMonth(), 0);
  } else if (preset === "yesterday") {
    start.setDate(now.getDate() - 1);
    end.setDate(now.getDate() - 1);
  } else if (preset === "last_7") start.setDate(now.getDate() - 6);
  else if (preset === "last_30") start.setDate(now.getDate() - 29);
  return { start: iso(start), end: iso(end) };
}

const dayText = (ymd, options) => new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", options);

const rangeLabel = (start, end) => {
  const full = { day: "numeric", month: "short", year: "numeric" };
  return start === end ? dayText(start, full) : `${dayText(start, full)} → ${dayText(end, full)}`;
};

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

const BENCH_GOOD = 85;
const BENCH_WARN = 70;
const toneOf = (p) => (p >= BENCH_GOOD ? "good" : p >= BENCH_WARN ? "warn" : "bad");
const verdictOf = (p) =>
  p >= BENCH_GOOD ? "On target" : p >= BENCH_WARN ? "Slightly behind" : "Needs attention";

const MIN_CASES = 5;

const stepTiming = (b) => {
  const planned = Math.round(Number(b.avg_budget));
  const mean = Number(b.avg_actual);
  const med = b.median_actual == null ? null : Number(b.median_actual);
  const typical = Math.round(med != null ? med : mean);
  return { planned, mean, med, typical, extra: typical - planned };
};

function recommendationsOf({ summary, compliance, topStep, breachRate }) {
  const recs = [];
  const topOver = topStep ? stepTiming(topStep).extra : 0;
  if (topStep && topOver > 3)
    recs.push(
      `"${topStep.step_name}" is the #1 bottleneck — a typical patient spends ${topOver} min longer than planned here. Add capacity or rebalance load.`,
    );
  for (const c of compliance) {
    const p = pct(c.within_target, c.total);
    if (c.total >= 2 && p < BENCH_WARN)
      recs.push(
        `${c.label}: only ${p}% finished within the ${c.max_time_min} min journey target — review the target or the process.`,
      );
  }
  if (breachRate > 15)
    recs.push(
      `Overall ${breachRate}% of visits ran over target — start with the top stations above.`,
    );
  if (!recs.length && summary.total_visits)
    recs.push("All key measures are within target for this period.");
  return recs;
}

function Bar({ value, max, tone, label }) {
  const width = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="frp-bar">
      <span className="frp-bar__lbl">{label}</span>
      <span className="frp-bar__track" aria-hidden="true">
        <span className={`frp-bar__fill frp-bar__fill--${tone}`} style={{ width: `${width}%` }} />
      </span>
    </div>
  );
}

function OnTimeCard({ compliance, target }) {
  const rows = [...compliance].sort(
    (a, b) => pct(a.within_target, a.total) - pct(b.within_target, b.total),
  );
  return (
    <section className="frp-card" aria-labelledby="frp-ontime">
      <h2 id="frp-ontime" className="frp-card__title">
        Did visits finish on time?
      </h2>
      <p className="frp-card__hint">
        Share of patients whose whole visit — check-in to exit — fitted inside the
        {target ? ` ${target} min` : ""} journey target, by appointment type.
      </p>
      {!rows.length && <p className="frp-empty">No finished visits in this range.</p>}
      <ul className="frp-rows">
        {rows.map((c) => {
          const p = pct(c.within_target, c.total);
          const tone = toneOf(p);
          const late = c.total - c.within_target;
          return (
            <li key={c.visit_type_id} className={`frp-row frp-row--${tone}`}>
              <div className="frp-row__head">
                <span className="frp-row__name">{c.label}</span>
                <span className="frp-row__verdict">{verdictOf(p)}</span>
                <span className="frp-row__big">{p}%</span>
              </div>
              <Bar value={p} max={100} tone={tone} label="On time" />
              <p className="frp-row__foot">
                {c.within_target} of {c.total} patients finished within {c.max_time_min} min
                {late > 0 ? ` · ${late} ran late` : ""}.
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TimeCard({ bottlenecks, ranked, withinBudget, lowData }) {
  return (
    <section className="frp-card" aria-labelledby="frp-time">
      <h2 id="frp-time" className="frp-card__title">
        Where the time goes
      </h2>
      <p className="frp-card__hint">
        Stations where a typical patient spends longer than the time budget set in ⚙ Time budgets.
        Worst first.
      </p>
      {!bottlenecks.length ? (
        <p className="frp-empty">No completed station steps in this range.</p>
      ) : !ranked.length ? (
        <p className="frp-ok">No station runs over budget for a typical patient.</p>
      ) : (
        <ol className="frp-rows">
          {ranked.slice(0, 6).map((b, index) => {
            const { planned, mean, med, typical, extra } = stepTiming(b);
            const tone = extra > 5 ? "bad" : "warn";
            const scale = Math.max(planned, typical, 1);
            const skewed = med != null && mean > med * 1.5;
            return (
              <li key={b.station} className={`frp-row frp-row--${tone}`}>
                <div className="frp-row__head">
                  <span className="frp-row__rank">{index + 1}</span>
                  <span className="frp-row__name">{b.step_name}</span>
                  <span className="frp-row__big">+{extra} min</span>
                </div>
                <Bar value={planned} max={scale} tone="plan" label={`Planned ${planned} min`} />
                <Bar value={typical} max={scale} tone={tone} label={`Typical ${typical} min`} />
                <p className="frp-row__foot">
                  {pct(b.exceeded_count, b.total_count)}% of patients ({b.exceeded_count} of{" "}
                  {b.total_count}) took longer than planned.
                  {skewed &&
                    ` A few very long cases pull the average up to ${Math.round(mean)} min.`}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {(withinBudget > 0 || lowData > 0) && (
        <p className="frp-card__hint frp-card__hint--foot">
          {withinBudget > 0 &&
            `${withinBudget} other station${withinBudget === 1 ? "" : "s"} stayed within budget.`}
          {withinBudget > 0 && lowData > 0 && " "}
          {lowData > 0 &&
            `${lowData} station${lowData === 1 ? "" : "s"} not shown — fewer than ${MIN_CASES} completed cases, too few to judge.`}
        </p>
      )}
    </section>
  );
}

function DailyCard({ daily }) {
  return (
    <section className="frp-card" aria-labelledby="frp-daily">
      <h2 id="frp-daily" className="frp-card__title">
        Daily breakdown
      </h2>
      {!daily.length ? (
        <p className="frp-empty">No visits in this range.</p>
      ) : (
        <div className="frp-tablewrap">
          <table className="frp-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" className="frp-num">
                  Patients
                </th>
                <th scope="col" className="frp-num">
                  Finished
                </th>
                <th scope="col" className="frp-num">
                  Avg visit
                </th>
                <th scope="col">On time</th>
                <th scope="col" className="frp-num">
                  Over target
                </th>
                <th scope="col">Longest over target</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => {
                const p = pct(d.within_target, d.completed);
                return (
                  <tr key={d.day}>
                    <th scope="row">
                      {dayText(d.day, { weekday: "short", day: "numeric", month: "short" })}
                    </th>
                    <td className="frp-num">{d.patients}</td>
                    <td className="frp-num">{d.completed}</td>
                    <td className="frp-num">
                      {d.avg_visit_min == null ? "—" : `${d.avg_visit_min} min`}
                    </td>
                    <td>
                      {d.completed ? (
                        <span className={`frp-pill frp-pill--${toneOf(p)}`}>{p}%</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="frp-num">{d.breaches}</td>
                    <td className="frp-muted">
                      {d.worst_breach
                        ? `${d.worst_breach.patient_name} — ${d.worst_breach.mins} of ${d.worst_breach.max_time_min} min`
                        : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function FlowReportsPage() {
  const today = iso(new Date());
  const [preset, setPreset] = useState("today");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);

  const { start, end } = useMemo(() => {
    if (preset !== "custom") return rangeFor(preset);
    const a = customStart || today;
    const b = customEnd || a;
    return a <= b ? { start: a, end: b } : { start: b, end: a };
  }, [preset, customStart, customEnd, today]);

  const dayCount = useMemo(() => {
    const ms = new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`);
    return Math.max(1, Math.round(ms / 86400000) + 1);
  }, [start, end]);
  const tooLong = dayCount > 92;

  const { data, isLoading, isError, refetch, isFetching } = useGiniflowReports(
    tooLong ? null : start,
    tooLong ? null : end,
  );

  const summary = data?.summary || {};
  const compliance = data?.compliance || [];
  const bottlenecks = data?.bottlenecks || [];
  const daily = data?.daily || [];
  const target = data?.journey_target_min ?? null;
  const onTimePct = pct(summary.completed - summary.breached, summary.completed);
  const breachRate = pct(summary.breached, summary.completed);

  const { ranked, withinBudget, lowData } = useMemo(() => {
    const enough = bottlenecks.filter((b) => Number(b.total_count) >= MIN_CASES);
    const over = enough.filter((b) => stepTiming(b).extra > 0);
    return {
      ranked: over,
      withinBudget: enough.length - over.length,
      lowData: bottlenecks.length - enough.length,
    };
  }, [bottlenecks]);
  const topStep = ranked[0];
  const recs = recommendationsOf({ summary, compliance, topStep, breachRate });

  return (
    <div className="gf">
      <div className="top-rail">
        <div className="tr-logo">Gini Flow</div>
        <div className="tr-role" style={{ background: "var(--tl-l)", color: "var(--tl)" }}>
          📊 Reports
        </div>
        <div className="rail-right">
          <a className="tr-back" href="/giniflow/manager">
            ← Flow board
          </a>
        </div>
      </div>

      <main className="frp">
        <header className="frp-head">
          <div>
            <h1 className="frp-title">Wait times &amp; bottlenecks</h1>
            <p className="frp-sub">
              {rangeLabel(start, end)} · {dayCount} day{dayCount === 1 ? "" : "s"}
              {isFetching && !isLoading ? " · updating…" : ""}
            </p>
          </div>
          <div className="frp-filters">
            <label className="frp-field">
              <span>Period</span>
              <select value={preset} onChange={(e) => setPreset(e.target.value)}>
                {PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {preset === "custom" && (
              <>
                <label className="frp-field">
                  <span>From</span>
                  <input
                    type="date"
                    value={customStart}
                    max={today}
                    onChange={(e) => setCustomStart(e.target.value)}
                  />
                </label>
                <label className="frp-field">
                  <span>To</span>
                  <input
                    type="date"
                    value={customEnd}
                    max={today}
                    onChange={(e) => setCustomEnd(e.target.value)}
                  />
                </label>
              </>
            )}
          </div>
        </header>

        {tooLong ? (
          <div className="frp-card frp-state">Choose a range of 92 days or fewer.</div>
        ) : isLoading ? (
          <div className="frp-card frp-state">Loading report…</div>
        ) : isError ? (
          <div className="frp-card frp-state">
            <p>Couldn&apos;t load the report.</p>
            <button type="button" className="frp-retry" onClick={() => refetch()}>
              Try again
            </button>
          </div>
        ) : !summary.total_visits ? (
          <div className="frp-card frp-state">
            <p>No checked-in patients in {rangeLabel(start, end)}.</p>
            <p className="frp-muted">Pick another period to see its report.</p>
          </div>
        ) : (
          <>
            <section className="frp-tiles" aria-label="Summary">
              <div className="frp-tile">
                <span className="frp-tile__val">{summary.total_visits}</span>
                <span className="frp-tile__lbl">Patients checked in</span>
                <span className="frp-tile__sub">{summary.completed} finished their visit</span>
              </div>
              <div className={`frp-tile frp-tile--${toneOf(onTimePct)}`}>
                <span className="frp-tile__val">{summary.completed ? `${onTimePct}%` : "—"}</span>
                <span className="frp-tile__lbl">Finished on time</span>
                <span className="frp-tile__sub">
                  {summary.completed - summary.breached} of {summary.completed}
                  {target ? ` within ${target} min` : ""}
                </span>
              </div>
              <div className="frp-tile frp-tile--bad">
                <span className="frp-tile__val">{summary.breached}</span>
                <span className="frp-tile__lbl">Over journey target</span>
              </div>
              <div className="frp-tile">
                <span className="frp-tile__val">
                  {summary.avg_visit_min == null ? "—" : `${summary.avg_visit_min} min`}
                </span>
                <span className="frp-tile__lbl">Average visit</span>
                <span className="frp-tile__sub">check-in to exit</span>
              </div>
              <div className="frp-tile frp-tile--warn">
                <span className="frp-tile__val">
                  {topStep ? `+${stepTiming(topStep).extra} min` : "—"}
                </span>
                <span className="frp-tile__lbl">Top bottleneck</span>
                <span className="frp-tile__sub">{topStep ? topStep.step_name : "none"}</span>
              </div>
            </section>

            <div className="frp-grid">
              <OnTimeCard compliance={compliance} target={target} />
              <TimeCard
                bottlenecks={bottlenecks}
                ranked={ranked}
                withinBudget={withinBudget}
                lowData={lowData}
              />
            </div>

            <DailyCard daily={daily} />

            {recs.length > 0 && (
              <section className="frp-card frp-recs" aria-labelledby="frp-recs">
                <h2 id="frp-recs" className="frp-card__title">
                  Recommendations for {rangeLabel(start, end)}
                </h2>
                <ol>
                  {recs.map((rec) => (
                    <li key={rec}>{rec}</li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
