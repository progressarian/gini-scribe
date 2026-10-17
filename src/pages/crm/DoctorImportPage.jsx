import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../services/api.js";
import { downloadFile } from "../../lib/downloadBlob.js";
import ImportRowsTable from "../../components/crm/import/ImportRowsTable.jsx";
import FailedRowsPanel from "../../components/crm/import/FailedRowsPanel.jsx";
import { errorText } from "../../components/crm/import/importText.js";
import ConfirmModal from "../../components/ui/ConfirmModal.jsx";

const STEPS = ["Upload", "Map columns", "Preview", "Done"];
const ASSIGN_FIELDS = new Set(["assigned_to", "doctor_id"]);

export default function DoctorImportPage() {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);

  const [assignees, setAssignees] = useState(null);
  const canAssign = Array.isArray(assignees);

  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState([]);
  const [fields, setFields] = useState([]);
  const [mapping, setMapping] = useState({});
  const [sampleRows, setSampleRows] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [parsedFile, setParsedFile] = useState(null);
  const [droppedAssign, setDroppedAssign] = useState(false);

  const [batchId, setBatchId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [skip, setSkip] = useState(() => new Set());
  const [progress, setProgress] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [warning, setWarning] = useState(null);

  useEffect(() => {
    api
      .get("/api/crm/import/assignees")
      .then(({ data }) => setAssignees(data))
      .catch(() => setAssignees(false));
  }, []);

  const mappedTo = useMemo(() => new Set(Object.values(mapping).filter(Boolean)), [mapping]);
  const nameMapped = mappedTo.has("full_name");
  const visibleFields = fields.filter((f) => canAssign || !ASSIGN_FIELDS.has(f.key));
  const assigning = (summary?.by_assignee?.length || 0) > 0;

  const run = async (label, work, fallback) => {
    setBusy(label);
    setErr(null);
    try {
      await work();
    } catch (e) {
      setErr(errorText(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  const downloadTemplate = () =>
    run(
      "template",
      () => downloadFile("/api/crm/import/template.xlsx", "crm-doctors-template.xlsx"),
      "Unable to download the template.",
    );

  const onFile = (file) =>
    file &&
    run(
      "read",
      async () => {
        const buf = await file.arrayBuffer();
        const { data } = await api.post("/api/crm/import/parse", buf, {
          headers: { "Content-Type": "application/octet-stream" },
          params: { name: file.name },
        });
        const { data: fieldList } = await api.get("/api/crm/import/fields");
        const suggested = { ...data.suggested_mapping };
        let dropped = false;
        if (!canAssign) {
          for (const [h, f] of Object.entries(suggested)) {
            if (ASSIGN_FIELDS.has(f)) {
              delete suggested[h];
              dropped = true;
            }
          }
        }
        setFileName(file.name);
        setHeaders(data.headers);
        setFields(fieldList);
        setMapping(suggested);
        setDroppedAssign(dropped);
        setSampleRows(data.sample);
        setTotalRows(data.total_rows);
        setParsedFile(file);
        setStep(1);
      },
      "Unable to read that file.",
    );

  const buildPreview = () =>
    run(
      "preview",
      async () => {
        const buf = await parsedFile.arrayBuffer();
        const { data: parsed } = await api.post("/api/crm/import/parse", buf, {
          headers: { "Content-Type": "application/octet-stream" },
          params: { name: fileName, full: 1 },
        });
        const { data: batch } = await api.post("/api/crm/import/batches", {
          file_name: fileName,
          headers: parsed.headers,
          rows: parsed.rows,
          mapping,
        });
        const { data: resolved } = await api.post(
          `/api/crm/import/batches/${batch.batchId}/resolve`,
        );
        setBatchId(batch.batchId);
        setSummary(resolved);
        setSkip(new Set());
        setStep(2);
      },
      "Unable to build the preview.",
    );

  const commit = () =>
    run(
      "commit",
      async () => {
        const goal = Math.max(0, (summary?.counts.pending || 0) - skip.size);
        let latest = summary;
        setProgress({ done: 0, goal });
        for (let i = 0; i < 1000; i++) {
          const { data } = await api.post(`/api/crm/import/batches/${batchId}/commit`, {
            skip_rows: [...skip],
          });
          latest = data;
          setSummary(data);
          setProgress({ done: goal - data.counts.pending, goal });
          if (data.counts.pending === 0) break;
        }
        setSummary(latest);
        setRefreshKey((k) => k + 1);
        setStep(3);
      },
      "The import stopped before it finished. Press the button again to continue from where it stopped.",
    ).finally(() => setProgress(null));

  const confirmCommit = () =>
    run(
      "check",
      async () => {
        if (!summary?.counts.failed) return commit();
        const { data } = await api.get(`/api/crm/import/batches/${batchId}/rows`, {
          params: { status: "failed", page: 1 },
        });
        const staff = data.rows.filter((r) => r.doctor_match);
        const doctor = data.rows.filter((r) => !r.doctor_match);
        setWarning({ total: data.total, staff, doctor, more: data.total - data.rows.length });
      },
      "Unable to check the failed rows.",
    );

  const toggleSkip = (n) =>
    setSkip((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });

  const reset = () => {
    setStep(0);
    setSummary(null);
    setBatchId(null);
    setSkip(new Set());
    setErr(null);
  };

  const willWrite = Math.max(0, (summary?.counts.pending || 0) - skip.size);
  const counts = summary?.counts;

  return (
    <div className="dimp">
      <header className="dimp__head">
        <div className="dimp__titlebar">
          <Link to="/crm/home" className="rep__back dimp__back" aria-label="Back to CRM home">
            ←
          </Link>
          <h1 className="dimp__title">Import doctors</h1>
        </div>
        <ol className="dimp__steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={`dimp__step ${i === step ? "dimp__step--on" : ""} ${i < step ? "dimp__step--done" : ""}`}
              aria-current={i === step ? "step" : undefined}
            >
              <span className="dimp__step-n">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </header>

      {err && (
        <div className="dimp__err" role="alert">
          {err}
        </div>
      )}

      {step === 0 && (
        <section className="dimp__panel">
          <p className="dimp__lede">
            A CSV or Excel file with one doctor per row. Mobile numbers are optional — doctors
            without one import as skeleton records and appear on the “missing details” list for a
            rep to complete.
            {canAssign &&
              " Add an “Assigned to” column with a growth team member’s name to assign each doctor."}
          </p>
          {canAssign && (
            <div className="dimp__template">
              <div>
                <strong>Reassigning existing doctors?</strong>
                <span className="dimp__sub">
                  Download every doctor with their current owner, change “Assigned to”, and upload
                  it here.
                </span>
              </div>
              <button
                type="button"
                className="dimp__btn"
                onClick={downloadTemplate}
                disabled={busy !== null}
              >
                {busy === "template" ? "Preparing…" : "Download doctors template"}
              </button>
            </div>
          )}
          <label className="dimp__drop">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
              disabled={busy !== null}
            />
            <span>{busy === "read" ? "Reading…" : "Choose a file"}</span>
          </label>
        </section>
      )}

      {step === 1 && (
        <section className="dimp__panel">
          <p className="dimp__lede">
            <strong>{fileName}</strong> · {totalRows} rows. Columns we recognised are already
            matched — change anything that looks wrong, and leave unwanted columns as “Ignore”.
          </p>
          {droppedAssign && (
            <p className="dimp__warn">
              This file has an “Assigned to” or “Doctor ID” column. Only an admin or the head of
              growth can assign doctors, so it will be ignored.
            </p>
          )}
          <div className="dimp__scroller">
            <table className="dimp__table">
              <thead>
                <tr>
                  <th>Column in your file</th>
                  <th>Becomes</th>
                  <th>First value</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((h) => (
                  <tr key={h}>
                    <td className="dimp__mono">{h}</td>
                    <td>
                      <select
                        aria-label={`Column ${h} becomes`}
                        value={mapping[h] || ""}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [h]: e.target.value || undefined }))
                        }
                      >
                        <option value="">Ignore this column</option>
                        {visibleFields.map((f) => (
                          <option
                            key={f.key}
                            value={f.key}
                            disabled={mappedTo.has(f.key) && mapping[h] !== f.key}
                          >
                            {f.label}
                            {f.required ? " *" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="dimp__muted">{String(sampleRows[0]?.[h] ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!nameMapped && (
            <p className="dimp__warn">Doctor name has to be mapped before you can continue.</p>
          )}
          <div className="dimp__actions">
            <button
              type="button"
              className="dimp__btn"
              onClick={() => setStep(0)}
              disabled={busy !== null}
            >
              Back
            </button>
            <button
              type="button"
              className="dimp__btn dimp__btn--primary"
              onClick={buildPreview}
              disabled={busy !== null || !nameMapped}
            >
              {busy === "preview" ? "Building preview…" : "Preview import"}
            </button>
          </div>
        </section>
      )}

      {step === 2 && summary && (
        <section className="dimp__panel">
          <Summary summary={summary} />
          <p className="dimp__lede">
            Nothing has been written yet. Untick any row you do not want, and use the “Assigned to”
            list to correct a match or fix a failed name before importing. Rows that still fail are
            not imported — you can fix them after the import or export them with the reason.
          </p>
          <ImportRowsTable
            batchId={batchId}
            counts={counts}
            refreshKey={refreshKey}
            skip={skip}
            onToggleSkip={toggleSkip}
            editable
            assignees={canAssign ? assignees : null}
            onPicked={(data) => {
              setSummary(data);
              setRefreshKey((k) => k + 1);
            }}
          />
          <div className="dimp__actions">
            <button
              type="button"
              className="dimp__btn"
              onClick={() => setStep(1)}
              disabled={busy !== null}
            >
              Back to mapping
            </button>
            <button
              type="button"
              className="dimp__btn dimp__btn--primary"
              onClick={confirmCommit}
              disabled={busy !== null || willWrite === 0}
            >
              {busy === "commit"
                ? `${assigning ? "Assigning" : "Importing"}… ${progress?.done ?? 0} of ${progress?.goal ?? willWrite}`
                : assigning
                  ? `Import and assign ${willWrite} rows`
                  : `Import ${willWrite} doctors`}
            </button>
          </div>
        </section>
      )}

      <ConfirmModal
        open={!!warning}
        variant="primary"
        title={`${warning?.total ?? 0} ${warning?.total === 1 ? "row" : "rows"} will not be imported`}
        cancelLabel="Go back and fix"
        confirmLabel={`Import ${willWrite} ${willWrite === 1 ? "row" : "rows"} anyway`}
        onCancel={() => setWarning(null)}
        onConfirm={() => {
          setWarning(null);
          commit();
        }}
        message={
          warning && (
            <div className="dimp__warnlist">
              {warning.staff.length > 0 && (
                <p>
                  <strong>
                    Staff name not matched ({warning.staff.length}
                    {warning.more > 0 ? "+" : ""}):
                  </strong>{" "}
                  {warning.staff.map((r) => `“${r.assignee_typed}”`).join(", ")}
                </p>
              )}
              {warning.doctor.length > 0 && (
                <p>
                  <strong>Problem with the doctor ({warning.doctor.length}):</strong>{" "}
                  {[...new Set(warning.doctor.map((r) => r.fail_reason))].join("; ")}
                </p>
              )}
              <p>
                These rows will be skipped. Choose the right staff member in the “Assigned to”
                column first, or fix them after the import, or export them with the reason.
              </p>
            </div>
          )
        }
      />

      {step === 3 && summary && (
        <section className="dimp__panel">
          <div className="dimp__counts" role="status">
            <Count n={counts.created} label="New doctors created" tone="ok" />
            <Count n={counts.assigned} label="Assigned" tone="ok" />
            <Count n={counts.unchanged} label="Unchanged" tone="dup" />
            <Count n={counts.failed} label="Failed" tone={counts.failed ? "err" : "dup"} />
          </div>
          {summary.by_assignee.length > 0 && (
            <ul className="dimp__per">
              {summary.by_assignee.map((a) => (
                <li key={a.id}>
                  <strong>{a.full_name}</strong> {a.assigned} assigned
                </li>
              ))}
            </ul>
          )}
          {canAssign && (
            <FailedRowsPanel
              batchId={batchId}
              fileName={fileName}
              assignees={assignees}
              refreshKey={refreshKey}
              onChanged={(data) => {
                setSummary(data);
                setRefreshKey((k) => k + 1);
              }}
            />
          )}
          <h2 className="dimp__h2">All rows</h2>
          <ImportRowsTable batchId={batchId} counts={counts} refreshKey={refreshKey} />
          <div className="dimp__actions">
            <button type="button" className="dimp__btn dimp__btn--primary" onClick={reset}>
              Import another file
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Summary({ summary }) {
  const { counts, by_assignee: people } = summary;
  return (
    <div className="dimp__counts">
      <Count n={counts.total} label="Rows" tone="dup" />
      {people.map((p) => (
        <Count key={p.id} n={p.rows} label={p.full_name} tone="ok" />
      ))}
      <Count n={counts.new} label="New doctors" tone="ok" />
      <Count n={counts.unchanged} label="Unchanged" tone="dup" />
      <Count n={counts.failed} label="Failed" tone={counts.failed ? "err" : "dup"} />
    </div>
  );
}

function Count({ n, label, tone }) {
  return (
    <div className={`dimp__count dimp__count--${tone}`}>
      <span className="dimp__count-n">{n ?? 0}</span>
      <span className="dimp__count-l">{label}</span>
    </div>
  );
}
