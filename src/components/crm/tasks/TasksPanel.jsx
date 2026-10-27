import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import ListPager from "../ListPager.jsx";
import { errorText } from "../import/importText.js";
import TaskRow from "./TaskRow.jsx";
import TaskDialog from "./TaskDialog.jsx";
import useTaskActions from "./useTaskActions.jsx";

const BUCKETS = [
  { key: "due", label: "Due now" },
  { key: "upcoming", label: "Upcoming" },
  { key: "done", label: "Done (30 days)" },
];

const EMPTY = {
  due: "Nothing due. Tasks appear here when you tick Needs a follow-up or note a promise on a visit, or add one with + Task.",
  upcoming: "No upcoming tasks.",
  done: "No tasks closed in the last 30 days.",
};

export default function TasksPanel({ refreshKey, onChanged }) {
  const [bucket, setBucket] = useState("due");
  const [owner, setOwner] = useState("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const refresh = () => {
    setReload((n) => n + 1);
    onChanged?.();
  };
  const actions = useTaskActions(refresh);

  useEffect(() => setPage(1), [bucket, owner]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get("/api/crm/tasks", { params: { bucket, owner, page } })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load tasks.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [bucket, owner, page, reload, refreshKey]);

  const counts = data?.counts;

  return (
    <section className="home__panel" aria-label="Tasks">
      <div className="tsk__bar">
        <div className="rep__chips" role="group" aria-label="Filter tasks">
          {BUCKETS.map((b) => (
            <button
              key={b.key}
              type="button"
              className={`rep__chip ${bucket === b.key ? "rep__chip--on" : ""}`}
              aria-pressed={bucket === b.key}
              onClick={() => setBucket(b.key)}
            >
              {b.label} <strong>{counts ? counts[b.key] : "–"}</strong>
              {b.key === "due" && counts?.overdue > 0 && (
                <span className="tsk__late"> · {counts.overdue} overdue</span>
              )}
            </button>
          ))}
        </div>
        <div className="tsk__tools">
          {data?.can_assign && (
            <label className="asg__field asg__field--narrow">
              <span className="asg__sr">Owner</span>
              <select
                className={`rep__input ${owner !== "all" ? "home__select--on" : ""}`}
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              >
                <option value="all">Everyone</option>
                {data.staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.full_name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="rep__btn rep__btn--primary rep__btn--sm"
            onClick={() => {
              setAdded(false);
              setAdding(true);
            }}
          >
            + Task
          </button>
        </div>
      </div>

      {added && (
        <div className="rep__toast" role="status">
          Task added.
        </div>
      )}
      {actions.ui}
      {err && (
        <div className="rep__err" role="alert">
          {err}{" "}
          <button type="button" className="asg__link" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {!err && (
        <ul className="rep__list home__list" aria-busy={loading}>
          {loading &&
            !data &&
            Array.from({ length: 3 }, (_, i) => <li key={i} className="rep__row asg__skeleton" />)}
          {data && data.rows.length === 0 && <li className="rep__empty">{EMPTY[bucket]}</li>}
          {data?.rows.map((t) => (
            <TaskRow key={t.id} task={t} actions={actions} showOwner={data.can_assign} />
          ))}
        </ul>
      )}
      <ListPager page={data?.page} pages={data?.pages} loading={loading} onPage={setPage} />

      <TaskDialog
        open={adding}
        canAssign={Boolean(data?.can_assign)}
        staff={data?.staff || []}
        onClose={() => setAdding(false)}
        onSaved={() => {
          setAdding(false);
          setAdded(true);
          refresh();
        }}
      />
    </section>
  );
}
