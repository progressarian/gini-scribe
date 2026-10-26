import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../../services/api.js";
import { downloadFile } from "../../lib/downloadBlob.js";
import { errorText } from "../../components/crm/import/importText.js";
import ConfirmModal from "../../components/ui/ConfirmModal.jsx";
import VisitRowsTable from "../../components/crm/visits/VisitRowsTable.jsx";
import FixFailedRows from "../../components/crm/visits/FixFailedRows.jsx";
import { plural } from "../../components/crm/visits/visitText.js";

const STEPS = ["Upload", "Preview", "Done"];

export default function VisitSheetPage() {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const [summary, setSummary] = useState(null);
  const [progress, setProgress] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [uploads, setUploads] = useState(null);
  const [notice, setNotice] = useState(null);

  const batchId = summary?.batch.id;
  const counts = summary?.counts;

  const loadUploads = useCallback(() => {
    api
      .get("/api/crm/visits/import/batches")
      .then(({ data }) => setUploads(data))
      .catch(() => setUploads(false));
  }, []);

  useEffect(loadUploads, [loadUploads]);

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

  const downloadSheet = () =>
    run(
      "sheet",
      () => downloadFile("/api/crm/visits/sheet.xlsx", "my-visits.xlsx"),
      "Unable to download your sheet.",
    );

  const onFile = (file) =>
    file &&
    run(
      "read",
      async () => {
        if (file.size > 5 * 1024 * 1024) {
          throw new Error("That file is over 5 MB. Upload the sheet you downloaded from CRM home.");
        }
        const { data } = await api.post(
          "/api/crm/visits/import/batches",
          await file.arrayBuffer(),
          {
            headers: { "Content-Type": "application/octet-stream" },
            params: { name: file.name },
          },
        );
        setSummary(data);
        setNotice(null);
        setRefreshKey((k) => k + 1);
        setStep(1);
      },
      "Unable to read that file.",
    );

  const commit = () =>
    run(
      "commit",
      async () => {
        const goal = summary.counts.ready;
        setProgress({ done: 0, goal });
        let latest = summary;
        for (let i = 0; i < 100 && latest.counts.ready > 0; i++) {
          const { data } = await api.post(`/api/crm/visits/import/batches/${batchId}/commit`);
          latest = data;
          setSummary(data);
          setProgress({ done: goal - data.counts.ready, goal });
        }
        setRefreshKey((k) => k + 1);
        setStep(2);
        loadUploads();
      },
      "The import stopped before it finished. Press the button again to continue from where it stopped.",
    ).finally(() => setProgress(null));

  const undo = () =>
    run(
      "undo",
      async () => {
        const { data } = await api.post(`/api/crm/visits/import/batches/${batchId}/undo`);
        setSummary(data.summary);
        setNotice(`Upload undone — ${plural(data.undone, "visit")} removed.`);
        setRefreshKey((k) => k + 1);
        loadUploads();
      },
      "Unable to undo this upload.",
    );

  const openUpload = (id) =>
    run(
      "open",
      async () => {
        const { data } = await api.get(`/api/crm/visits/import/batches/${id}/summary`);
        setSummary(data);
        setNotice(null);
        setRefreshKey((k) => k + 1);
        setStep(data.counts.ready > 0 && data.batch.status !== "cancelled" ? 1 : 2);
      },
      "Unable to open that upload.",
    );

  const reset = () => {
    setStep(0);
    setSummary(null);
    setErr(null);
    setNotice(null);
    loadUploads();
  };

  const cancelled = summary?.batch.status === "cancelled";

  return (
    <div className="dimp">
      <header className="dimp__head">
        <div className="dimp__titlebar">
          <Link to="/crm/home" className="rep__back dimp__back" aria-label="Back to CRM home">
            ←
          </Link>
          <h1 className="dimp__title">Upload visits</h1>
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
          <div className="dimp__template">
            <div>
              <strong>1. Download your sheet</strong>
              <span className="dimp__sub">
                Your assigned doctors with visits done today, this week and this month. Fill in
                Visit date and Status for each visit; copy a row for a second visit on another day.
              </span>
            </div>
            <button
              type="button"
              className="dimp__btn"
              onClick={downloadSheet}
              disabled={busy !== null}
            >
              {busy === "sheet" ? "Preparing…" : "Download my sheet"}
            </button>
          </div>
          <p className="dimp__lede">
            <strong>2. Upload it back.</strong> Completed and Doctor unavailable rows become visits;
            Not visited rows are skipped. Only your own doctors are accepted, one visit per doctor
            per day, dated this month or this week.
          </p>
          <label className="dimp__drop">
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => {
                onFile(e.target.files?.[0]);
                e.target.value = "";
              }}
              disabled={busy !== null}
            />
            <span>{busy === "read" ? "Checking your sheet…" : "Choose the filled sheet"}</span>
          </label>
          <MyUploads uploads={uploads} onOpen={openUpload} busy={busy} onRetry={loadUploads} />
        </section>
      )}

      {step === 1 && summary && (
        <section className="dimp__panel">
          <Counts counts={counts} />
          <p className="dimp__lede">
            <strong>{summary.batch.file_name}</strong> — nothing is saved yet. Ready rows become
            visits for <strong>{summary.uploader}</strong>. Already logged and failed rows are not
            imported; failed rows can be fixed after the import.
          </p>
          <VisitRowsTable
            batchId={batchId}
            counts={counts}
            refreshKey={refreshKey}
            hideEmpty={["imported"]}
          />
          <div className="dimp__actions">
            <button type="button" className="dimp__btn" onClick={reset} disabled={busy !== null}>
              Upload another file
            </button>
            <button
              type="button"
              className="dimp__btn dimp__btn--primary"
              onClick={() => setConfirm(true)}
              disabled={busy !== null || !counts.ready}
            >
              {busy === "commit"
                ? `Importing… ${progress?.done ?? 0} of ${progress?.goal ?? counts.ready}`
                : `Import ${plural(counts.ready, "visit")}`}
            </button>
          </div>
        </section>
      )}

      <ConfirmModal
        open={confirm}
        variant="primary"
        title={`Import ${plural(counts?.ready ?? 0, "visit")} for ${summary?.uploader ?? ""}?`}
        cancelLabel="Go back"
        confirmLabel={`Import ${plural(counts?.ready ?? 0, "visit")}`}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          commit();
        }}
        message={
          counts && (
            <div className="dimp__warnlist">
              <p>
                {plural(counts.ready, "visit")} will be added to your counts for today, this week
                and this month.
              </p>
              {counts.already_logged > 0 && (
                <p>{plural(counts.already_logged, "row")} already logged — skipped.</p>
              )}
              {counts.failed > 0 && (
                <p>
                  <strong>{plural(counts.failed, "row")} failed</strong> and will not be imported.
                  You can fix and retry them on the next screen.
                </p>
              )}
              <p>You can undo this upload until midnight today.</p>
            </div>
          )
        }
      />

      <ConfirmModal
        open={undoing}
        variant="danger"
        title={`Undo this upload and remove ${plural(counts?.imported ?? 0, "visit")}?`}
        cancelLabel="Keep the visits"
        confirmLabel="Undo upload"
        onCancel={() => setUndoing(false)}
        onConfirm={() => {
          setUndoing(false);
          undo();
        }}
        message={
          <p>
            Removes only the {plural(counts?.imported ?? 0, "visit")} added by{" "}
            <strong>{summary?.batch.file_name}</strong>. Visits you logged in the app stay. Your
            today, week and month counts go back down.
          </p>
        }
      />

      {step === 2 && summary && (
        <section className="dimp__panel">
          {notice && (
            <div className="dimp__ok" role="status">
              {notice}
            </div>
          )}
          <div className="dimp__counts" role="status">
            <Count n={counts.imported} label="Visits imported" tone="ok" />
            <Count n={counts.already_logged} label="Already logged" tone="dup" />
            <Count n={counts.failed} label="Failed" tone={counts.failed ? "err" : "dup"} />
            <Count n={counts.not_visited + counts.not_filled} label="Not visited" tone="dup" />
            {counts.undone > 0 && <Count n={counts.undone} label="Undone" tone="dup" />}
          </div>
          {!cancelled && (
            <FixFailedRows
              batchId={batchId}
              fileName={summary.batch.file_name}
              failed={counts.failed}
              window={summary.window}
              disabled={busy !== null}
              onChanged={(data) => {
                setSummary(data);
                setRefreshKey((k) => k + 1);
                loadUploads();
              }}
            />
          )}
          <h2 className="dimp__h2">All rows</h2>
          <VisitRowsTable batchId={batchId} counts={counts} refreshKey={refreshKey} />
          <div className="dimp__actions">
            {summary.can_undo && (
              <button
                type="button"
                className="dimp__btn"
                onClick={() => setUndoing(true)}
                disabled={busy !== null}
              >
                {busy === "undo" ? "Undoing…" : "Undo this upload"}
              </button>
            )}
            <button type="button" className="dimp__btn" onClick={reset} disabled={busy !== null}>
              Upload another file
            </button>
            <Link to="/crm/home" className="dimp__btn dimp__btn--primary">
              Back to CRM home
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}

function MyUploads({ uploads, onOpen, busy, onRetry }) {
  if (uploads === null) return <p className="dimp__muted">Loading your uploads…</p>;
  if (uploads === false) {
    return (
      <p className="dimp__muted">
        Unable to load your earlier uploads.{" "}
        <button type="button" className="dimp__link" onClick={onRetry}>
          Try again
        </button>
      </p>
    );
  }
  if (!uploads.length) return null;
  return (
    <section className="vsh__uploads" aria-labelledby="vsh-uploads">
      <h2 id="vsh-uploads" className="dimp__h2">
        Your recent uploads
      </h2>
      <ul>
        {uploads.map((u) => (
          <li key={u.id} className="vsh__upload">
            <div>
              <strong>{u.file_name}</strong>
              <span className="dimp__sub">
                {new Date(u.created_at).toLocaleString("en-IN", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                · {u.status === "cancelled" ? "Undone" : `${plural(u.imported, "visit")} imported`}
                {u.failed ? ` · ${u.failed} failed` : ""}
              </span>
            </div>
            <button
              type="button"
              className="dimp__btn"
              onClick={() => onOpen(u.id)}
              disabled={busy !== null}
            >
              {u.can_undo ? "Open · undo" : "Open"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Counts({ counts }) {
  return (
    <div className="dimp__counts">
      <Count n={counts.total} label="Rows" tone="dup" />
      <Count n={counts.ready} label="Ready to import" tone="ok" />
      <Count n={counts.already_logged} label="Already logged" tone="dup" />
      <Count n={counts.failed} label="Failed" tone={counts.failed ? "err" : "dup"} />
      <Count n={counts.not_visited + counts.not_filled} label="Not visited" tone="dup" />
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
