import { useState, useMemo } from "react";
import api from "../../services/api.js";

// The doctor import wizard (brief §10). Four steps, and the third is the point:
// nothing reaches crm.doctors until somebody has looked at every row and said
// yes. "Never silently create duplicates" is the brief's phrasing, and a
// preview you cannot argue with is how that is kept.

const STEPS = ["Upload", "Map columns", "Preview", "Done"];

const STATUS_META = {
  create: { label: "Will import", tone: "ok" },
  possible_duplicate: { label: "Possible duplicate", tone: "warn" },
  duplicate: { label: "Duplicate — skipped", tone: "dup" },
  error: { label: "Error", tone: "err" },
};

export default function DoctorImportPage() {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [fields, setFields] = useState([]);
  const [mapping, setMapping] = useState({});

  const [sampleRows, setSampleRows] = useState([]);
  const [totalRows, setTotalRows] = useState(0);
  const [parsedFile, setParsedFile] = useState(null);

  const [batchId, setBatchId] = useState(null);
  const [preview, setPreview] = useState(null);
  const [skip, setSkip] = useState(() => new Set());
  const [result, setResult] = useState(null);

  const mappedTo = useMemo(() => new Set(Object.values(mapping).filter(Boolean)), [mapping]);
  const nameMapped = mappedTo.has("full_name");

  const onFile = async (file) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const buf = await file.arrayBuffer();
      const { data } = await api.post("/api/crm/import/parse", buf, {
        headers: { "Content-Type": "application/octet-stream" },
        params: { name: file.name },
      });
      const { data: fieldList } = await api.get("/api/crm/import/fields");
      setFileName(file.name);
      setHeaders(data.headers);
      setRows([]);
      setFields(fieldList);
      setMapping(data.suggested_mapping);
      setSampleRows(data.sample);
      setTotalRows(data.total_rows);
      setParsedFile(file);
      setStep(1);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const buildPreview = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Re-read the file here rather than holding every row in memory through
      // the mapping step; the operator may spend a while on the mapping.
      const buf = await parsedFile.arrayBuffer();
      const { data: parsed } = await api.post("/api/crm/import/parse", buf, {
        headers: { "Content-Type": "application/octet-stream" },
        params: { name: fileName, full: 1 },
      });
      const { data: batch } = await api.post("/api/crm/import/batches", {
        file_name: fileName,
        headers: parsed.headers,
        rows: parsed.rows ?? rows,
        mapping,
      });
      setBatchId(batch.batchId);
      const { data: pv } = await api.get(`/api/crm/import/batches/${batch.batchId}/preview`);
      setPreview(pv);
      setSkip(new Set(pv.rows.filter((r) => r.status === "duplicate").map((r) => r.row_number)));
      setStep(2);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { data } = await api.post(`/api/crm/import/batches/${batchId}/commit`, {
        skip_rows: [...skip],
      });
      setResult(data);
      setStep(3);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleSkip = (n) =>
    setSkip((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });

  const willImport = preview
    ? preview.rows.filter((r) => r.status !== "error" && !skip.has(r.row_number)).length
    : 0;

  return (
    <div className="dimp">
      <header className="dimp__head">
        <h1 className="dimp__title">Import doctors</h1>
        <ol className="dimp__steps">
          {STEPS.map((s, i) => (
            <li
              key={s}
              className={`dimp__step ${i === step ? "dimp__step--on" : ""} ${i < step ? "dimp__step--done" : ""}`}
            >
              <span className="dimp__step-n">{i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      </header>

      {err && <div className="dimp__err">{err}</div>}

      {step === 0 && (
        <section className="dimp__panel">
          <p className="dimp__lede">
            A CSV or Excel file with one doctor per row. Mobile numbers are optional — doctors
            without one import as skeleton records and appear on the “missing details” list for a
            rep to complete.
          </p>
          <label className="dimp__drop">
            <input
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={(e) => onFile(e.target.files?.[0])}
              disabled={busy}
            />
            <span>{busy ? "Reading…" : "Choose a file"}</span>
          </label>
        </section>
      )}

      {step === 1 && (
        <section className="dimp__panel">
          <p className="dimp__lede">
            <strong>{fileName}</strong> · {totalRows} rows. Columns we recognised are already
            matched — change anything that looks wrong, and leave unwanted columns as “Ignore”.
          </p>
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
                        value={mapping[h] || ""}
                        onChange={(e) =>
                          setMapping((m) => ({ ...m, [h]: e.target.value || undefined }))
                        }
                      >
                        <option value="">Ignore this column</option>
                        {fields.map((f) => (
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
            <button className="dimp__btn" onClick={() => setStep(0)} disabled={busy}>
              Back
            </button>
            <button
              className="dimp__btn dimp__btn--primary"
              onClick={buildPreview}
              disabled={busy || !nameMapped}
            >
              {busy ? "Checking…" : "Preview import"}
            </button>
          </div>
        </section>
      )}

      {step === 2 && preview && (
        <section className="dimp__panel">
          <div className="dimp__counts">
            <Count n={preview.counts.create || 0} label="Will import" tone="ok" />
            <Count
              n={preview.counts.possible_duplicate || 0}
              label="Possible duplicates"
              tone="warn"
            />
            <Count n={preview.counts.duplicate || 0} label="Duplicates" tone="dup" />
            <Count n={preview.counts.error || 0} label="Errors" tone="err" />
          </div>
          <p className="dimp__lede">
            Nothing has been written yet. Untick any row you do not want; rows with errors are never
            imported.
          </p>
          <div className="dimp__scroller">
            <table className="dimp__table dimp__table--preview">
              <thead>
                <tr>
                  <th>Import</th>
                  <th>Row</th>
                  <th>Doctor</th>
                  <th>Specialty</th>
                  <th>Territory / area</th>
                  <th>Status</th>
                  <th>Notes on this row</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r) => {
                  const meta = STATUS_META[r.status] || STATUS_META.create;
                  const off = r.status === "error" || skip.has(r.row_number);
                  return (
                    <tr key={r.row_number} className={off ? "dimp__row--off" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          checked={!off}
                          disabled={r.status === "error"}
                          onChange={() => toggleSkip(r.row_number)}
                          aria-label={`Import row ${r.row_number}`}
                        />
                      </td>
                      <td className="dimp__muted">{r.row_number}</td>
                      <td>
                        <strong>{r.values.full_name || <em>— no name —</em>}</strong>
                        {r.values.qualifications && (
                          <span className="dimp__sub">{r.values.qualifications}</span>
                        )}
                      </td>
                      <td>{r.values.specialty || <span className="dimp__muted">—</span>}</td>
                      <td>
                        {[r.values.territory, r.values.area].filter(Boolean).join(" · ") || (
                          <span className="dimp__muted">—</span>
                        )}
                      </td>
                      <td>
                        <span className={`dimp__pill dimp__pill--${meta.tone}`}>{meta.label}</span>
                      </td>
                      <td>
                        {r.errors.map((e) => (
                          <span key={e} className="dimp__flag dimp__flag--err">
                            {e}
                          </span>
                        ))}
                        {r.flags.map((f) => (
                          <span key={f} className="dimp__flag">
                            {f}
                          </span>
                        ))}
                        {r.matched_doctor && (
                          <span className="dimp__flag dimp__flag--warn">
                            Matches {r.matched_doctor.full_name}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="dimp__actions">
            <button className="dimp__btn" onClick={() => setStep(1)} disabled={busy}>
              Back to mapping
            </button>
            <button className="dimp__btn dimp__btn--primary" onClick={commit} disabled={busy}>
              {busy ? "Importing…" : `Import ${willImport} doctors`}
            </button>
          </div>
        </section>
      )}

      {step === 3 && result && (
        <section className="dimp__panel">
          <div className="dimp__counts">
            <Count n={result.created} label="Created" tone="ok" />
            <Count n={result.skipped} label="Skipped" tone="dup" />
            <Count n={result.errored} label="Errors" tone="err" />
          </div>
          <p className="dimp__lede">
            Doctors without a mobile number are on the missing-details list, ready to be assigned to
            a rep.
          </p>
          <div className="dimp__actions">
            <button
              className="dimp__btn dimp__btn--primary"
              onClick={() => {
                setStep(0);
                setPreview(null);
                setResult(null);
                setBatchId(null);
              }}
            >
              Import another file
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Count({ n, label, tone }) {
  return (
    <div className={`dimp__count dimp__count--${tone}`}>
      <span className="dimp__count-n">{n}</span>
      <span className="dimp__count-l">{label}</span>
    </div>
  );
}
