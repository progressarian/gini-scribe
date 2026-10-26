import { useEffect, useState } from "react";
import api from "../../../services/api.js";
import useDebounced from "../../../hooks/useDebounced.js";
import { downloadFile } from "../../../lib/downloadBlob.js";
import { errorText } from "../import/importText.js";
import { VISIT_SHEET_STATUSES } from "../../../../shared/crmVocab.js";
import { plural, shortDate } from "./visitText.js";

const nextVisitProblem = (r) => /Next visit/i.test(r.fail_reason || "");

export default function FixFailedRows({ batchId, fileName, failed, window, onChanged, disabled }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get(`/api/crm/visits/import/batches/${batchId}/rows`, { params: { state: "failed", page } })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load the failed rows.")));
    return () => {
      cancelled = true;
    };
  }, [batchId, page, failed, reload]);

  if (!failed) return null;

  const edit = (row, patch) => setEdits((all) => ({ ...all, [row]: { ...all[row], ...patch } }));

  const fixOf = (r) => {
    const e = edits[r.row_number] || {};
    return {
      row_number: r.row_number,
      doctor_id: e.doctor_id ?? r.matched_doctor_id ?? null,
      visit_date: e.visit_date ?? r.visit_date ?? null,
      status: e.status ?? r.visit_status ?? null,
      ...(nextVisitProblem(r)
        ? { next_visit: e.next_visit !== undefined ? e.next_visit : (r.next_visit_date ?? null) }
        : {}),
    };
  };

  const retry = async (rows, label) => {
    setBusy(label);
    setErr(null);
    try {
      const { data: summary } = await api.post(`/api/crm/visits/import/batches/${batchId}/retry`, {
        rows: rows.map(fixOf),
      });
      const still = summary.retried.filter((r) => r.visit_state === "failed");
      if (still.length) {
        setErr(
          `${plural(still.length, "row")} still failed: ${[...new Set(still.map((r) => r.fail_reason))].join(" ")}`,
        );
      }
      setEdits({});
      onChanged(summary);
      setReload((n) => n + 1);
    } catch (e) {
      setErr(errorText(e, "Unable to retry."));
    } finally {
      setBusy(null);
    }
  };

  const exportFailed = async () => {
    setBusy("export");
    setErr(null);
    try {
      await downloadFile(
        `/api/crm/visits/import/batches/${batchId}/failed.xlsx`,
        `${String(fileName || "visits").replace(/\.[^.]+$/, "")}-failed-rows.xlsx`,
      );
    } catch (e) {
      setErr(errorText(e, "Unable to download the failed rows."));
    } finally {
      setBusy(null);
    }
  };

  const rows = data?.rows ?? [];

  return (
    <section className="dimp__failed" aria-labelledby="vsh-failed">
      <div className="dimp__failed-head">
        <h2 id="vsh-failed" className="dimp__h2">
          Failed rows ({failed})
        </h2>
        <div className="vsh__failed-actions">
          <button
            type="button"
            className="dimp__btn"
            onClick={exportFailed}
            disabled={busy !== null}
          >
            {busy === "export" ? "Preparing…" : "Download failed rows"}
          </button>
          {rows.length > 1 && (
            <button
              type="button"
              className="dimp__btn dimp__btn--primary"
              onClick={() => retry(rows, "all")}
              disabled={busy !== null || disabled}
            >
              {busy === "all" ? "Retrying…" : `Retry ${rows.length} shown`}
            </button>
          )}
        </div>
      </div>
      <p className="dimp__lede">
        Fix the doctor, date or status, then retry. Dates from {shortDate(window?.from)} to{" "}
        {shortDate(window?.to)} can be uploaded. The download lists each row with its reason.
      </p>
      {err && (
        <div className="dimp__err" role="alert">
          {err}
        </div>
      )}
      <ul className="vsh__fixlist">
        {rows.map((r) => {
          const fix = fixOf(r);
          const edited = edits[r.row_number] || {};
          return (
            <li key={r.row_number} className="vsh__fix">
              <div className="vsh__fix-head">
                <strong>Row {r.row_number}</strong>
                <span className="dimp__flag dimp__flag--err">{r.fail_reason}</span>
              </div>
              <div className="vsh__fix-fields">
                <DoctorPicker
                  row={r}
                  value={fix.doctor_id}
                  onChange={(doctor_id) => edit(r.row_number, { doctor_id })}
                />
                <label className="vsh__field">
                  <span>Visit date</span>
                  <input
                    type="date"
                    value={fix.visit_date || ""}
                    min={window?.from}
                    max={window?.to}
                    onChange={(e) => edit(r.row_number, { visit_date: e.target.value || null })}
                  />
                </label>
                <label className="vsh__field">
                  <span>Status</span>
                  <select
                    value={fix.status || ""}
                    onChange={(e) => edit(r.row_number, { status: e.target.value || null })}
                  >
                    <option value="">Choose…</option>
                    {VISIT_SHEET_STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                {nextVisitProblem(r) && (
                  <label className="vsh__field">
                    <span>Next visit date</span>
                    <input
                      type="date"
                      value={edited.next_visit ?? r.next_visit_date ?? ""}
                      min={fix.visit_date || undefined}
                      onChange={(e) => edit(r.row_number, { next_visit: e.target.value || null })}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="dimp__btn"
                  onClick={() => retry([r], r.row_number)}
                  disabled={busy !== null || disabled}
                >
                  {busy === r.row_number ? "Retrying…" : "Retry"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {data && data.pages > 1 && (
        <nav className="dimp__pager" aria-label="Failed row pages">
          <button
            type="button"
            className="dimp__btn"
            onClick={() => setPage((p) => p - 1)}
            disabled={page <= 1}
          >
            Previous
          </button>
          <span>
            Page {data.page} of {data.pages}
          </span>
          <button
            type="button"
            className="dimp__btn"
            onClick={() => setPage((p) => p + 1)}
            disabled={page >= data.pages}
          >
            Next
          </button>
        </nav>
      )}
    </section>
  );
}

function DoctorPicker({ row, value, onChange }) {
  const [q, setQ] = useState(row.typed_doctor || "");
  const term = useDebounced(q, 300);
  const [options, setOptions] = useState([]);
  const [showingAll, setShowingAll] = useState(false);
  const [loadErr, setLoadErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const { data } = await api.get("/api/crm/visits/doctors", { params: { q: term } });
        if (data.length || !term.trim()) return { list: data, all: false };
        const { data: everyone } = await api.get("/api/crm/visits/doctors");
        return { list: everyone, all: true };
      } catch {
        return null;
      }
    };
    load().then((found) => {
      if (cancelled) return;
      setLoadErr(!found);
      setOptions(found?.list ?? []);
      setShowingAll(Boolean(found?.all));
    });
    return () => {
      cancelled = true;
    };
  }, [term]);

  const current =
    value && !options.some((d) => d.id === value) && row.matched_doctor_id === value
      ? [{ id: value, full_name: row.doctor_name, area: row.doctor_area }]
      : [];

  return (
    <div className="vsh__field vsh__field--doctor">
      <label htmlFor={`vsh-q-${row.row_number}`}>Doctor</label>
      <input
        id={`vsh-q-${row.row_number}`}
        type="search"
        value={q}
        maxLength={100}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search your doctors by name, area or mobile"
      />
      <select
        aria-label={`Doctor for row ${row.row_number}`}
        value={value || ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">
          {options.length || current.length ? "Choose a doctor…" : "No doctors assigned to you"}
        </option>
        {[...current, ...options].map((d) => (
          <option key={d.id} value={d.id}>
            {d.full_name}
            {d.area ? ` · ${d.area}` : ""}
            {d.mobile ? ` · ${d.mobile}` : ""}
          </option>
        ))}
      </select>
      {showingAll && (
        <span className="dimp__sub">
          No doctor of yours matches “{term}”. Showing your doctors A to Z — type part of a name,
          area or mobile to find others.
        </span>
      )}
      {loadErr && <span className="dimp__flag dimp__flag--err">Unable to load your doctors.</span>}
    </div>
  );
}
