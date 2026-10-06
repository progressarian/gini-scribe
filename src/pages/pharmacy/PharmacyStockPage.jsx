import { useEffect, useId, useRef, useState } from "react";
import { Upload } from "lucide-react";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import { rupees, requestErrorOf } from "../../components/billing/format";
import { when } from "../../components/billing/importText";
import StockUploadPreview from "../../components/pharmacy/StockUploadPreview";
import StockLinkDialog from "../../components/pharmacy/StockLinkDialog";
import NeededStock from "../../components/pharmacy/NeededStock";
import Pagination from "../../components/ui/Pagination";
import {
  useCreateStockUpload,
  useStockList,
  useStockSummary,
  useStockUploads,
} from "../../queries/hooks/usePharmacyStock";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";

const XLSX_ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const FILTERS = [
  { key: "all", label: "All" },
  { key: "in_stock", label: "In stock" },
  { key: "out_of_stock", label: "Out of stock" },
  { key: "not_linked", label: "Not linked" },
];

const realLinks = (links) => links.filter((l) => l.status !== "identity");

const qty = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString("en-IN"));

function Summary({ summary, withRates }) {
  if (!summary) return null;
  const tiles = [
    { label: "Items in stock", value: qty(summary.inStock) },
    { label: "Out of stock", value: qty(summary.outOfStock) },
    { label: "Total units", value: qty(summary.totalUnits) },
    { label: "Sale value", value: rupees(summary.saleValue) },
    ...(withRates
      ? [
          { label: "Purchase value", value: rupees(summary.purchaseValue) },
          { label: "Not linked to prescriptions", value: qty(summary.notLinked) },
        ]
      : []),
  ];
  return (
    <dl className="phs-tiles">
      {tiles.map((t) => (
        <div className="phs-tile" key={t.label}>
          <dt>{t.label}</dt>
          <dd>{t.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function History({ data, isLoading, isError, onReview }) {
  const uploads = data?.uploads ?? [];
  return (
    <section className="flow-card" aria-labelledby="phs-history-title">
      <div className="fset__cardhead">
        <h2 id="phs-history-title" className="flow-sec-title">
          Upload history
        </h2>
        {data ? <span className="fset__count">{data.total}</span> : null}
      </div>
      {isError ? (
        <p className="fset__cardsub">Could not load the upload history.</p>
      ) : isLoading ? (
        <p className="fset__cardsub">Loading…</p>
      ) : !uploads.length ? (
        <p className="fset__cardsub">No stock report has been uploaded yet.</p>
      ) : (
        <div className="fset__scroll">
          <table className="flow-table" aria-label="Past stock uploads">
            <thead>
              <tr>
                <th>File</th>
                <th>Report generated</th>
                <th>Uploaded by</th>
                <th>Status</th>
                <th className="phs-num">Items</th>
                <th className="phs-num">Units</th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u) => (
                <tr key={u.id}>
                  <td data-label="File">{u.fileName}</td>
                  <td data-label="Report generated">
                    {u.reportGeneratedAt ? when(u.reportGeneratedAt) : "—"}
                  </td>
                  <td data-label="Uploaded by">
                    {u.uploadedBy ?? "—"} · {when(u.uploadedAt)}
                  </td>
                  <td data-label="Status">
                    <span
                      className={`bill-status phs-badge phs-badge--${u.status === "committed" ? "ok" : "review"}`}
                    >
                      {u.status === "committed" ? "Applied" : "Waiting to apply"}
                    </span>
                    {u.status === "preview" ? (
                      <button
                        type="button"
                        className="flow-btn flow-btn-ghost flow-btn-mini phs-review"
                        onClick={() => onReview(u.id)}
                      >
                        Review
                      </button>
                    ) : null}
                  </td>
                  <td data-label="Items" className="phs-num">
                    {qty(u.itemCount)}
                  </td>
                  <td data-label="Units" className="phs-num">
                    {qty(u.totalUnits)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function PharmacyStockPage() {
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canUpload = hasCapability(role, CAPABILITIES.PHARMACY_STOCK_UPLOAD);
  const pickerId = useId();
  const picker = useRef(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [uploadId, setUploadId] = useState(null);
  const [linking, setLinking] = useState(null);
  const [uploadError, setUploadError] = useState("");
  const [dismissedId, setDismissedId] = useState(null);
  const uploads = useStockUploads(canUpload);
  const pendingId = uploads.data?.uploads.find((u) => u.status === "preview")?.id ?? null;

  useEffect(() => {
    if (!uploadId && pendingId && pendingId !== dismissedId) setUploadId(pendingId);
  }, [uploadId, pendingId, dismissedId]);

  const review = (id) => {
    setDismissedId(null);
    setUploadId(id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const { data: summary } = useStockSummary();
  const list = useStockList({
    ...(q ? { q } : {}),
    filter,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const create = useCreateStockUpload();
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const last = summary?.lastUpload;

  const choose = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadError("");
    try {
      const upload = await create.mutateAsync(file);
      setUploadId(upload.id);
    } catch (err) {
      setUploadError(requestErrorOf(err, "Could not read the stock report"));
    }
  };

  const clearFilters = () => {
    setSearch("");
    setQ("");
    setFilter("all");
    setPage(1);
  };

  return (
    <div className="flow-root fset bill-ui phs">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Pharmacy stock</h1>
          <p className="phs-sub">
            {last
              ? `Updated ${when(last.committedAt)} from ${last.fileName}${last.committedBy ? ` by ${last.committedBy}` : ""}${last.reportGeneratedAt ? ` · report generated ${when(last.reportGeneratedAt)}` : ""}`
              : "No stock report uploaded yet"}
          </p>
        </div>
        {canUpload ? (
          <div className="phs-head__acts">
            <button
              type="button"
              className="flow-btn flow-btn-primary phs-upload"
              disabled={create.isPending}
              onClick={() => picker.current?.click()}
            >
              <Upload size={15} aria-hidden="true" />
              {create.isPending ? "Reading file…" : "Upload stock sheet"}
            </button>
            <input
              id={pickerId}
              ref={picker}
              type="file"
              accept={XLSX_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-label="Stock report file"
              disabled={create.isPending}
              onChange={choose}
            />
          </div>
        ) : null}
      </header>

      {canUpload ? (
        <p className="phs-hint">
          Export <strong>Item Wise Stock Report</strong> from DARPAN as .xlsx and upload it here.
          You will see what changes before anything is applied.
        </p>
      ) : null}

      {uploadError ? (
        <p className="bill-dialog__error phs-error" role="alert">
          {uploadError}
        </p>
      ) : null}

      {uploadId ? (
        <StockUploadPreview
          key={uploadId}
          id={uploadId}
          onDone={() => {
            setDismissedId(uploadId);
            setUploadId(null);
          }}
        />
      ) : null}

      <Summary summary={summary} withRates={canUpload} />

      <NeededStock canOrder={canUpload} />

      <section className="flow-card" aria-labelledby="phs-list-title">
        <div className="fset__cardhead">
          <h2 id="phs-list-title" className="flow-sec-title">
            Stock items
          </h2>
          <span className="fset__count">{total}</span>
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="phs-search">
            Search stock
          </label>
          <input
            id="phs-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by item, company or generic name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="phs-chips" role="group" aria-label="Filter stock">
            {FILTERS.filter((f) => canUpload || f.key !== "not_linked").map((f) => (
              <button
                key={f.key}
                type="button"
                className={`phs-chip${filter === f.key ? " on" : ""}`}
                aria-pressed={filter === f.key}
                onClick={() => {
                  setFilter(f.key);
                  setPage(1);
                }}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {list.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load stock.</p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => list.refetch()}
            >
              Try again
            </button>
          </div>
        ) : list.isLoading ? (
          <p className="phs-empty" role="status">
            Loading stock…
          </p>
        ) : !items.length ? (
          <div className="phs-empty">
            {q || filter !== "all" ? (
              <>
                <p>No stock items match the current filters.</p>
                <button type="button" className="flow-btn flow-btn-ghost" onClick={clearFilters}>
                  Clear filters
                </button>
              </>
            ) : (
              <p>
                No stock uploaded yet.
                {canUpload
                  ? " Upload the DARPAN Item Wise Stock Report to start."
                  : " Ask the pharmacy admin to upload the stock report."}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table" aria-label="Stock items">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="phs-num">Qty</th>
                    <th className="phs-num">Sale price / unit</th>
                    <th>Category</th>
                    {canUpload ? (
                      <>
                        <th className="phs-num">Purchase total</th>
                        <th className="phs-num">Margin</th>
                        <th>Prescription names</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.itemKey} className={i.qty <= 0 ? "phs-row--out" : ""}>
                      <td data-label="Item">
                        <span className="phs-item">{i.itemName}</span>
                        {i.company ? <span className="phs-meta">{i.company}</span> : null}
                      </td>
                      <td data-label="Qty" className="phs-num">
                        {i.qty <= 0 ? (
                          <span className="bill-status phs-badge phs-badge--out">Out of stock</span>
                        ) : (
                          qty(i.qty)
                        )}
                      </td>
                      <td data-label="Sale price / unit" className="phs-num">
                        {i.unitSalePrice === null ? "—" : rupees(i.unitSalePrice)}
                      </td>
                      <td data-label="Category">{i.category ?? "—"}</td>
                      {canUpload ? (
                        <>
                          <td data-label="Purchase total" className="phs-num">
                            {i.purchaseTotal === null ? "—" : rupees(i.purchaseTotal)}
                          </td>
                          <td data-label="Margin" className="phs-num">
                            {i.margin === null ? "—" : rupees(i.margin)}
                          </td>
                          <td data-label="Prescription names">
                            <button
                              type="button"
                              className={`phs-links${realLinks(i.links).length ? "" : " phs-links--none"}`}
                              onClick={() => setLinking(i.itemKey)}
                              aria-label={`Edit prescription names for ${i.itemName}`}
                            >
                              {realLinks(i.links).length
                                ? `${realLinks(i.links).length} linked`
                                : "Not linked — link now"}
                            </button>
                          </td>
                        </>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onChange={setPage}
              onPageSizeChange={setPageSize}
              disabled={list.isFetching}
              unit="items"
            />
          </>
        )}
      </section>

      {canUpload ? (
        <History
          data={uploads.data}
          isLoading={uploads.isLoading}
          isError={uploads.isError}
          onReview={review}
        />
      ) : null}

      <StockLinkDialog itemKey={linking} onClose={() => setLinking(null)} />
    </div>
  );
}
