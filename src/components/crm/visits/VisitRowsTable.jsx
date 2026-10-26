import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import useDebounced from "../../../hooks/useDebounced.js";
import { errorText } from "../import/importText.js";
import { outcomeLabel, shortDate, stateMeta, statusLabel, typeLabel } from "./visitText.js";

const FILTERS = [
  { key: "all", label: "All", count: (c) => c.total },
  { key: "ready", label: "Ready", count: (c) => c.ready },
  { key: "imported", label: "Imported", count: (c) => c.imported },
  { key: "already_logged", label: "Already logged", count: (c) => c.already_logged },
  { key: "failed", label: "Failed", count: (c) => c.failed },
  { key: "not_visited", label: "Not visited", count: (c) => c.not_visited + c.not_filled },
];

export default function VisitRowsTable({ batchId, counts, refreshKey, hideEmpty }) {
  const [filter, setFilter] = useState("all");
  const [q, setQ] = useState("");
  const term = useDebounced(q, 300);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => setPage(1), [filter, term]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get(`/api/crm/visits/import/batches/${batchId}/rows`, {
        params: { state: filter, q: term, page },
      })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load the rows.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [batchId, filter, term, page, refreshKey, retry]);

  const filters = FILTERS.filter(
    (f) => !hideEmpty?.includes(f.key) || (counts && f.count(counts) > 0) || filter === f.key,
  );
  const active = FILTERS.find((f) => f.key === filter);

  return (
    <div className="dimp__rows">
      <div className="dimp__toolbar">
        <div className="dimp__chips" role="group" aria-label="Filter rows">
          {filters.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`dimp__chip ${filter === f.key ? "dimp__chip--on" : ""} ${f.key === "failed" && counts?.failed ? "dimp__chip--err" : ""}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="dimp__chip-n">{counts ? f.count(counts) : 0}</span>
            </button>
          ))}
        </div>
        <label className="dimp__search">
          <span className="dimp__sr">Search rows</span>
          <input
            type="search"
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by doctor name, mobile or reason"
          />
        </label>
      </div>

      {err ? (
        <div className="dimp__err" role="alert">
          {err}{" "}
          <button type="button" className="dimp__link" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </div>
      ) : (
        <div className="dimp__scroller" aria-busy={loading}>
          <table className="dimp__table vsh__table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Doctor</th>
                <th>Visit date</th>
                <th>Status</th>
                <th>Type · outcome · follow-up</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i} className="dimp__skeleton">
                      <td colSpan={6}>
                        <span />
                      </td>
                    </tr>
                  ))
                : data?.rows.map((r) => <VisitRow key={r.row_number} r={r} />)}
              {!loading && data?.rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="dimp__empty">
                    {term
                      ? `No rows match “${term}” under ${active.label}.`
                      : filter === "failed"
                        ? "No failed rows."
                        : `No rows under ${active.label}.`}
                    {(term || filter !== "all") && (
                      <button
                        type="button"
                        className="dimp__link"
                        onClick={() => {
                          setQ("");
                          setFilter("all");
                        }}
                      >
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {data && data.pages > 1 && (
        <nav className="dimp__pager" aria-label="Pages">
          <button
            type="button"
            className="dimp__btn"
            onClick={() => setPage((p) => p - 1)}
            disabled={page <= 1 || loading}
          >
            Previous
          </button>
          <span>
            Page {data.page} of {data.pages} · {data.total} rows
          </span>
          <button
            type="button"
            className="dimp__btn"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= data.pages || loading}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

function VisitRow({ r }) {
  const meta = stateMeta(r.visit_state);
  const typed = r.typed_doctor;
  const shown = r.doctor_name || typed;
  return (
    <tr className={["not_filled", "undone"].includes(r.visit_state) ? "dimp__row--off" : ""}>
      <td className="dimp__mono" data-label="Row">
        {r.row_number}
      </td>
      <td data-label="Doctor">
        <strong>{shown || <span className="dimp__muted">—</span>}</strong>
        {r.doctor_area && <span className="dimp__sub">{r.doctor_area}</span>}
        {r.doctor_name && typed && typed.toLowerCase() !== r.doctor_name.toLowerCase() && (
          <span className="dimp__sub">Typed “{typed}”</span>
        )}
      </td>
      <td data-label="Visit date">
        {r.visit_date ? (
          shortDate(r.visit_date)
        ) : r.typed_date ? (
          <span className="dimp__muted">{r.typed_date}</span>
        ) : (
          <span className="dimp__muted">—</span>
        )}
      </td>
      <td data-label="Status">
        {r.visit_status ? (
          statusLabel(r.visit_status)
        ) : r.typed_status ? (
          <span className="dimp__muted">{r.typed_status}</span>
        ) : (
          <span className="dimp__muted">—</span>
        )}
      </td>
      <td data-label="Type · outcome">
        {[typeLabel(r.visit_type), outcomeLabel(r.visit_outcome)].filter(Boolean).join(" · ") || (
          <span className="dimp__muted">—</span>
        )}
        {r.next_visit_date && (
          <span className="dimp__sub">Follow-up by {shortDate(r.next_visit_date)}</span>
        )}
      </td>
      <td data-label="Result">
        <span className={`dimp__pill dimp__pill--${meta.tone}`}>{meta.label}</span>
        {r.fail_reason && (
          <span className={`dimp__flag ${r.visit_state === "failed" ? "dimp__flag--err" : ""}`}>
            {r.fail_reason}
          </span>
        )}
        {(r.flags || []).map((f) => (
          <span key={f} className="dimp__flag dimp__flag--warn">
            {f}
          </span>
        ))}
      </td>
    </tr>
  );
}
