import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PackagePlus, Plus } from "lucide-react";
import { requestErrorOf } from "../../components/billing/format";
import { inr, showDate } from "../../components/pharmacy/format";
import Pagination from "../../components/ui/Pagination";
import { PURCHASE_STATUS_LABEL } from "../../../shared/pharmacyVocab";
import { useCreatePurchase, usePurchaseList } from "../../queries/hooks/usePharmacyPurchases";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import PillGroup from "../../components/pharmacy/Pills";

const STATUSES = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "posted", label: "Posted" },
  { key: "cancelled", label: "Cancelled" },
];

const BADGE = { draft: "review", posted: "ok", cancelled: "out" };

export function PurchaseStatus({ status }) {
  return (
    <span className={`bill-status phs-badge phs-badge--${BADGE[status]}`}>
      {PURCHASE_STATUS_LABEL[status]}
    </span>
  );
}

export default function PharmacyPurchasesPage() {
  const navigate = useNavigate();
  const create = useCreatePurchase();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [error, setError] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = usePurchaseList({
    ...(q ? { q } : {}),
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  const start = async (kind) => {
    setError("");
    try {
      const receipt = await create.mutateAsync({ kind });
      navigate(`/pharmacy/purchases/${receipt.id}`);
    } catch (err) {
      setError(requestErrorOf(err, "Could not start a goods receipt"));
    }
  };

  return (
    <div className="flow-root fset bill-ui phs">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Goods receipts</h1>
          <p className="phs-sub">
            Record stock received from vendors, with batch, expiry and rack. Posting a receipt adds
            it to the main pharmacy stock.
          </p>
        </div>
        <div className="phs-head__acts">
          <button
            type="button"
            className="flow-btn flow-btn-ghost phs-upload"
            disabled={create.isPending}
            onClick={() => start("opening")}
          >
            <PackagePlus size={15} aria-hidden="true" />
            Opening stock
          </button>
          <button
            type="button"
            className="flow-btn flow-btn-primary phs-upload"
            disabled={create.isPending}
            onClick={() => start("purchase")}
          >
            <Plus size={15} aria-hidden="true" />
            New purchase
          </button>
        </div>
      </header>

      {error ? (
        <p className="bill-dialog__error phs-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="flow-card" aria-labelledby="pur-list-title">
        <div className="fset__cardhead">
          <h2 id="pur-list-title" className="flow-sec-title">
            Receipts
          </h2>
          <span className="fset__count">{total}</span>
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="pur-search">
            Search goods receipts
          </label>
          <input
            id="pur-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by receipt number, invoice number or vendor"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <PillGroup
            label="Filter receipts by status"
            value={status}
            options={STATUSES}
            onChange={(key) => {
              setStatus(key);
              setPage(1);
            }}
          />
        </div>

        {list.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load goods receipts. Please try again.</p>
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
            Loading goods receipts…
          </p>
        ) : !rows.length ? (
          <div className="phs-empty">
            {q || status !== "all" ? (
              <>
                <p>No goods receipts match the current filters.</p>
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost"
                  onClick={() => {
                    setSearch("");
                    setStatus("all");
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              <p>No goods receipts yet. Start with opening stock or a new purchase.</p>
            )}
          </div>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table" aria-label="Goods receipts">
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Vendor / invoice</th>
                    <th className="phs-num">Medicines</th>
                    <th className="phs-num">Net amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={r.status === "cancelled" ? "phs-row--out" : ""}>
                      <td data-label="Receipt">
                        <Link className="phs-item" to={`/pharmacy/purchases/${r.id}`}>
                          {r.receipt_no}
                        </Link>
                        <span className="phs-meta">
                          {r.kind === "opening" ? "Opening stock" : "Purchase"} · started{" "}
                          {showDate(String(r.created_at).slice(0, 10))}
                          {r.created_by_name ? ` by ${r.created_by_name}` : ""}
                        </span>
                      </td>
                      <td data-label="Vendor / invoice">
                        {r.kind === "opening" ? (
                          <span className="phs-meta">Not needed</span>
                        ) : (
                          <>
                            {r.vendor_name ?? <span className="phs-meta">Vendor not chosen</span>}
                            <span className="phs-meta">
                              {r.invoice_no ? `Invoice ${r.invoice_no}` : "No invoice number"}
                              {r.invoice_date ? ` · ${showDate(r.invoice_date)}` : ""}
                            </span>
                          </>
                        )}
                      </td>
                      <td data-label="Medicines" className="phs-num">
                        {r.line_count}
                      </td>
                      <td data-label="Net amount" className="phs-num">
                        {inr(r.net_amount)}
                      </td>
                      <td data-label="Status">
                        <PurchaseStatus status={r.status} />
                      </td>
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
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              disabled={list.isFetching}
              unit="receipts"
            />
          </>
        )}
      </section>
    </div>
  );
}
