import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import useDebounced from "../../../hooks/useDebounced.js";
import { errorText } from "./importText.js";

const FILTERS = [
  { key: "all", label: "All", count: "total" },
  { key: "assign", label: "Will assign", count: "assign" },
  { key: "new", label: "New doctors", count: "new" },
  { key: "unchanged", label: "Unchanged", count: "unchanged" },
  { key: "failed", label: "Failed", count: "failed" },
];

const BEFORE = {
  create: { label: "New doctor", tone: "ok" },
  possible_duplicate: { label: "Possible duplicate", tone: "warn" },
  duplicate: { label: "Duplicate — skipped", tone: "dup" },
  error: { label: "Error", tone: "err" },
  assign: { label: "Will assign", tone: "ok" },
  unchanged: { label: "Unchanged", tone: "dup" },
  failed: { label: "Failed", tone: "err" },
};

const AFTER = {
  created: { label: "Created", tone: "ok" },
  updated: { label: "Assigned", tone: "ok" },
  skipped_duplicate: { label: "Skipped", tone: "dup" },
  error: { label: "Failed", tone: "err" },
};

const MATCHED_BY = { id: "Doctor ID", mobile: "Mobile", name: "Name", new: "New doctor" };

export const WRITABLE = new Set(["create", "possible_duplicate", "assign"]);

function result(r) {
  if (r.row_status === "updated" && r.assign_status === "unchanged") {
    return { label: "Unchanged", tone: "dup" };
  }
  if (r.row_status === "skipped_duplicate" && r.outcome === "unchanged") {
    return { label: "Unchanged", tone: "dup" };
  }
  if (r.row_status !== "pending") return AFTER[r.row_status] || BEFORE[r.outcome];
  return BEFORE[r.outcome] || BEFORE.create;
}

function matchedBy(r) {
  if (r.doctor_match) return MATCHED_BY[r.doctor_match];
  if (r.outcome === "duplicate") return "Mobile";
  if (r.outcome === "create" || r.outcome === "possible_duplicate") return "New doctor";
  return null;
}

export default function ImportRowsTable({
  batchId,
  counts,
  refreshKey,
  skip,
  onToggleSkip,
  editable,
  assignees,
  onPicked,
  initialFilter = "all",
}) {
  const [filter, setFilter] = useState(initialFilter);
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
      .get(`/api/crm/import/batches/${batchId}/rows`, { params: { status: filter, q: term, page } })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load the rows.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [batchId, filter, term, page, refreshKey, retry]);

  const active = FILTERS.find((f) => f.key === filter);

  return (
    <div className="dimp__rows">
      <div className="dimp__toolbar">
        <div className="dimp__chips" role="group" aria-label="Filter rows">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={`dimp__chip ${filter === f.key ? "dimp__chip--on" : ""} ${f.key === "failed" && counts?.failed ? "dimp__chip--err" : ""}`}
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="dimp__chip-n">{counts?.[f.count] ?? 0}</span>
            </button>
          ))}
        </div>
        <label className="dimp__search">
          <span className="dimp__sr">Search rows</span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by doctor name, mobile or typed staff name"
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
          <table className="dimp__table dimp__table--preview">
            <thead>
              <tr>
                {editable && <th>Import</th>}
                <th>Row</th>
                <th>Doctor</th>
                <th>Matched by</th>
                <th>Assigned to</th>
                <th>Current owner</th>
                <th>Result</th>
                <th>Notes on this row</th>
              </tr>
            </thead>
            <tbody>
              {loading && !data
                ? Array.from({ length: 6 }, (_, i) => (
                    <tr key={i} className="dimp__skeleton">
                      <td colSpan={editable ? 8 : 7}>
                        <span />
                      </td>
                    </tr>
                  ))
                : data?.rows.map((r) => {
                    const meta = result(r);
                    const canSkip =
                      editable && WRITABLE.has(r.outcome) && r.row_status === "pending";
                    const off = skip?.has(r.row_number) || r.outcome === "error";
                    return (
                      <tr key={r.row_number} className={off ? "dimp__row--off" : ""}>
                        {editable && (
                          <td>
                            {canSkip && (
                              <input
                                type="checkbox"
                                checked={!skip.has(r.row_number)}
                                onChange={() => onToggleSkip(r.row_number)}
                                aria-label={`Import row ${r.row_number}`}
                              />
                            )}
                          </td>
                        )}
                        <td className="dimp__mono">{r.row_number}</td>
                        <td>
                          <strong>
                            {r.values?.full_name || <span className="dimp__muted">—</span>}
                          </strong>
                          <span className="dimp__sub">
                            {[r.values?.specialty, r.values?.mobile, r.values?.area]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                          {r.matched_name && r.matched_name !== r.values?.full_name && (
                            <span className="dimp__sub">In CRM as {r.matched_name}</span>
                          )}
                        </td>
                        <td>{matchedBy(r) || <span className="dimp__muted">—</span>}</td>
                        <td>
                          {editable &&
                          Array.isArray(assignees) &&
                          r.doctor_match &&
                          r.row_status === "pending" ? (
                            <AssigneePicker
                              batchId={batchId}
                              row={r}
                              assignees={assignees}
                              onPicked={onPicked}
                            />
                          ) : r.assignee_typed && !r.assignee && !r.doctor_match ? (
                            <span className="dimp__muted">{r.assignee_typed}</span>
                          ) : r.assignee_typed ? (
                            <>
                              {r.assignee ? (
                                <strong>{r.assignee.full_name}</strong>
                              ) : (
                                <span className="dimp__flag--err">Not matched</span>
                              )}
                              {(!r.assignee ||
                                r.assignee.full_name.toLowerCase() !==
                                  r.assignee_typed.trim().toLowerCase()) && (
                                <span className="dimp__sub">Typed “{r.assignee_typed}”</span>
                              )}
                            </>
                          ) : (
                            <span className="dimp__muted">—</span>
                          )}
                        </td>
                        <td>
                          {r.current_owner?.full_name || <span className="dimp__muted">None</span>}
                        </td>
                        <td>
                          <span className={`dimp__pill dimp__pill--${meta.tone}`}>
                            {meta.label}
                          </span>
                        </td>
                        <td>
                          {r.fail_reason && (
                            <span className="dimp__flag dimp__flag--err">{r.fail_reason}</span>
                          )}
                          {(r.flags || []).map((f) => (
                            <span
                              key={f}
                              className={`dimp__flag ${/check/i.test(f) ? "dimp__flag--warn" : ""}`}
                            >
                              {f}
                            </span>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
              {!loading && data?.rows.length === 0 && (
                <tr>
                  <td colSpan={editable ? 8 : 7} className="dimp__empty">
                    {term
                      ? `No rows match “${term}” under ${active.label}.`
                      : filter === "failed"
                        ? "No failed rows — every row matched."
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

function AssigneePicker({ batchId, row, assignees, onPicked }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const choose = async (assigneeId) => {
    if (!assigneeId || assigneeId === row.assignee?.id) return;
    setSaving(true);
    setErr(null);
    try {
      const { data } = await api.post(`/api/crm/import/batches/${batchId}/pick`, {
        row_number: row.row_number,
        assignee_id: assigneeId,
      });
      onPicked(data);
    } catch (e) {
      setErr(errorText(e, "Unable to change the staff member."));
    } finally {
      setSaving(false);
    }
  };

  const typedDiffers =
    row.assignee_typed &&
    (!row.assignee ||
      row.assignee.full_name.toLowerCase() !== row.assignee_typed.trim().toLowerCase());

  return (
    <div className="dimp__pick">
      <select
        aria-label={`Assign row ${row.row_number} to`}
        value={row.assignee?.id || ""}
        onChange={(e) => choose(e.target.value)}
        disabled={saving}
        className={row.assignee ? "" : "dimp__pick--empty"}
      >
        <option value="" disabled>
          {row.assignee_typed ? row.assignee_typed.trim() : "No owner — choose…"}
        </option>
        {assignees.map((a) => (
          <option key={a.id} value={a.id}>
            {a.full_name}
            {row.suggestion?.id === a.id ? " (suggested)" : ""}
          </option>
        ))}
      </select>
      {row.assignee
        ? typedDiffers && <span className="dimp__sub">Typed “{row.assignee_typed}”</span>
        : row.assignee_typed && (
            <span className="dimp__flag dimp__flag--err">Not matched — choose a staff member</span>
          )}
      {saving && <span className="dimp__sub">Saving…</span>}
      {err && (
        <span className="dimp__flag dimp__flag--err" role="alert">
          {err}
        </span>
      )}
    </div>
  );
}
