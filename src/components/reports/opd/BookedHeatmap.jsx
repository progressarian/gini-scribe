import { Link } from "react-router-dom";
import { count } from "../../billing/dashboard/dashboardText";
import { OPD_DEFINITIONS } from "../../../../shared/opdMetrics.js";
import { visitsHref } from "./opdFilters";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const hourLabel = (hour) => `${String(hour).padStart(2, "0")}:00`;

export default function BookedHeatmap({ data, filters, back }) {
  const cells = data.heatmap;
  const noSlot = data.totals.noSlot;
  const at = new Map(cells.map((c) => [`${c.weekday}-${c.hour}`, c.came]));
  const hours = cells.map((c) => c.hour);
  const first = Math.min(...hours);
  const last = Math.max(...hours);
  const columns = cells.length ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [];
  const days = WEEKDAYS.map((name, i) => ({ name, weekday: i + 1 })).filter((day) =>
    cells.some((c) => c.weekday === day.weekday),
  );
  const missing = WEEKDAYS.filter((_, i) => !cells.some((c) => c.weekday === i + 1));
  const busiest = Math.max(1, ...cells.map((c) => c.came));
  return (
    <section className="flow-card bdash-card" aria-labelledby="opd-heat">
      <div className="fset__cardhead">
        <h2 id="opd-heat" className="flow-sec-title">
          When patients are booked
        </h2>
      </div>
      <div className="fset__cardsub">
        Visits by weekday and hour, for planning staff. {OPD_DEFINITIONS.heatmap} Click a number to
        list its patients.
      </div>
      {!cells.length ? (
        <div className="bdash-empty">No visits with a booked time in these dates.</div>
      ) : (
        <div className="fset__scroll">
          <table className="opd-heat" aria-label="Visits by weekday and hour">
            <thead>
              <tr>
                <td />
                {columns.map((hour) => (
                  <th key={hour} scope="col">
                    {hourLabel(hour)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.weekday}>
                  <th scope="row">{day.name}</th>
                  {columns.map((hour) => {
                    const value = at.get(`${day.weekday}-${hour}`) ?? 0;
                    const strength = value ? 0.12 + 0.6 * (value / busiest) : 0;
                    return (
                      <td key={hour}>
                        {value ? (
                          <Link
                            to={visitsHref(filters, { state: "came", weekday: day.weekday, hour })}
                            state={{ back }}
                            aria-label={`${day.name} ${hourLabel(hour)}: ${value} ${value === 1 ? "visit" : "visits"}`}
                            style={{ background: `rgba(42, 120, 214, ${strength})` }}
                          >
                            {count(value)}
                          </Link>
                        ) : (
                          <span className="bdash-muted">·</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {missing.length || noSlot ? (
        <p className="bdash-foot">
          {missing.length ? `No visits on ${missing.join(", ")}. ` : ""}
          {noSlot
            ? `${count(noSlot)} ${noSlot === 1 ? "visit has" : "visits have"} no booked time and ${noSlot === 1 ? "is" : "are"} not shown.`
            : ""}
        </p>
      ) : null}
    </section>
  );
}
