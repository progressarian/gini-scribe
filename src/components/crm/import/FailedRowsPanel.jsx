import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import { downloadFile } from "../../../lib/downloadBlob.js";
import { errorText } from "./importText.js";

export default function FailedRowsPanel({ batchId, fileName, assignees, refreshKey, onChanged }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [picks, setPicks] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get(`/api/crm/import/batches/${batchId}/rows`, { params: { status: "failed", page } })
      .then(({ data }) => {
        if (cancelled) return;
        setRows(data.rows);
        setTotal(data.total);
        setPages(data.pages);
        setPicks((prev) => {
          const next = { ...prev };
          for (const r of data.rows) {
            if (next[r.row_number] === undefined && r.doctor_match && r.suggestion) {
              next[r.row_number] = r.suggestion.id;
            }
          }
          return next;
        });
      })
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load the failed rows.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [batchId, page, refreshKey]);

  const fixable = rows.filter((r) => r.doctor_match);
  const chosen = fixable.filter((r) => picks[r.row_number]);

  const retry = async () => {
    setBusy("retry");
    setErr(null);
    setNotice(null);
    try {
      const { data } = await api.post(`/api/crm/import/batches/${batchId}/retry`, {
        rows: chosen.map((r) => ({ row_number: r.row_number, assignee_id: picks[r.row_number] })),
      });
      setNotice(`${chosen.length} row${chosen.length === 1 ? "" : "s"} assigned.`);
      setPicks({});
      setPage(1);
      onChanged(data);
    } catch (e) {
      setErr(errorText(e, "Unable to retry those rows."));
    } finally {
      setBusy(null);
    }
  };

  const exportFailed = async () => {
    setBusy("export");
    setErr(null);
    try {
      await downloadFile(
        `/api/crm/import/batches/${batchId}/failed.xlsx`,
        `${String(fileName || "import").replace(/\.[^.]+$/, "")}-failed-rows.xlsx`,
      );
    } catch (e) {
      setErr(errorText(e, "Unable to export the failed rows."));
    } finally {
      setBusy(null);
    }
  };

  if (!loading && total === 0) {
    return notice ? (
      <p className="dimp__ok" role="status">
        {notice} No failed rows remain.
      </p>
    ) : null;
  }

  return (
    <section className="dimp__failed" aria-labelledby="dimp-failed-title">
      <div className="dimp__failed-head">
        <h2 id="dimp-failed-title" className="dimp__h2">
          Failed rows <span className="dimp__chip-n">{total}</span>
        </h2>
        <button type="button" className="dimp__btn" onClick={exportFailed} disabled={busy !== null}>
          {busy === "export" ? "Exporting…" : "Export failed rows"}
        </button>
      </div>
      <p className="dimp__lede">
        Pick the right staff member and retry. Rows that failed on the doctor itself cannot be fixed
        here — export them, add the mobile or Doctor ID, and upload the file again.
      </p>
      {err && (
        <div className="dimp__err" role="alert">
          {err}
        </div>
      )}
      {notice && (
        <p className="dimp__ok" role="status">
          {notice}
        </p>
      )}
      <div className="dimp__scroller" aria-busy={loading}>
        <table className="dimp__table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Doctor</th>
              <th>Typed name</th>
              <th>Reason</th>
              <th>Assign to</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.row_number}>
                <td className="dimp__mono">{r.row_number}</td>
                <td>
                  <strong>{r.values?.full_name || <span className="dimp__muted">—</span>}</strong>
                  <span className="dimp__sub">
                    {[r.values?.mobile, r.values?.area].filter(Boolean).join(" · ")}
                  </span>
                </td>
                <td>{r.assignee_typed || <span className="dimp__muted">—</span>}</td>
                <td>
                  <span className="dimp__flag dimp__flag--err">{r.fail_reason}</span>
                </td>
                <td>
                  {r.doctor_match ? (
                    <select
                      aria-label={`Assign row ${r.row_number} to`}
                      value={picks[r.row_number] || ""}
                      onChange={(e) =>
                        setPicks((p) => ({ ...p, [r.row_number]: e.target.value || undefined }))
                      }
                    >
                      <option value="">Choose…</option>
                      {assignees.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.full_name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="dimp__muted">Fix in the sheet</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dimp__actions">
        <button
          type="button"
          className="dimp__btn dimp__btn--primary"
          onClick={retry}
          disabled={busy !== null || chosen.length === 0}
        >
          {busy === "retry" ? "Retrying…" : `Retry selected (${chosen.length})`}
        </button>
        {pages > 1 && (
          <nav className="dimp__pager" aria-label="Failed row pages">
            <button
              type="button"
              className="dimp__btn"
              onClick={() => setPage((p) => p - 1)}
              disabled={page <= 1 || loading}
            >
              Previous
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              type="button"
              className="dimp__btn"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= pages || loading}
            >
              Next
            </button>
          </nav>
        )}
      </div>
    </section>
  );
}
