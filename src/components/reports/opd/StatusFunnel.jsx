import { Link } from "react-router-dom";
import { SERIES } from "../../crm/progress/progressText";
import { count, shareOf } from "../../billing/dashboard/dashboardText";
import { OPD_DEFINITIONS } from "../../../../shared/opdMetrics.js";
import { visitsHref } from "./opdFilters";

export default function StatusFunnel({ data, filters, back }) {
  const t = data.totals;
  const steps = [
    { state: "booked", label: "Booked", value: t.booked, color: SERIES[3] },
    { state: "came", label: "Came", value: t.came, color: SERIES[0], hint: OPD_DEFINITIONS.came },
    {
      state: "completed",
      label: "Completed",
      value: t.completed,
      color: SERIES[2],
      hint: OPD_DEFINITIONS.completed,
    },
  ];
  const sides = [
    {
      state: "did_not_come",
      label: "Did not come",
      value: t.didNotCome,
      hint: OPD_DEFINITIONS.did_not_come,
    },
    {
      state: "not_updated",
      label: "Not updated",
      value: t.notUpdated,
      hint: OPD_DEFINITIONS.not_updated,
    },
    {
      state: "not_closed",
      label: "Not closed",
      value: t.notClosed,
      hint: OPD_DEFINITIONS.not_closed,
    },
    ...(data.includesToday
      ? [
          {
            state: "in_progress",
            label: "In progress",
            value: t.inProgress,
            hint: OPD_DEFINITIONS.in_progress,
          },
          { state: "pending", label: "Pending", value: t.pending, hint: OPD_DEFINITIONS.pending },
        ]
      : []),
  ];
  return (
    <section className="flow-card bdash-card" aria-labelledby="opd-funnel">
      <div className="fset__cardhead">
        <h2 id="opd-funnel" className="flow-sec-title">
          From booked to completed
        </h2>
      </div>
      <div className="fset__cardsub">
        How many booked appointments came and were completed. Click any number to list its patients.
      </div>
      <ol className="opd-funnel">
        {steps.map((step) => (
          <li key={step.state}>
            <Link
              to={visitsHref(filters, { state: step.state })}
              state={{ back }}
              title={step.hint}
            >
              <span className="opd-funnel__label">{step.label}</span>
              <span className="opd-funnel__track">
                <span
                  className="opd-funnel__bar"
                  style={{
                    width: `${t.booked ? (100 * step.value) / t.booked : 0}%`,
                    background: step.color,
                  }}
                />
              </span>
              <strong>{count(step.value)}</strong>
              <span className="bdash-muted">{shareOf(step.value, t.booked)}</span>
            </Link>
          </li>
        ))}
      </ol>
      <ul className="opd-sides">
        {sides.map((side) => (
          <li key={side.state}>
            <Link
              to={visitsHref(filters, { state: side.state })}
              state={{ back }}
              title={side.hint}
            >
              <strong>{count(side.value)}</strong> {side.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
