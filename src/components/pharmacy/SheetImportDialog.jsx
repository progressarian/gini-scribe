import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { requestErrorOf } from "../billing/format";
import { plural } from "../billing/importText";
import { downloadFile } from "../../lib/downloadBlob";
import PillGroup from "./Pills";
import "./SheetImportDialog.css";

const XLSX_ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PAGE = 50;

const shown = (value) =>
  value === null || value === undefined || value === "" ? "Not set" : String(value);

const STATUS = {
  new: { text: "New", tone: "ok" },
  same: { text: "No change", tone: "muted" },
  conflict: { text: "Conflict", tone: "review" },
  error: { text: "Needs fixing", tone: "out" },
};

function Counts({ counts }) {
  const tiles = [
    { label: "New", value: counts.new },
    { label: "Conflicts to decide", value: counts.conflict },
    { label: "Need fixing", value: counts.error },
    { label: "No change", value: counts.same },
  ];
  return (
    <dl className="phs-tiles sid-tiles">
      {tiles.map((t) => (
        <div className="phs-tile" key={t.label}>
          <dt>{t.label}</dt>
          <dd>{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Conflict({ row, rowLabel, decision, onDecide, disabled }) {
  const name = `${rowLabel} ${row.row}, ${row.key}`;
  return (
    <li className="sid-conflict">
      <div className="sid-conflict__head">
        <span className="sid-row">
          {rowLabel} {row.row}
        </span>
        <strong className="sid-key">{row.key}</strong>
        {row.label ? <span className="phs-meta">{row.label}</span> : null}
        {row.existing?.label ? (
          <span className="phs-meta sid-existing">Matches {row.existing.label}</span>
        ) : null}
      </div>
      {row.note ? <p className="sid-note">{row.note}</p> : null}
      <table className="flow-table sid-changes" aria-label={`Differences for ${name}`}>
        <thead>
          <tr>
            <th scope="col">Column</th>
            <th scope="col">Current</th>
            <th scope="col">In the sheet</th>
          </tr>
        </thead>
        <tbody>
          {row.changes.map((c) => (
            <tr key={c.field}>
              <th scope="row">{c.column}</th>
              <td className="sid-from">{shown(c.from)}</td>
              <td className="sid-to">{shown(c.to)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="sid-choices" disabled={disabled}>
        <legend className="sr-only">What to do with {name}</legend>
        {row.choices.map((c) => (
          <label key={c.value} className={`sid-choice${decision === c.value ? " is-on" : ""}`}>
            <input
              type="radio"
              name={`sid-${row.row}`}
              value={c.value}
              checked={decision === c.value}
              onChange={() => onDecide(row.row, c.value)}
            />
            {c.label}
          </label>
        ))}
      </fieldset>
    </li>
  );
}

function Problem({ row, rowLabel }) {
  return (
    <li className="sid-problem">
      <div className="sid-conflict__head">
        <span className="sid-row">
          {rowLabel} {row.row}
        </span>
        <strong className="sid-key">{row.key}</strong>
        {row.label ? <span className="phs-meta">{row.label}</span> : null}
      </div>
      <ul className="sid-errors">
        {row.errors.map((e, i) => (
          <li key={i}>
            {e.column ? <strong>{e.column}: </strong> : null}
            {e.message}
          </li>
        ))}
      </ul>
    </li>
  );
}

function Plain({ row, rowLabel }) {
  const tone = STATUS[row.status];
  return (
    <li className="sid-plain">
      <span className="sid-row">
        {rowLabel} {row.row}
      </span>
      <strong className="sid-key">{row.key}</strong>
      {row.label ? <span className="phs-meta">{row.label}</span> : null}
      <span className={`bill-status phs-badge phs-badge--${tone.tone}`}>{tone.text}</span>
    </li>
  );
}

function Result({ result, noun }) {
  const lines = [
    [result.created, `new ${noun}${result.created === 1 ? "" : "s"} added`],
    [result.updated, "updated from the sheet"],
    [result.added, "had quantities added together"],
    [result.kept, "kept as they were"],
    [result.unchanged, "had no change"],
    [result.skipped, "need fixing and were not imported"],
  ].filter(([n]) => n);
  return (
    <div className="sid-result" role="status">
      <p className="sid-result__title">Import finished</p>
      <ul className="bill-dialog__list">
        {lines.map(([n, text]) => (
          <li key={text}>
            <strong>{n}</strong> {text}
          </li>
        ))}
      </ul>
      {result.failed?.length ? (
        <>
          <p className="bill-dialog__error">
            {plural(result.failed.length, "row")} could not be saved:
          </p>
          <ul className="sid-errors">
            {result.failed.map((f) => (
              <li key={f.row}>
                <strong>
                  Row {f.row} · {f.key}:
                </strong>{" "}
                {f.message}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export default function SheetImportDialog({
  title,
  intro,
  noun,
  source,
  template = null,
  sample = null,
  problemsName = "rows-to-fix.xlsx",
  rowLabel = "Row",
  needsFile = true,
  emptyText = "The sheet has no rows.",
  onImported,
  onClose,
}) {
  const titleId = useId();
  const picker = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [view, setView] = useState("conflict");
  const [shownCount, setShownCount] = useState(PAGE);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const ref = useDialog(true, () => (busy ? null : onClose()));

  const check = async (chosen) => {
    setBusy("checking");
    setError("");
    setResult(null);
    try {
      const data = await source.check(chosen);
      setPreview(data);
      setDecisions({});
      setShownCount(PAGE);
      setView(
        data.counts.conflict
          ? "conflict"
          : data.counts.error
            ? "error"
            : data.counts.new
              ? "new"
              : "all",
      );
    } catch (err) {
      setPreview(null);
      setError(requestErrorOf(err, "Could not read the sheet"));
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    if (!needsFile) check(null);
  }, []);

  const choose = (e) => {
    const chosen = e.target.files?.[0];
    e.target.value = "";
    if (!chosen) return;
    setFile(chosen);
    check(chosen);
  };

  const rows = preview?.rows ?? [];
  const conflicts = useMemo(() => rows.filter((r) => r.status === "conflict"), [rows]);
  const undecided = conflicts.filter((r) => !decisions[r.row]).length;
  const toSave =
    (preview?.counts.new ?? 0) +
    conflicts.filter((r) => decisions[r.row] && !["keep", "skip"].includes(decisions[r.row]))
      .length;
  const bulkChoices = useMemo(() => {
    const seen = new Map();
    for (const r of conflicts)
      for (const c of r.choices) if (!seen.has(c.value)) seen.set(c.value, c);
    return [...seen.values()];
  }, [conflicts]);

  const decide = (row, decision) => setDecisions((d) => ({ ...d, [row]: decision }));
  const decideAll = (decision) =>
    setDecisions(
      Object.fromEntries(
        conflicts.map((r) => [
          r.row,
          r.choices.some((c) => c.value === decision)
            ? decision
            : (decisions[r.row] ?? r.choices[0].value),
        ]),
      ),
    );

  const apply = async () => {
    setBusy("importing");
    setError("");
    try {
      const done = await source.apply(file, decisions);
      setResult(done);
      setPreview(null);
      onImported?.(done);
    } catch (err) {
      setError(requestErrorOf(err, "Could not import the sheet"));
    } finally {
      setBusy("");
    }
  };

  const downloadProblems = async () => {
    setError("");
    try {
      await source.problems(file, problemsName);
    } catch (err) {
      setError(requestErrorOf(err, "Could not make the file of rows to fix"));
    }
  };

  const listed = rows.filter((r) => view === "all" || r.status === view);
  const visible = listed.slice(0, shownCount);
  const views = [
    { key: "conflict", label: `Conflicts (${preview?.counts.conflict ?? 0})` },
    { key: "error", label: `Need fixing (${preview?.counts.error ?? 0})` },
    { key: "new", label: `New (${preview?.counts.new ?? 0})` },
    { key: "all", label: `All (${rows.length})` },
  ];

  return (
    <BillDialogLayer>
      <div
        className="flow-dialog-backdrop"
        role="presentation"
        onClick={() => (busy ? null : onClose())}
      >
        <section
          ref={ref}
          className="flow-card bill-dialog bill-dialog--wide sid"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={Boolean(busy)}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="sid-head">
            <h2 id={titleId} className="bill-dialog__title">
              {title}
            </h2>
            {intro ? <p className="phs-meta sid-intro">{intro}</p> : null}
          </header>

          {needsFile ? (
            <div className="sid-file">
              {template ? (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost"
                  onClick={() =>
                    downloadFile(template.url, template.name).catch((err) => setError(err.message))
                  }
                >
                  <Download size={15} aria-hidden="true" />
                  Download sheet
                </button>
              ) : null}
              {sample ? (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost"
                  onClick={() =>
                    downloadFile(sample.url, sample.name).catch((err) => setError(err.message))
                  }
                >
                  <FileSpreadsheet size={15} aria-hidden="true" />
                  Download sample
                </button>
              ) : null}
              <button
                type="button"
                className="flow-btn flow-btn-primary"
                disabled={Boolean(busy)}
                onClick={() => picker.current?.click()}
              >
                <Upload size={15} aria-hidden="true" />
                {file ? "Choose another file" : "Choose filled sheet"}
              </button>
              <input
                ref={picker}
                type="file"
                accept={XLSX_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-label={`${title} file`}
                onChange={choose}
              />
              {file ? (
                <span className="sid-filename">
                  <FileSpreadsheet size={14} aria-hidden="true" />
                  {file.name}
                </span>
              ) : null}
            </div>
          ) : null}

          {busy === "checking" ? (
            <p className="phs-empty" role="status">
              Checking every row…
            </p>
          ) : null}

          {preview ? (
            <>
              <Counts counts={preview.counts} />
              {preview.counts.conflict ? (
                <div className="sid-bulk" role="group" aria-label="Decide every conflict at once">
                  <span className="phs-meta">For every conflict:</span>
                  {bulkChoices.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className="flow-btn flow-btn-ghost flow-btn-mini"
                      onClick={() => decideAll(c.value)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="sid-views">
                <PillGroup
                  label="Show rows"
                  value={view}
                  options={views}
                  onChange={(key) => {
                    setView(key);
                    setShownCount(PAGE);
                  }}
                />
                {preview.counts.error && source.problems ? (
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost flow-btn-mini"
                    onClick={downloadProblems}
                  >
                    <Download size={13} aria-hidden="true" />
                    Download rows to fix
                  </button>
                ) : null}
              </div>
              {!rows.length ? (
                <p className="phs-empty">{emptyText}</p>
              ) : !listed.length ? (
                <p className="phs-empty">Nothing in this list.</p>
              ) : (
                <ul className="sid-list" aria-label="Sheet rows">
                  {visible.map((r) =>
                    r.status === "conflict" ? (
                      <Conflict
                        key={r.row}
                        row={r}
                        rowLabel={rowLabel}
                        decision={decisions[r.row]}
                        onDecide={decide}
                        disabled={Boolean(busy)}
                      />
                    ) : r.status === "error" ? (
                      <Problem key={r.row} row={r} rowLabel={rowLabel} />
                    ) : (
                      <Plain key={r.row} row={r} rowLabel={rowLabel} />
                    ),
                  )}
                </ul>
              )}
              {listed.length > shownCount ? (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost sid-more"
                  onClick={() => setShownCount((n) => n + PAGE)}
                >
                  Show {Math.min(PAGE, listed.length - shownCount)} more
                </button>
              ) : null}
              {preview.counts.error ? (
                <p className="sid-hint">
                  Rows that need fixing are not imported. Import the rest now, then fix those rows
                  and upload them again to continue.
                </p>
              ) : null}
            </>
          ) : null}

          {result ? <Result result={result} noun={noun} /> : null}

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="bill-dialog__actions">
            {result && needsFile ? (
              <button
                type="button"
                className="flow-btn flow-btn-ghost"
                onClick={() => {
                  setResult(null);
                  setFile(null);
                  picker.current?.click();
                }}
              >
                Upload another sheet
              </button>
            ) : null}
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              disabled={Boolean(busy)}
              onClick={onClose}
            >
              {result ? "Close" : "Cancel"}
            </button>
            {preview ? (
              <button
                type="button"
                className="flow-btn flow-btn-primary"
                disabled={Boolean(busy) || undecided > 0 || toSave === 0}
                onClick={apply}
              >
                {busy === "importing"
                  ? "Importing…"
                  : undecided
                    ? `Decide ${plural(undecided, "conflict")} first`
                    : toSave
                      ? `Import ${plural(toSave, "row")}`
                      : "Nothing to import"}
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </BillDialogLayer>
  );
}
