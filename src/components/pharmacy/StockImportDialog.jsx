import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Upload } from "lucide-react";
import useDialog from "../billing/useDialog";
import BillDialogLayer from "../billing/BillDialogLayer";
import { requestErrorOf } from "../billing/format";
import { plural } from "../billing/importText";
import { downloadFile } from "../../lib/downloadBlob";
import PillGroup from "./Pills";
import { inr } from "./format";
import { stockImportSource } from "../../queries/hooks/usePharmacySheets";
import {
  STOCK_IMPORT_BASE,
  STOCK_IMPORT_INVALIDATE,
  STOCK_IMPORT_TEMPLATE_URL,
} from "../../queries/hooks/usePharmacyPurchases";
import "./SheetImportDialog.css";

const XLSX_ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PAGE = 50;
const source = stockImportSource(STOCK_IMPORT_BASE);

function Tiles({ tiles }) {
  return (
    <dl className="phs-tiles sid-tiles">
      {tiles.map(([label, value]) => (
        <div className="phs-tile" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function LeftOut({ rows }) {
  return rows.map((r) => (
    <li key={r.row} className="sid-problem">
      <div className="sid-conflict__head">
        <span className="sid-row">Row {r.row}</span>
        <strong className="sid-key">{r.name}</strong>
        {r.batch_no ? <span className="phs-meta">Batch {r.batch_no}</span> : null}
      </div>
      <ul className="sid-errors">
        <li>{r.reason}</li>
      </ul>
    </li>
  ));
}

function Merged({ rows }) {
  return rows.map((m) => (
    <li key={`${m.name}|${m.batch_no}|${m.rows[0].row}`} className="sid-conflict">
      <div className="sid-conflict__head">
        <strong className="sid-key">{m.name}</strong>
        <span className="phs-meta">Batch {m.batch_no}</span>
        <span className="phs-meta sid-existing">
          {m.pricesDiffer ? "Different prices, highest kept" : "Same price"}
        </span>
      </div>
      <table className="flow-table sid-changes" aria-label={`Rows merged for ${m.name}`}>
        <thead>
          <tr>
            <th scope="col">Row</th>
            <th scope="col">Qty (packs)</th>
            <th scope="col">MRP</th>
            <th scope="col">Sale rate</th>
            <th scope="col">Purchase rate</th>
            <th scope="col">Vendor</th>
          </tr>
        </thead>
        <tbody>
          {m.rows.map((r) => (
            <tr key={r.row}>
              <th scope="row">{r.row}</th>
              <td>{r.qty_packs}</td>
              <td>{inr(r.mrp)}</td>
              <td>{inr(r.sale_rate)}</td>
              <td>{inr(r.purchase_rate)}</td>
              <td>{r.vendor ?? "No vendor"}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Imported as</th>
            <td>
              <strong>{m.qty_packs}</strong>
            </td>
            <td>
              <strong>{inr(m.mrp)}</strong>
            </td>
            <td>
              <strong>{inr(m.sale_rate)}</strong>
            </td>
            <td>
              <strong>{inr(m.purchase_rate)}</strong>
            </td>
            <td />
          </tr>
        </tbody>
      </table>
    </li>
  ));
}

function Warnings({ rows }) {
  return rows.map((w) => (
    <li key={w.row} className="sid-plain">
      <span className="sid-row">Row {w.row}</span>
      <strong className="sid-key">{w.name}</strong>
      <span className="phs-meta">Batch {w.batch_no}</span>
      <span className="phs-meta">
        LP in sheet {inr(w.sheet)}, Scribe works out {inr(w.scribe)}
      </span>
    </li>
  ));
}

function Vendors({ rows }) {
  return rows.map((name) => (
    <li key={name} className="sid-plain">
      <strong className="sid-key">{name}</strong>
      <span className="bill-status phs-badge phs-badge--ok">New vendor</span>
    </li>
  ));
}

function Result({ result }) {
  const { match } = result;
  return (
    <div className="sid-result" role="status">
      <p className="sid-result__title">Stock imported</p>
      <ul className="bill-dialog__list">
        <li>
          <strong>{result.created.batches}</strong> batches loaded as opening stock
        </li>
        <li>
          <strong>{result.created.medicines}</strong> new medicines and{" "}
          <strong>{result.created.vendors}</strong> new vendors created
        </li>
        {result.leftOut ? (
          <li>
            <strong>{result.leftOut}</strong> rows left out
          </li>
        ) : null}
        <li>
          Stock check: <strong>{match.matched}</strong> of {match.checked} batches match the sheet
        </li>
      </ul>
      {match.mismatches.length ? (
        <>
          <p className="bill-dialog__error">
            {plural(match.mismatches.length, "batch", "batches")} do not match the sheet:
          </p>
          <ul className="sid-errors">
            {match.mismatches.map((m) => (
              <li key={`${m.name}|${m.batch_no}`}>
                <strong>
                  {m.name} · {m.batch_no}:
                </strong>{" "}
                sheet {m.sheet}, Scribe {m.scribe} packs
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="phs-meta">Opening stock receipts:</p>
      <ul className="sid-errors">
        {result.receipts.map((r) => (
          <li key={r.id}>
            <Link to={`/pharmacy/purchases/${r.id}`}>{r.receipt_no}</Link> ·{" "}
            {plural(r.lines, "batch", "batches")} · {inr(r.net_amount)}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StockImportDialog({ onClose }) {
  const titleId = useId();
  const confirmId = useId();
  const picker = useRef(null);
  const queryClient = useQueryClient();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [view, setView] = useState("leftOut");
  const [shownCount, setShownCount] = useState(PAGE);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const ref = useDialog(true, () => (busy ? null : onClose()));

  const check = async (chosen) => {
    setBusy("checking");
    setError("");
    setResult(null);
    setConfirmed(false);
    try {
      const data = await source.check(chosen);
      setPreview(data);
      setShownCount(PAGE);
      setView(data.counts.leftOut ? "leftOut" : data.counts.merged ? "merged" : "vendors");
    } catch (err) {
      setPreview(null);
      setError(requestErrorOf(err, "Could not read the sheet"));
    } finally {
      setBusy("");
    }
  };

  const choose = (e) => {
    const chosen = e.target.files?.[0];
    e.target.value = "";
    if (!chosen) return;
    setFile(chosen);
    check(chosen);
  };

  const apply = async () => {
    setBusy("importing");
    setError("");
    try {
      const done = await source.apply(file, preview.hash);
      setResult(done);
      setPreview(null);
      for (const queryKey of STOCK_IMPORT_INVALIDATE) queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      setError(requestErrorOf(err, "Could not import the stock"));
    } finally {
      setBusy("");
    }
  };

  const downloadLeftOut = async () => {
    setError("");
    try {
      await source.problems(file, "pharmacy-stock-rows-left-out.xlsx");
    } catch (err) {
      setError(requestErrorOf(err, "Could not make the file of rows left out"));
    }
  };

  const counts = preview?.counts;
  const lists = preview
    ? {
        leftOut: preview.leftOut,
        merged: preview.merged,
        warnings: preview.warnings,
        vendors: preview.newVendors,
      }
    : {};
  const views = counts
    ? [
        { key: "leftOut", label: `Left out (${counts.leftOut})` },
        { key: "merged", label: `Merged (${counts.merged})` },
        { key: "warnings", label: `Landing rate differs (${counts.warnings})` },
        { key: "vendors", label: `New vendors (${counts.vendors})` },
      ]
    : [];
  const listed = lists[view] ?? [];
  const visible = listed.slice(0, shownCount);
  const List = { leftOut: LeftOut, merged: Merged, warnings: Warnings, vendors: Vendors }[view];

  return (
    <BillDialogLayer>
      <div
        className="flow-dialog-backdrop"
        role="presentation"
        onClick={() => (busy ? null : onClose())}
      >
        <section
          ref={ref}
          className={`flow-card bill-dialog bill-dialog--wide sid${preview ? " sid--tall" : ""}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={Boolean(busy)}
          onClick={(e) => e.stopPropagation()}
        >
          <header className="sid-head">
            <h2 id={titleId} className="bill-dialog__title">
              Import stock from Excel
            </h2>
            <p className="phs-meta sid-intro">
              Upload the DARPAN Batch Wise Stock Report or the Scribe template. Missing vendors and
              medicines are created, and every batch is loaded as opening stock. Nothing is saved
              until you confirm.
            </p>
          </header>

          <div className="sid-file">
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() =>
                downloadFile(
                  STOCK_IMPORT_TEMPLATE_URL,
                  "pharmacy-stock-import-template.xlsx",
                ).catch((err) => setError(err.message))
              }
            >
              <Download size={15} aria-hidden="true" />
              Download template
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-primary"
              disabled={Boolean(busy)}
              onClick={() => picker.current?.click()}
            >
              <Upload size={15} aria-hidden="true" />
              {file ? "Choose another file" : "Choose stock sheet"}
            </button>
            <input
              ref={picker}
              type="file"
              accept={XLSX_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-label="Stock sheet file"
              onChange={choose}
            />
            {file ? (
              <span className="sid-filename">
                <FileSpreadsheet size={14} aria-hidden="true" />
                {file.name}
              </span>
            ) : null}
          </div>

          {busy === "checking" ? (
            <p className="phs-empty" role="status">
              Checking every row…
            </p>
          ) : null}

          {preview ? (
            <>
              <Tiles
                tiles={[
                  ["Batches to import", counts.batches],
                  ["New medicines", counts.medicines],
                  ["New vendors", counts.vendors],
                  ["Rows left out", counts.leftOut],
                ]}
              />
              <p className="phs-meta">
                {plural(counts.rows, "row")} read. {preview.totals.packs.toLocaleString("en-IN")}{" "}
                packs worth {inr(preview.totals.purchase)} at purchase rate and{" "}
                {inr(preview.totals.sale)} at sale rate.
              </p>
              <div className="sid-views">
                <PillGroup
                  label="Show"
                  value={view}
                  options={views}
                  onChange={(key) => {
                    setView(key);
                    setShownCount(PAGE);
                  }}
                />
                {counts.leftOut ? (
                  <button
                    type="button"
                    className="flow-btn flow-btn-ghost flow-btn-mini"
                    onClick={downloadLeftOut}
                  >
                    <Download size={13} aria-hidden="true" />
                    Download rows left out
                  </button>
                ) : null}
              </div>
              {view === "warnings" && listed.length ? (
                <p className="sid-hint">
                  Scribe works out the landing rate as purchase rate plus GST. These rows are still
                  imported; check the purchase rate or GST if the difference matters.
                </p>
              ) : null}
              {listed.length ? (
                <ul className="sid-list" aria-label="Sheet rows">
                  <List rows={visible} />
                </ul>
              ) : (
                <p className="phs-empty">Nothing in this list.</p>
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
              {counts.batches ? (
                <label className="sid-choice" htmlFor={confirmId}>
                  <input
                    id={confirmId}
                    type="checkbox"
                    checked={confirmed}
                    disabled={Boolean(busy)}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I have checked the summary. Add {plural(counts.batches, "batch", "batches")} to
                  stock
                  {counts.leftOut ? ` and leave out ${plural(counts.leftOut, "row")}` : ""}.
                </label>
              ) : null}
            </>
          ) : null}

          {result ? <Result result={result} /> : null}

          {error ? (
            <p className="bill-dialog__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="bill-dialog__actions">
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
                disabled={Boolean(busy) || !counts.batches || !confirmed}
                onClick={apply}
              >
                {busy === "importing"
                  ? "Importing…"
                  : counts.batches
                    ? `Import ${plural(counts.batches, "batch", "batches")}`
                    : "Nothing to import"}
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </BillDialogLayer>
  );
}
