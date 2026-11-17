import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { inr, showDate } from "../../components/pharmacy/format";
import Pagination from "../../components/ui/Pagination";
import NewBillDialog from "../../components/pharmacy/NewBillDialog";
import { BillStatus } from "./PharmacyBillEditorPage";
import { useBillList } from "../../queries/hooks/usePharmacyBills";
import { SALE_TYPE_LABEL } from "../../../shared/pharmacyVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const STATUSES = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "final", label: "Paid" },
];

export default function PharmacyBillsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim().length >= 2 ? search.trim() : "");
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const list = useBillList({
    ...(q ? { q } : {}),
    status,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;

  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Pharmacy bills</h1>
          <p className="phs-sub">
            Bill OPD, IPD and walk-in customers from the main pharmacy stock. Stock is taken when a
            bill is finalised.
          </p>
        </div>
        <div className="phs-head__acts">
          <button
            type="button"
            className="flow-btn flow-btn-primary phs-upload"
            onClick={() => setCreating(true)}
          >
            <Plus size={15} aria-hidden="true" />
            New bill
          </button>
        </div>
      </header>

      <section className="flow-card" aria-labelledby="phb-list-title">
        <div className="fset__cardhead">
          <h2 id="phb-list-title" className="flow-sec-title">
            Bills
          </h2>
          <span className="fset__count">{total}</span>
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="phb-search">
            Search pharmacy bills
          </label>
          <input
            id="phb-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by bill number, patient, file number or IPD number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="phs-chips" role="group" aria-label="Filter bills by status">
            {STATUSES.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`phs-chip${status === s.key ? " on" : ""}`}
                aria-pressed={status === s.key}
                onClick={() => {
                  setStatus(s.key);
                  setPage(1);
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {list.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load pharmacy bills. Please try again.</p>
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
            Loading pharmacy bills…
          </p>
        ) : !rows.length ? (
          <div className="phs-empty">
            {q || status !== "all" ? (
              <>
                <p>No bills match the current filters.</p>
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
              <p>No pharmacy bills yet. Start one with New bill.</p>
            )}
          </div>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table" aria-label="Pharmacy bills">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Patient</th>
                    <th>Sale type</th>
                    <th className="phs-num">Medicines</th>
                    <th className="phs-num">Total</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td data-label="Bill">
                        <Link className="phs-item" to={`/pharmacy/billing/${r.id}`}>
                          {r.bill_no ?? "Draft"}
                        </Link>
                        <span className="phs-meta">
                          {r.status === "final"
                            ? showDate(r.bill_date)
                            : `started ${showDate(String(r.created_at).slice(0, 10))}`}
                          {r.created_by_name ? ` by ${r.created_by_name}` : ""}
                        </span>
                      </td>
                      <td data-label="Patient">
                        {r.patient_name}
                        <span className="phs-meta">{r.patient_file_no}</span>
                      </td>
                      <td data-label="Sale type">
                        {SALE_TYPE_LABEL[r.sale_type]}
                        {r.ipd_number ? <span className="phs-meta">{r.ipd_number}</span> : null}
                      </td>
                      <td data-label="Medicines" className="phs-num">
                        {r.line_count}
                      </td>
                      <td data-label="Total" className="phs-num">
                        {inr(r.net_amount)}
                      </td>
                      <td data-label="Status">
                        <BillStatus status={r.status} due={r.due_amount} />
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
              unit="bills"
            />
          </>
        )}
      </section>

      {creating ? (
        <NewBillDialog
          onClose={() => setCreating(false)}
          onCreated={(bill) => navigate(`/pharmacy/billing/${bill.id}`)}
        />
      ) : null}
    </div>
  );
}
