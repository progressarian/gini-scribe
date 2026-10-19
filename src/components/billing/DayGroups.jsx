import { Fragment } from "react";

const dayLabel = (day) =>
  new Date(`${day}T00:00:00`).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function daySummary(day, days = []) {
  const counts = days.find((d) => d.day === day);
  if (!counts) return dayLabel(day);
  return [
    dayLabel(day),
    plural(counts.total, "request"),
    counts.waiting ? `${counts.waiting} waiting` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function DayGroups({ rows, days, columns, renderRow }) {
  let lastDay = null;
  return rows.map((row) => {
    const header =
      row.day !== lastDay ? (
        <tr className="dri-day">
          <th colSpan={columns} scope="colgroup">
            {daySummary(row.day, days)}
          </th>
        </tr>
      ) : null;
    lastDay = row.day;
    return (
      <Fragment key={row.id}>
        {header}
        {renderRow(row)}
      </Fragment>
    );
  });
}

export function OlderWaiting({ count, onShow }) {
  if (!count) return null;
  return (
    <div className="dri-older" role="status">
      <span>
        <span aria-hidden="true">⚠ </span>
        {plural(count, "request")} from earlier days {count === 1 ? "is" : "are"} still waiting.
      </span>
      <button type="button" className="flow-btn flow-btn-ghost flow-btn-mini" onClick={onShow}>
        Show them
      </button>
    </div>
  );
}
