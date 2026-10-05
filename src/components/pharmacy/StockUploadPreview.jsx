import { useState } from "react";
import { rupees, requestErrorOf } from "../billing/format";
import { when, plural } from "../billing/importText";
import { toast } from "../../stores/uiStore";
import {
  useCommitStockUpload,
  useDiscardStockUpload,
  useStockUpload,
} from "../../queries/hooks/usePharmacyStock";

const qty = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN"));

function Section({ title, count, children, open = false }) {
  if (!count) return null;
  return (
    <details className="phs-prev__sect" open={open}>
      <summary>
        {title} <span className="fset__count">{count}</span>
      </summary>
      {children}
    </details>
  );
}

function ItemTable({ rows, label, showOld = true, showNew = true, extra }) {
  return (
    <div className="fset__scroll phs-prev__table">
      <table className="flow-table" aria-label={label}>
        <thead>
          <tr>
            <th>Item</th>
            {showOld ? <th className="phs-num">Was</th> : null}
            {showNew ? <th className="phs-num">Now</th> : null}
            {extra ? <th>{extra.title}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.itemKey}>
              <td data-label="Item">{r.itemName}</td>
              {showOld ? (
                <td data-label="Was" className="phs-num">
                  {qty(r.oldQty)}
                </td>
              ) : null}
              {showNew ? (
                <td data-label="Now" className="phs-num">
                  {qty(r.newQty)}
                </td>
              ) : null}
              {extra ? <td data-label={extra.title}>{extra.render(r)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StockUploadPreview({ id, onDone }) {
  const { data: upload, isLoading, isError } = useStockUpload(id);
  const commit = useCommitStockUpload();
  const discard = useDiscardStockUpload();
  const [error, setError] = useState("");
  const busy = commit.isPending || discard.isPending;

  if (isLoading) {
    return (
      <section className="flow-card" role="status">
        Loading the upload…
      </section>
    );
  }
  if (isError || !upload) {
    return (
      <section className="flow-card" role="alert">
        <p className="bill-dialog__error">Could not load this upload.</p>
        <button type="button" className="flow-btn flow-btn-ghost" onClick={onDone}>
          Close
        </button>
      </section>
    );
  }

  if (upload.status !== "preview") {
    return (
      <section className="flow-card phs-prev" aria-labelledby="phs-prev-title">
        <h2 id="phs-prev-title" className="flow-sec-title">
          {upload.status === "committed" ? "Stock updated" : "Upload discarded"}
        </h2>
        <p className="fset__cardsub">
          {upload.fileName} ·{" "}
          {upload.status === "committed"
            ? `applied ${when(upload.committedAt)}${upload.committedBy ? ` by ${upload.committedBy}` : ""}`
            : "nothing was changed"}
        </p>
        <button type="button" className="flow-btn flow-btn-ghost" onClick={onDone}>
          Close
        </button>
      </section>
    );
  }

  const { added, changed, goingOut, unchangedCount } = upload.diff;
  const needLinking = added.filter((a) => !a.autoLinked).length;

  const apply = async () => {
    setError("");
    try {
      await commit.mutateAsync(id);
      toast("Stock updated from the uploaded report");
    } catch (e) {
      setError(requestErrorOf(e, "Could not apply the stock update"));
    }
  };

  const cancel = async () => {
    setError("");
    try {
      await discard.mutateAsync(id);
      onDone();
    } catch (e) {
      setError(requestErrorOf(e, "Could not discard the upload"));
    }
  };

  return (
    <section className="flow-card phs-prev" aria-labelledby="phs-prev-title">
      <div className="fset__cardhead phs-prev__head">
        <h2 id="phs-prev-title" className="flow-sec-title">
          Check before applying
        </h2>
        <span className="bill-status phs-badge phs-badge--review">Not applied yet</span>
        <div className="phs-prev__acts">
          <button
            type="button"
            className="flow-btn flow-btn-ghost"
            disabled={busy}
            onClick={cancel}
          >
            {discard.isPending ? "Discarding…" : "Discard"}
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-primary"
            disabled={busy}
            onClick={apply}
          >
            {commit.isPending ? "Applying…" : "Apply stock update"}
          </button>
        </div>
      </div>
      <p className="phs-prev__consequence">
        Applying updates {plural(added.length + changed.length, "item")}
        {goingOut.length ? ` and marks ${plural(goingOut.length, "item")} out of stock` : ""}.
        Dispensing and prescription screens use the new stock straight away.
      </p>
      {error ? (
        <p className="bill-dialog__error" role="alert">
          {error}
        </p>
      ) : null}
      <dl className="phs-prev__meta">
        <div>
          <dt>File</dt>
          <dd>{upload.fileName}</dd>
        </div>
        <div>
          <dt>Store</dt>
          <dd>{upload.storeName ?? "—"}</dd>
        </div>
        <div>
          <dt>Report generated</dt>
          <dd>
            {upload.reportGeneratedAt ? when(upload.reportGeneratedAt) : "Not stated in the file"}
            {upload.generatedBy ? ` · ${upload.generatedBy}` : ""}
          </dd>
        </div>
        <div>
          <dt>Items · Units</dt>
          <dd>
            {qty(upload.itemCount)} · {qty(upload.totalUnits)}
          </dd>
        </div>
        <div>
          <dt>Sale value</dt>
          <dd>{rupees(upload.saleTotal)}</dd>
        </div>
        <div>
          <dt>Purchase value</dt>
          <dd>{rupees(upload.purchaseTotal)}</dd>
        </div>
      </dl>

      <ul className="phs-prev__counts" aria-label="What this upload changes">
        <li>
          <strong>{added.length}</strong> new
        </li>
        <li>
          <strong>{changed.length}</strong> quantity changed
        </li>
        <li className={goingOut.length ? "phs-prev__warn" : ""}>
          <strong>{goingOut.length}</strong> will be marked out of stock
        </li>
        <li>
          <strong>{unchangedCount}</strong> unchanged
        </li>
        {upload.warnings.length ? (
          <li className="phs-prev__warn">
            <strong>{upload.warnings.length}</strong> warnings
          </li>
        ) : null}
      </ul>

      <Section title="Will be marked out of stock" count={goingOut.length} open>
        <p className="flow-muted">
          These items had stock but are not in this report, so they will show as out of stock.
        </p>
        <ItemTable rows={goingOut} label="Going out of stock" showNew={false} />
      </Section>
      <Section title="Quantity changed" count={changed.length}>
        <ItemTable rows={changed} label="Quantity changed" />
      </Section>
      <Section title="New items" count={added.length}>
        {needLinking ? (
          <p className="flow-muted">
            {plural(needLinking, "new item")} could not be matched to a prescription name
            automatically — link them from the stock list after applying.
          </p>
        ) : null}
        <ItemTable
          rows={added}
          label="New items"
          showOld={false}
          extra={{
            title: "Prescription link",
            render: (r) => (r.autoLinked ? "Matched" : "Needs linking"),
          }}
        />
      </Section>
      <Section title="Warnings" count={upload.warnings.length}>
        <ul className="phs-prev__warnlist">
          {upload.warnings.map((w, i) => (
            <li key={`${w.row}-${i}`}>
              Row {w.row} · <strong>{w.itemName}</strong> — {w.message}
            </li>
          ))}
        </ul>
      </Section>
    </section>
  );
}
