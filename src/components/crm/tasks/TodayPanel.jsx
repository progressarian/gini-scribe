import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../../services/api.js";
import { errorText } from "../import/importText.js";
import { visitOutcomeMeta } from "../../../../shared/crmVocab.js";
import TaskRow from "./TaskRow.jsx";
import useTaskActions from "./useTaskActions.jsx";

const time = (iso) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export default function TodayPanel({ refreshKey, onChanged }) {
  const [rep, setRep] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);

  const refresh = () => {
    setReload((n) => n + 1);
    onChanged?.();
  };
  const actions = useTaskActions(refresh);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get("/api/crm/today", { params: rep ? { rep } : {} })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load today.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [rep, reload, refreshKey]);

  if (err) {
    return (
      <div className="rep__err" role="alert">
        {err}{" "}
        <button type="button" className="asg__link" onClick={refresh}>
          Try again
        </button>
      </div>
    );
  }
  if (!data) {
    return (
      <ul className="rep__list" aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <li key={i} className="rep__row asg__skeleton" />
        ))}
      </ul>
    );
  }

  const repName = data.team?.find((r) => r.id === rep)?.full_name;
  const showOwner = data.is_lead && !rep;

  return (
    <div className={`home__panel tdy ${loading ? "prg__body--loading" : ""}`} aria-busy={loading}>
      {actions.ui}

      {data.is_lead && (
        <section className="prg__section" aria-labelledby="tdy-team">
          <div className="prg__section-head">
            <h2 id="tdy-team" className="prg__h2">
              Team today
            </h2>
            {rep && (
              <button type="button" className="asg__link" onClick={() => setRep("")}>
                Show everyone
              </button>
            )}
          </div>
          <div className="prg__scroll">
            <table className="prg__table prg__table--staff">
              <thead>
                <tr>
                  <th scope="col">Staff</th>
                  <th scope="col">Visits today</th>
                  <th scope="col">Doctors</th>
                  <th scope="col">Follow-ups due today</th>
                  <th scope="col">Follow-ups overdue</th>
                  <th scope="col">Tasks overdue</th>
                </tr>
              </thead>
              <tbody>
                {data.team.map((r) => (
                  <tr key={r.id} className={r.id === rep ? "tdy__picked" : ""}>
                    <th scope="row">
                      <button
                        type="button"
                        className="prg__rep"
                        aria-pressed={r.id === rep}
                        onClick={() => setRep(r.id === rep ? "" : r.id)}
                      >
                        {r.full_name}
                      </button>
                    </th>
                    <td>{r.visits_today}</td>
                    <td>{r.doctors_today}</td>
                    <td>{r.due_today}</td>
                    <td className={r.follow_ups_overdue ? "tdy__late" : ""}>
                      {r.follow_ups_overdue}
                    </td>
                    <td className={r.tasks_overdue ? "tdy__late" : ""}>{r.tasks_overdue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rep__hint">
            {rep ? `Showing ${repName}'s day below.` : "Select a name to see that person's day."}
          </p>
        </section>
      )}

      <section className="prg__section" aria-labelledby="tdy-due">
        <h2 id="tdy-due" className="prg__h2">
          Visits due {data.due.length > 0 && <span className="rep__badge">{data.due.length}</span>}
        </h2>
        <ul className="rep__list home__list">
          {data.due.length === 0 && (
            <li className="rep__empty">
              Nothing due today. Tick Needs a follow-up when you log a visit and it shows here on
              the day.
            </li>
          )}
          {data.due.map((t) => (
            <TaskRow key={t.id} task={t} actions={actions} showOwner={showOwner} />
          ))}
        </ul>
      </section>

      {data.other.length > 0 && (
        <section className="prg__section" aria-labelledby="tdy-tasks">
          <h2 id="tdy-tasks" className="prg__h2">
            Tasks due <span className="rep__badge">{data.other.length}</span>
          </h2>
          <ul className="rep__list home__list">
            {data.other.map((t) => (
              <TaskRow key={t.id} task={t} actions={actions} showOwner={showOwner} />
            ))}
          </ul>
        </section>
      )}

      <section className="prg__section" aria-labelledby="tdy-done">
        <h2 id="tdy-done" className="prg__h2">
          Done today{" "}
          {data.done.length > 0 && <span className="rep__badge">{data.done.length}</span>}
        </h2>
        <ul className="rep__list home__list">
          {data.done.length === 0 && <li className="rep__empty">No visits logged yet today.</li>}
          {data.done.map((v) => {
            const outcome = v.outcome ? visitOutcomeMeta(v.outcome) : null;
            return (
              <li key={v.id}>
                <Link
                  to={`/crm/doctor/${v.doctor_id}?visit=${v.id}`}
                  className="rep__row rep__row--tap prg__doctor"
                >
                  <div className="rep__row-main">
                    <strong>{v.full_name}</strong>
                    <span className="rep__row-sub">
                      {[
                        time(v.occurred_at),
                        outcome?.label,
                        v.area,
                        showOwner && v.rep_name,
                        v.source === "sheet" && "From sheet",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {v.can_change && (
                      <span className="rep__row-sub">Open to edit or undo this visit</span>
                    )}
                  </div>
                  <span className="rep__chev" aria-hidden="true">
                    ›
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
