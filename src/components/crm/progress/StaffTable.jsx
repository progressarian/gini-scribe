import { useState } from "react";
import { pct, shortDateTime } from "./progressText.js";

const COLUMNS = [
  { key: "visits", label: "Visits", get: (s) => s.visits.visits },
  { key: "unique", label: "Unique doctors", get: (s) => s.visits.unique_doctors },
  { key: "assigned", label: "Assigned", get: (s) => s.visits.assigned },
  {
    key: "coverage",
    label: "Coverage",
    get: (s) => s.visits.coverage_pct ?? -1,
    show: (s) => pct(s.visits.coverage_pct),
  },
  { key: "unavailable", label: "Doctor unavailable", get: (s) => s.visits.doctor_unavailable },
  { key: "followups", label: "Follow-ups set", get: (s) => s.visits.follow_ups },
  {
    key: "overdue",
    label: "Overdue doctors (now)",
    get: (s) => s.visits.overdue_now + s.visits.never_visited_now,
  },
  {
    key: "referrals",
    label: "Referrals (verified)",
    get: (s) => s.referrals.logged,
    show: (s) => `${s.referrals.logged} (${s.referrals.verified})`,
  },
  { key: "tasks", label: "Tasks done", get: (s) => s.tasks.completed },
  { key: "tasks_overdue", label: "Tasks overdue (now)", get: (s) => s.tasks.overdue_now },
  {
    key: "last",
    label: "Last visit",
    get: (s) => (s.visits.last_visit_at ? Date.parse(s.visits.last_visit_at) : 0),
    show: (s) => shortDateTime(s.visits.last_visit_at),
  },
];

export default function StaffTable({ staff, cards, colorOf, onPick }) {
  const [sort, setSort] = useState({ key: "visits", dir: -1 });
  const column = COLUMNS.find((c) => c.key === sort.key);
  const rows = [...staff].sort(
    (a, b) => (column.get(a) - column.get(b)) * sort.dir || a.full_name.localeCompare(b.full_name),
  );
  const total = { full_name: "Team total", ...cards };

  return (
    <section className="prg__section" aria-labelledby="prg-staff">
      <h2 id="prg-staff" className="prg__h2">
        Staff comparison
      </h2>
      <div className="prg__scroll">
        <table className="prg__table prg__table--staff">
          <thead>
            <tr>
              <th scope="col">Staff</th>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={
                    sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    className="prg__sort"
                    onClick={() =>
                      setSort((s) => ({ key: c.key, dir: s.key === c.key ? -s.dir : -1 }))
                    }
                  >
                    {c.label}
                    <span aria-hidden="true">
                      {sort.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <th scope="row">
                  <button type="button" className="prg__rep" onClick={() => onPick(s.id)}>
                    <span
                      className="prg__swatch"
                      style={{ background: colorOf(s.id) }}
                      aria-hidden="true"
                    />
                    {s.full_name}
                  </button>
                </th>
                {COLUMNS.map((c) => (
                  <td key={c.key}>{c.show ? c.show(s) : c.get(s)}</td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Team total</th>
              {COLUMNS.map((c) => (
                <td key={c.key}>{c.show ? c.show(total) : c.get(total)}</td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="rep__hint">Select a name to see that person's report.</p>
    </section>
  );
}
