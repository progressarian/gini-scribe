import { useCallback, useId, useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import {
  useBillingImportHistory,
  useBillingImportTemplate,
  useCreateBillingImportSession,
} from "../../queries/hooks/useBillingMaster";
import { toast } from "../../stores/uiStore";
import ImportSession from "../../components/billing/ImportSession";
import { requestErrorOf } from "../../components/billing/format";
import { saveBlob, when } from "../../components/billing/importText";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";

const XLSX_ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILTER_KEYS = ["status", "outcome", "sheet", "q", "page", "row"];

const savedSummary = (counts) =>
  [
    counts.new ? `${counts.new} new` : null,
    counts.update ? `${counts.update} updated` : null,
    counts.unchanged ? `${counts.unchanged} unchanged` : null,
    counts.kept ? `${counts.kept} kept` : null,
    counts.failed ? `${counts.failed} failed` : null,
  ]
    .filter(Boolean)
    .join(", ") || "nothing";

function History() {
  const [offset, setOffset] = useState(0);
  const { data, isLoading, isError } = useBillingImportHistory({ offset: offset || undefined });
  const imports = data?.imports ?? [];
  return (
    <section className="flow-card bill-stack" aria-labelledby="import-history-title">
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
                    <td data-label="File" className="bill-import__file">
                      <FileSpreadsheet size={15} aria-hidden="true" />
                      {i.file_name}
                      {i.session_id ? (
                        <Link
                          className="bill-import__jump"
                          to={`?session=${i.session_id}`}
                          aria-label={`View the report for ${i.file_name}`}
                          onClick={() => window.scrollTo({ top: 0 })}
                        >
                          View report
                        </Link>
                      ) : null}
                    </td>
                    <td data-label="Imported by">{i.imported_by_name ?? "—"}</td>
                    <td data-label="When">{when(i.imported_at)}</td>
                    <td data-label="Status">
                      <span
                        className={`bill-status bill-import__state--${i.status === "saved" ? "ok" : "failed"}`}
                      >
                        {i.status === "saved" ? "Saved" : "Failed"}
                      </span>
                    </td>
                    <td data-label="Rows">
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

export default function BillingImportPage() {
  const pickerId = useId();
  const picker = useRef(null);
  const [params, setParams] = useSearchParams();
  const [file, setFile] = useState(null);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState([]);
  const [dragging, setDragging] = useState(false);
  const latest = useRef(0);
  const template = useBillingImportTemplate();
  const create = useCreateBillingImportSession();

  const sessionId = params.get("session") ?? "";
  const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? ""]));

  const setFilters = useCallback(
    (patch, replace = false) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) {
            if (value) next.set(key, value);
            else next.delete(key);
          }
          if (!("page" in patch)) next.delete("page");
          if (!("row" in patch)) next.delete("row");
          return next;
        },
        { replace },
      ),
    [setParams],
  );

  const closeSession = useCallback(() => setParams(new URLSearchParams()), [setParams]);

  const uploadAgain = () => {
    picker.current?.focus();
    picker.current?.click();
  };

  const downloadTemplate = async () => {
    try {
      saveBlob(await template.mutateAsync());
    } catch (err) {
      toast(requestErrorOf(err, "Could not download the template"), "error", 6000);
    }
  };

  const choose = async (e) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    await upload(picked);
  };

  const drop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (!create.isPending) upload(e.dataTransfer.files?.[0]);
  };

  const upload = async (picked) => {
    if (!picked) return;
    const turn = ++latest.current;
    setFile(picked);
    setError("");
    setProblems([]);
    try {
      const session = await create.mutateAsync(picked);
      if (turn === latest.current) setParams(new URLSearchParams({ session: session.id }));
    } catch (err) {
      if (turn !== latest.current) return;
      setError(requestErrorOf(err, "Could not check the file"));
      setProblems(err?.response?.data?.problems ?? []);
    }
  };

  return (
    <div className="flow-root fset bill-ui bill-settings bill-import-page">
      <section className="flow-card" aria-labelledby="import-upload-title">
        <div className="fset__cardhead">
          <h2 id="import-upload-title" className="flow-sec-title">
            Bulk import
          </h2>
        </div>
        <div className="fset__cardsub">
          Add or update groups, services, categories and rates in one go. Nothing is saved until you
          press Commit: every row is checked first and sorted into Ready, Needs override, Failed and
          Unchanged. A change to a row already in Scribe is saved only if you choose Override for
          it. An import only adds and updates — to retire a row, set active to no.
        </div>
        <ol className="bill-import__steps">
          <li className="bill-import__step">
            <span className="bill-import__num">1</span>
            <div className="bill-import__body">
              <strong>Download the template</strong>
              <span className="bill-import__hint">
                One sheet per kind of data, with the columns already named.
              </span>
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                disabled={template.isPending}
                onClick={downloadTemplate}
              >
                <Download size={15} aria-hidden="true" />
                Download template
              </button>
            </div>
          </li>
          <li className="bill-import__step">
            <span className="bill-import__num">2</span>
            <div className="bill-import__body">
              <strong>Fill it in</strong>
              <span className="bill-import__hint">
                Keep the column names in row 1. Leave a cell empty to use its default — the Read me
                sheet lists them.
              </span>
            </div>
          </li>
          <li className="bill-import__step">
            <span className="bill-import__num">3</span>
            <div className="bill-import__body">
              <strong>Upload it</strong>
              <div
                className={`bill-import__drop${dragging ? " bill-import__drop--over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={drop}
              >
                <Upload size={20} aria-hidden="true" />
                <label htmlFor={pickerId}>Filled-in template (.xlsx)</label>
                <span className="bill-import__hint">Choose the file, or drag it here</span>
                <input
                  id={pickerId}
                  ref={picker}
                  type="file"
                  accept={XLSX_ACCEPT}
                  className="bill-import__picker"
                  disabled={create.isPending}
                  onChange={choose}
                />
              </div>
            </div>
          </li>
        </ol>
        {create.isPending && file ? (
          <p className="fset__cardsub bill-import__state" role="status">
            Checking {file.name}…
          </p>
        ) : null}
        {error ? (
          <div role="alert" className="bill-import__error">
            <p className="bill-dialog__error">{error}</p>
            {problems.length ? (
              <ul className="bill-import__problems" aria-label="Problems with the file">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>

      {sessionId ? (
        <ImportSession
          key={sessionId}
          id={sessionId}
          filters={filters}
          setFilters={setFilters}
          onClose={closeSession}
          onUploadAgain={uploadAgain}
        />
      ) : null}

      <History />
    </div>
  );
}
