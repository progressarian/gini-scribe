import { Link } from "react-router-dom";
import usePagedList from "./usePagedList.js";
import ListPager from "../ListPager.jsx";
import { ListStatus, ListBody } from "./ListToolbar.jsx";
import { taskPriorityMeta } from "../../../../shared/crmVocab.js";

const BUCKETS = [
  { key: "", label: "All open", count: "all" },
  { key: "open", label: "Not started", count: "open" },
  { key: "in_progress", label: "In progress", count: "in_progress" },
  { key: "overdue", label: "Overdue", count: "overdue" },
];

const dateText = (v) =>
  new Date(`${v}T00:00:00`).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

export default function TasksList({ filters, onChange, refreshKey }) {
  const list = usePagedList("/api/crm/home/tasks", filters, refreshKey, "Unable to load tasks.");
  const { data, loading } = list;

  return (
    <section className="home__panel" aria-label="Tasks">
      <div className="rep__chips" role="group" aria-label="Filter tasks">
        {BUCKETS.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`rep__chip ${(filters.status || "") === b.key ? "rep__chip--on" : ""}`}
            aria-pressed={(filters.status || "") === b.key}
            onClick={() => onChange({ status: b.key, page: 1 })}
          >
            {b.label} <strong>{data?.counts?.[b.count] ?? "–"}</strong>
          </button>
        ))}
      </div>
      <ListStatus {...list} noun="task" active={false} />
      <ListBody
        data={data}
        loading={loading}
        active={!!filters.status}
        onClear={() => onChange({ page: 1 })}
        empty="No open tasks."
        filteredEmpty="No tasks in this group."
      >
        {data?.rows.map((t) => {
          const pri = taskPriorityMeta(t.priority);
          return (
            <li key={t.id} className="rep__row">
              <div className="rep__row-main">
                <strong>{t.title}</strong>
                <span className="rep__row-sub">
                  {t.due_date ? `Due ${dateText(t.due_date)}` : "No due date"}
                  {t.status === "in_progress" ? " · In progress" : ""}
                </span>
                <span className="rep__row-flags">
                  {t.overdue && <span className="rep__due rep__due--red">Overdue</span>}
                  {pri && t.priority !== "normal" && (
                    <span className={`rep__due rep__due--${pri.tone}`}>{pri.label}</span>
                  )}
                </span>
              </div>
              {t.doctor_id && (
                <Link className="rep__btn rep__btn--sm" to={`/crm/doctor/${t.doctor_id}`}>
                  Doctor
                </Link>
              )}
            </li>
          );
        })}
      </ListBody>
      <ListPager
        page={data?.page}
        pages={data?.pages}
        loading={loading}
        onPage={(page) => onChange({ ...filters, page })}
      />
    </section>
  );
}
