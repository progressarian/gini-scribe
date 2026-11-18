import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Pagination from "../../components/ui/Pagination";
import { inr } from "../../components/pharmacy/format";
import { usePatientLedger } from "../../queries/hooks/usePharmacyAccounts";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";
import PillGroup from "../../components/pharmacy/Pills";
import useUrlState, { useUrlSearch, asNumber } from "../../hooks/useUrlState";

const COLUMNS = [
  { key: "name", label: "Patient name" },
  { key: "file_no", label: "Patient ID" },
  { key: "payer", label: "Payer" },
  { key: "total_amount", label: "Total amount", money: true },
  { key: "paid", label: "Paid", money: true },
  { key: "write_off", label: "Write off", money: true },
  { key: "deposit", label: "Deposit", money: true },
  { key: "deposit_refund", label: "Deposit refund", money: true },
  { key: "discounts", label: "Discounts", money: true },
  { key: "sales_return", label: "Voucher (sales return)", money: true },
  { key: "due", label: "Due", money: true },
  { key: "balance", label: "Deposit balance", money: true },
];

const FILTERS = [
  { key: "all", label: "All" },
  { key: "due", label: "Money due" },
  { key: "balance", label: "Deposit left" },
];

export default function PharmacyLedgerPage() {
  const { search, setSearch, q } = useUrlSearch("q", () => setPage(1));
  const [only, setOnly] = useUrlState("only", "all");
  const [sortKey, setSortKey] = useUrlState("sort", "last_activity");
  const [sortDir, setSortDir] = useUrlState("dir", "desc");
  const sort = { key: sortKey, dir: sortDir };
  const [page, setPage] = useUrlState("page", 1, asNumber);
  const [pageSize, setPageSize] = useUrlState("size", 50, asNumber);

  const query = usePatientLedger({
    ...(q ? { q } : {}),
    only,
    sort: sort.key,
    dir: sort.dir,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
  const rows = query.data?.rows ?? [];
  const sortBy = (key) => {
    setSortDir(sort.key === key && sort.dir === "desc" ? "asc" : "desc");
    setSortKey(key);
    setPage(1);
  };

  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Patient ledger</h1>
          <p className="phs-sub">
            Every patient's pharmacy account: what was billed, paid, discounted, returned, written
            off, and held on deposit. Open a patient for the full statement.
          </p>
        </div>
      </header>

      <section className="flow-card" aria-labelledby="pld-title">
        <div className="fset__cardhead">
          <h2 id="pld-title" className="flow-sec-title">
            Patients
          </h2>
          <span className="fset__count">{query.data?.total ?? 0}</span>
          {query.data ? (
            <span className="phb-due-total phb-sum-total">
              Billed {inr(query.data.sums.total_amount)} · due {inr(query.data.sums.due)} · deposits{" "}
              {inr(query.data.sums.balance)}
            </span>
          ) : null}
        </div>
        <div className="phs-filters">
          <label className="sr-only" htmlFor="pld-search">
            Search patients
          </label>
          <input
            id="pld-search"
            type="search"
            className="jb-assign phs-search"
            placeholder="Search by patient name, patient ID or mobile number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <PillGroup
            label="Filter patients"
            value={only}
            options={FILTERS}
            onChange={(key) => {
              setOnly(key);
              setPage(1);
            }}
          />
        </div>

        {query.isError ? (
          <div className="phs-empty" role="alert">
            <p>Unable to load the ledger. Please try again.</p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => query.refetch()}
            >
              Try again
            </button>
          </div>
        ) : query.isLoading ? (
          <p className="phs-empty" role="status">
            Loading the ledger…
          </p>
        ) : !rows.length ? (
          <p className="phs-empty">
            {q || only !== "all" ? "No patients match." : "No pharmacy activity yet."}
          </p>
        ) : (
          <>
            <div className="fset__scroll">
              <table className="flow-table phs-table psl-table" aria-label="Patient ledger">
                <thead>
                  <tr>
                    <th>S.no</th>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        className={c.money ? "phs-num" : undefined}
                        aria-sort={
                          sort.key === c.key
                            ? sort.dir === "asc"
                              ? "ascending"
                              : "descending"
                            : undefined
                        }
                      >
                        <button type="button" className="psl-sort" onClick={() => sortBy(c.key)}>
                          {c.label}
                          {sort.key === c.key ? (
                            sort.dir === "asc" ? (
                              <ArrowUp size={12} className="psl-sort__icon" aria-hidden="true" />
                            ) : (
                              <ArrowDown size={12} className="psl-sort__icon" aria-hidden="true" />
                            )
                          ) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.patient_id}>
                      <td data-label="S.no">{(page - 1) * pageSize + i + 1}</td>
                      {COLUMNS.map((c) => (
                        <td
                          key={c.key}
                          data-label={c.label}
                          className={`${c.money ? "phs-num" : ""}${
                            c.key === "due" && Number(r.due) > 0 ? " phb-due" : ""
                          }`}
                        >
                          {c.key === "name" ? (
                            <Link className="phs-item" to={`/pharmacy/accounts/${r.patient_id}`}>
                              {r.name}
                            </Link>
                          ) : c.money ? (
                            inr(r[c.key])
                          ) : (
                            (r[c.key] ?? "—")
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={query.data?.total ?? 0}
              onChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              disabled={query.isFetching}
              unit="patients"
            />
          </>
        )}
      </section>
    </div>
  );
}
