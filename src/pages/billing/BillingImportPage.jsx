import { useId, useRef, useState } from "react";
import {
  useBillingImportErrorFile,
  useBillingImportHistory,
  useBillingImportTemplate,
  useCommitBillingImport,
  usePreviewBillingImport,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import useDialog from "../../components/billing/useDialog";
import { errorOf } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";

const XLSX_ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ROWS_STEP = 50;
const COUNT_LABELS = [
  ["new", "new"],
  ["update", "to update"],
  ["unchanged", "unchanged"],
  ["error", "with errors"],
  ["warning", "with warnings"],
  ["notImported", "not imported yet"],
];
const STATUS_LABEL = { new: "New", update: "Update", unchanged: "Unchanged", error: "Error" };
const RANK = { error: 0, update: 2, new: 3, unchanged: 4 };

const when = (value) =>
  new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const shown = (value) =>
  value === null || value === undefined || value === "" ? "blank" : String(value);
const typed = (text) => (text === undefined || text === "" ? "nothing" : `"${text}"`);
const rankOf = (row) => (row.status !== "error" && row.warnings.length ? 1 : RANK[row.status]);
const listed = (sheet) =>
  sheet.rows
    .filter((row) => row.status !== "unchanged" || row.warnings.length)
    .sort((a, b) => rankOf(a) - rankOf(b) || a.row - b.row);

const saveBlob = ({ blob, fileName }) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

const savedSummary = (counts) =>
  [
    counts.new ? `${counts.new} new` : null,
    counts.update ? `${counts.update} updated` : null,
    counts.unchanged ? `${counts.unchanged} unchanged` : null,
  ]
    .filter(Boolean)
    .join(", ") || "nothing";

function Counts({ counts, label }) {
  const shownCounts = COUNT_LABELS.filter(([key]) => counts[key]);
  return (
    <ul className="bill-import__counts" aria-label={label}>
      {shownCounts.length ? (
        shownCounts.map(([key, text]) => (
          <li key={key} className={`bill-import__count bill-import__count--${key}`}>
            {counts[key]} {text}
          </li>
        ))
      ) : (
        <li className="bill-import__count">No rows</li>
      )}
    </ul>
  );
}

function Messages({ row }) {
  const brief = Object.entries(row.input)
    .filter(([, text]) => text !== "")
    .slice(0, 3);
  return (
    <ul className="bill-import__msgs">
      {row.errors.map((e, i) => (
        <li key={`e${i}`} className="bill-import__msg--error">
          {e.column ? <strong>{e.column}: </strong> : null}
          {e.message}
          {e.column ? (
            <span className="flow-muted"> · typed {typed(row.input[e.column])}</span>
          ) : null}
        </li>
      ))}
      {row.warnings.map((w, i) => (
        <li key={`w${i}`} className="bill-import__msg--warning">
          {w.column ? <strong>{w.column}: </strong> : null}
          {w.message}
        </li>
      ))}
      {row.status === "update"
        ? row.changes.map((c) => (
            <li key={`c${c.column}`}>
              <strong>{c.column}: </strong>
              {shown(c.from)} → {shown(c.to)}
            </li>
          ))
        : null}
      {row.status === "new" ? (
        <li className="flow-muted">
          {brief.map(([column, text]) => `${column}: ${text}`).join(" · ")}
        </li>
      ) : null}
    </ul>
  );
}

function SheetPreview({ sheet }) {
  const headingId = useId();
  const [limit, setLimit] = useState(ROWS_STEP);
  const rows = sheet.later ? [] : listed(sheet);
  const hidden = sheet.rows.length - rows.length;
  const left = rows.length - limit;
  return (
    <section className="bill-import__sheet" aria-labelledby={headingId}>
      <div className="fset__cardhead">
        <h3 id={headingId} className="flow-sec-title">
          {sheet.name}
        </h3>
      </div>
      <Counts counts={sheet.counts} label={`${sheet.name} counts`} />
      {sheet.later ? (
        <p className="fset__cardsub">
          {plural(sheet.counts.notImported, "row")} on this sheet can't be imported yet — this sheet
          is imported from Phase 3. The other sheets import without it.
        </p>
      ) : (
        <>
          {rows.length ? (
            <div className="fset__scroll">
              <table className="flow-table bill-import__rows" aria-label={`${sheet.name} rows`}>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Status</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, limit).map((row) => (
                    <tr key={row.row}>
                      <td>{row.row}</td>
                      <td>
                        <span className={`bill-src bill-import__status--${row.status}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td>
                        <Messages row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {left > 0 ? (
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini bill-import__more"
              onClick={() => setLimit(limit + ROWS_STEP)}
            >
              Show {Math.min(ROWS_STEP, left)} more of {sheet.name} ({left} not shown)
            </button>
          ) : null}
          {hidden > 0 ? (
            <p className="fset__cardsub">
              {plural(hidden, "unchanged row")} not listed — already the same in Scribe.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function ConfirmImport({ open, fileName, preview, busy, onCancel, onConfirm }) {
  const ref = useDialog(open, onCancel);
  if (!open) return null;
  const { counts } = preview;
  return (
    <div className="flow-dialog-backdrop" onClick={onCancel} role="presentation">
      <div
        ref={ref}
        className="flow-card bill-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-confirm-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="import-confirm-title" className="bill-dialog__title">
          Import {fileName}?
        </h2>
        <p>
          {plural(counts.new, "new row")} and {plural(counts.update, "update")} will be saved in one
          go. Nothing is deleted.
        </p>
        <ul className="bill-dialog__list" aria-label="What will be saved">
          {preview.sheets
            .filter((sheet) => !sheet.later && (sheet.counts.new || sheet.counts.update))
            .map((sheet) => (
              <li key={sheet.name}>
                {sheet.name}: {sheet.counts.new} new, {sheet.counts.update} to update
              </li>
            ))}
        </ul>
        {counts.unchanged ? (
          <p className="flow-muted">{plural(counts.unchanged, "unchanged row")} will be skipped.</p>
        ) : null}
        {counts.notImported ? (
          <p className="flow-muted">
            {plural(counts.notImported, "row")} on Phase 3 sheets will not be imported.
          </p>
        ) : null}
        <div className="bill-dialog__actions">
          <button type="button" className="flow-btn flow-btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-primary"
            disabled={busy}
            onClick={onConfirm}
          >
            Yes, import
          </button>
        </div>
      </div>
    </div>
  );
}

function History() {
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError } = useBillingImportHistory({ offset: offset || undefined });
  const imports = data?.imports ?? [];
  return (
    <section className="flow-card" aria-labelledby="import-history-title">
      <div className="fset__cardhead">
        <h2 id="import-history-title" className="flow-sec-title">
          Import history
        </h2>
        {data ? <span className="fset__count">{data.total}</span> : null}
      </div>
      {isError ? (
        <div className="fset__cardsub">Could not load the import history.</div>
      ) : isLoading ? (
        <div className="fset__cardsub">Loading…</div>
      ) : !imports.length ? (
        <div className="fset__cardsub">No file has been imported yet.</div>
      ) : (
        <>
          <div className="fset__scroll">
            <table className="flow-table" aria-label="Past imports">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Imported by</th>
                  <th>When</th>
                  <th>Status</th>
                  <th>Rows</th>
                </tr>
              </thead>
              <tbody>
                {imports.map((i) => (
                  <tr key={i.id}>
                    <td className="bill-import__file">{i.file_name}</td>
                    <td>{i.imported_by_name ?? "—"}</td>
                    <td>{when(i.imported_at)}</td>
                    <td>
                      <span
                        className={`bill-src bill-import__status--${i.status === "saved" ? "new" : "error"}`}
                      >
                        {i.status === "saved" ? "Saved" : "Failed"}
                      </span>
                    </td>
                    <td>
                      <ul className="bill-import__msgs">
                        {Object.entries(i.counts ?? {}).map(([sheet, counts]) => (
                          <li key={sheet}>
                            {sheet}: {savedSummary(counts)}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > data.limit ? (
            <div className="bill-import__pager">
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - data.limit))}
              >
                Newer
              </button>
              <span className="flow-muted">
                {data.offset + 1}–{data.offset + imports.length} of {data.total}
              </span>
              <button
                type="button"
                className="flow-btn flow-btn-ghost flow-btn-mini"
                disabled={data.offset + imports.length >= data.total}
                onClick={() => setOffset(offset + data.limit)}
              >
                Older
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function blockedReason(preview) {
  if (preview.problems.length) return "Fix the problems listed above, then choose the file again.";
  if (preview.counts.error) {
    return "Import is possible once no row has an error. Download errors gives you this file with each problem marked; fix it and choose it again.";
  }
  if (preview.counts.new + preview.counts.update === 0) {
    return "Nothing to save — every row already matches Scribe.";
  }
  return "";
}

export default function BillingImportPage() {
  const pickerId = useId();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const latest = useRef(0);
  const template = useBillingImportTemplate();
  const check = usePreviewBillingImport();
  const commit = useCommitBillingImport();
  const errorFile = useBillingImportErrorFile();

  const download = async (mutation, arg, fallback) => {
    try {
      saveBlob(await mutation.mutateAsync(arg));
    } catch (err) {
      toast(errorOf(err, fallback), "error", 6000);
    }
  };

  const choose = async (e) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    const turn = ++latest.current;
    setFile(picked);
    setPreview(null);
    setError("");
    setNotice("");
    setSaved(null);
    setConfirming(false);
    try {
      const result = await check.mutateAsync(picked);
      if (turn === latest.current) setPreview(result);
    } catch (err) {
      if (turn === latest.current) setError(errorOf(err, "Could not check the file"));
    }
  };

  const importNow = async () => {
    const turn = latest.current;
    const current = file;
    setError("");
    setNotice("");
    try {
      const result = await commit.mutateAsync(current);
      if (turn !== latest.current) return;
      setConfirming(false);
      if (result.saved) {
        setSaved({
          fileName: current.name,
          importedAt: result.importedAt,
          preview: result.preview,
        });
        setPreview(null);
        setFile(null);
        toast(`Imported ${current.name}`, "success");
      } else {
        setPreview(result.preview);
        setNotice(
          "Nothing was saved. The file was checked again against Scribe's data as it is now, and the result is below.",
        );
      }
    } catch (err) {
      if (turn !== latest.current) return;
      setConfirming(false);
      setError(errorOf(err, "Could not import the file"));
    }
  };

  const reason = preview ? blockedReason(preview) : "";

  return (
    <div className="flow-root fset bill-settings">
      <section className="flow-card" aria-labelledby="import-upload-title">
        <div className="fset__cardhead">
          <h2 id="import-upload-title" className="flow-sec-title">
            Bulk import
          </h2>
        </div>
        <div className="fset__cardsub">
          Fill in the template and upload it. Every row is checked first and nothing is saved until
          you press Import; the whole file is then saved in one go, or not at all. An import only
          adds and updates — to retire a row, set active to no.
        </div>
        <div className="bill-form">
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            disabled={template.isPending}
            onClick={() => download(template, undefined, "Could not download the template")}
          >
            Download template
          </button>
          <div className="fset__field">
            <label htmlFor={pickerId}>Filled-in template (.xlsx)</label>
            <input
              id={pickerId}
              type="file"
              accept={XLSX_ACCEPT}
              className="bill-import__picker"
              disabled={check.isPending || commit.isPending}
              onChange={choose}
            />
          </div>
        </div>
        {check.isPending && file ? (
          <p className="fset__cardsub bill-import__state" role="status">
            Checking {file.name}…
          </p>
        ) : null}
        {error ? (
          <p className="bill-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {saved ? (
        <section
          className="flow-card bill-import__done"
          role="status"
          aria-labelledby="import-done-title"
        >
          <div className="fset__cardhead">
            <h2 id="import-done-title" className="flow-sec-title">
              Imported {saved.fileName}
            </h2>
          </div>
          <div className="fset__cardsub">Saved {when(saved.importedAt)}.</div>
          <ul className="bill-dialog__list" aria-label="What was saved">
            {saved.preview.sheets
              .filter((sheet) => !sheet.later)
              .map((sheet) => (
                <li key={sheet.name}>
                  {sheet.name}: {savedSummary(sheet.counts)}
                </li>
              ))}
          </ul>
          {saved.preview.counts.notImported ? (
            <p className="flow-muted">
              {plural(saved.preview.counts.notImported, "row")} on Phase 3 sheets were not imported.
            </p>
          ) : null}
        </section>
      ) : null}

      {preview && file ? (
        <section className="flow-card" aria-labelledby="import-preview-title">
          <div className="fset__cardhead">
            <h2 id="import-preview-title" className="flow-sec-title">
              Preview
            </h2>
            <span className="bill-import__file flow-muted">{file.name}</span>
          </div>
          {notice ? (
            <p className="bill-dialog__error" role="alert">
              {notice}
            </p>
          ) : null}
          {preview.problems.length ? (
            <div role="alert">
              <p className="bill-dialog__error">This file can't be imported:</p>
              <ul className="bill-import__problems" aria-label="Problems with the file">
                {preview.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          ) : (
            <Counts counts={preview.counts} label="All sheets" />
          )}
          <div className="bill-import__actions">
            <button
              type="button"
              className="flow-btn flow-btn-primary"
              disabled={!preview.canImport || commit.isPending}
              onClick={() => setConfirming(true)}
            >
              Import
            </button>
            {preview.counts.error ? (
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                disabled={errorFile.isPending}
                onClick={() => download(errorFile, file, "Could not download the error file")}
              >
                Download errors
              </button>
            ) : null}
          </div>
          {reason ? <p className="fset__cardsub bill-import__reason">{reason}</p> : null}
          {preview.sheets.map((sheet) => (
            <SheetPreview key={sheet.name} sheet={sheet} />
          ))}
        </section>
      ) : null}

      <History />

      <ConfirmImport
        open={confirming && Boolean(preview && file)}
        fileName={file?.name}
        preview={preview}
        busy={commit.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={importNow}
      />
    </div>
  );
}
