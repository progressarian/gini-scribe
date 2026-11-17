import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions";
import Pagination from "../../components/ui/Pagination";
import { CollectDueDialog, DecideCreditDialog } from "../../components/pharmacy/CreditDialogs";
import { inr, showDate } from "../../components/pharmacy/format";
import { useCreditRequests, useDues } from "../../queries/hooks/usePharmacyCredit";
import { CREDIT_STATUS_LABEL, SALE_TYPE_LABEL } from "../../../shared/pharmacyVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";
import PillGroup from "../../components/pharmacy/Pills";
import useUrlState, { useUrlSearch, asNumber } from "../../hooks/useUrlState";

const TABS = [
  { key: "requests", label: "Credit requests" },
  { key: "dues", label: "Dues" },
];

const STATUS_FILTERS = [
  { key: "pending", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "used", label: "Used" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

const CREDIT_BADGE = {
  pending: "review",
  approved: "ok",
  used: "ok",
  rejected: "out",
  withdrawn: "out",
};

const moment = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

function TableState({ query, empty, children }) {
  if (query.isError) {
    return (
      <div className="phs-empty" role="alert">
        <p>Unable to load this list. Please try again.</p>
        <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  if (query.isLoading) {
    return (
      <p className="phs-empty" role="status">
        Loading…
      </p>
    );
  }
  if (!(query.data?.rows ?? []).length) return <p className="phs-empty">{empty}</p>;
  return children;
}

function RequestsPanel({ canApprove, myId }) {
  const [status, setStatus] = useUrlState("status", "pending");
  const [page, setPage] = useUrlState("page", 1, asNumber);
  const [pageSize, setPageSize] = useUrlState("size", 25, asNumber);
  const [deciding, setDeciding] = useState(null);
  const query = useCreditRequests({ status, limit: pageSize, offset: (page - 1) * pageSize });
  const rows = query.data?.rows ?? [];

  return (
    <section className="flow-card" aria-labelledby="pcr-title">
      <div className="fset__cardhead">
        <h2 id="pcr-title" className="flow-sec-title">
          Credit requests
        </h2>
        <span className="fset__count">{query.data?.total ?? 0}</span>
      </div>
      <div className="phs-filters">
        <PillGroup
          label="Filter credit requests by status"
          value={status}
          options={STATUS_FILTERS}
          onChange={(key) => {
            setStatus(key);
            setPage(1);
          }}
        />
      </div>
      <TableState
        query={query}
        empty={
          status === "pending" ? "No credit requests are waiting." : "No credit requests here."
        }
      >
        <div className="fset__scroll">
          <table className="flow-table phs-table" aria-label="Credit requests">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Bill</th>
                <th className="phs-num">Bill total</th>
                <th className="phs-num">Pay later</th>
                <th>Reason</th>
                <th>Status</th>
                {canApprove ? <th aria-label="Actions" /> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Patient">
                    {r.patient_name}
                    <span className="phs-meta">
                      {r.patient_file_no}
                      {Number(r.patient_due) > 0 ? (
                        <span className="phb-due"> · already due {inr(r.patient_due)}</span>
                      ) : null}
                    </span>
                  </td>
                  <td data-label="Bill">
                    <Link className="phs-item" to={`/pharmacy/billing/${r.bill_id}`}>
                      {r.bill_no ?? "Draft bill"}
                    </Link>
                    <span className="phs-meta">
                      {SALE_TYPE_LABEL[r.sale_type]}
                      {r.ipd_number ? ` · ${r.ipd_number}` : ""} · asked by{" "}
                      {r.requested_by_name ?? "—"} {moment(r.requested_at)}
                    </span>
                  </td>
                  <td data-label="Bill total" className="phs-num">
                    {inr(r.bill_amount)}
                  </td>
                  <td data-label="Pay later" className="phs-num">
                    {inr(r.amount)}
                    {r.approved_amount && r.approved_amount !== r.amount ? (
                      <span className="phs-meta">approved {inr(r.approved_amount)}</span>
                    ) : null}
                  </td>
                  <td data-label="Reason">
                    {r.reason}
                    {r.decision_note ? (
                      <span className="phs-meta">
                        {r.decided_by_name ?? "Admin"}: {r.decision_note}
                      </span>
                    ) : null}
                  </td>
                  <td data-label="Status">
                    <span className={`bill-status phs-badge phs-badge--${CREDIT_BADGE[r.status]}`}>
                      {CREDIT_STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  {canApprove ? (
                    <td className="phb-line-acts">
                      {r.status === "pending" && r.requested_by !== myId ? (
                        <>
                          <button
                            type="button"
                            className="flow-btn flow-btn-primary"
                            aria-label={`Approve credit for ${r.patient_name}`}
                            onClick={() => setDeciding({ request: r, decision: "approve" })}
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost"
                            aria-label={`Refuse credit for ${r.patient_name}`}
                            onClick={() => setDeciding({ request: r, decision: "reject" })}
                          >
                            Refuse
                          </button>
                        </>
                      ) : r.status === "pending" ? (
                        <span className="phs-meta">Another approver decides</span>
                      ) : null}
                    </td>
                  ) : null}
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
          unit="requests"
        />
      </TableState>
      {deciding ? (
        <DecideCreditDialog
          request={deciding.request}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
        />
      ) : null}
    </section>
  );
}

function DuesPanel() {
  const { search, setSearch, q } = useUrlSearch("d_q", () => setPage(1));
  const [page, setPage] = useUrlState("d_page", 1, asNumber);
  const [pageSize, setPageSize] = useUrlState("d_size", 25, asNumber);
  const [collecting, setCollecting] = useState(null);

  const query = useDues({ ...(q ? { q } : {}), limit: pageSize, offset: (page - 1) * pageSize });
  const rows = query.data?.rows ?? [];

  return (
    <section className="flow-card" aria-labelledby="pdu-title">
      <div className="fset__cardhead">
        <h2 id="pdu-title" className="flow-sec-title">
          Dues
        </h2>
        <span className="fset__count">{query.data?.total ?? 0}</span>
        <span className="phb-due-total">Outstanding {inr(query.data?.total_due ?? 0)}</span>
      </div>
      <div className="phs-filters">
        <label className="sr-only" htmlFor="pdu-search">
          Search dues
        </label>
        <input
          id="pdu-search"
          type="search"
          className="jb-assign phs-search"
          placeholder="Search by patient, file number, mobile or bill number"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <TableState
        query={query}
        empty={q ? "No dues match the search." : "No pharmacy bills have money due."}
      >
        <div className="fset__scroll">
          <table className="flow-table phs-table" aria-label="Pharmacy dues">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Patient</th>
                <th className="phs-num">Bill total</th>
                <th className="phs-num">Paid</th>
                <th className="phs-num">Due</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Bill">
                    <Link className="phs-item" to={`/pharmacy/billing/${r.id}`}>
                      {r.bill_no}
                    </Link>
                    <span className="phs-meta">
                      {showDate(r.bill_date)} · {r.age_days} day{r.age_days === 1 ? "" : "s"} ago
                    </span>
                  </td>
                  <td data-label="Patient">
                    {r.patient_name}
                    <span className="phs-meta">
                      {[r.patient_file_no, r.patient_phone].filter(Boolean).join(" · ")}
                    </span>
                  </td>
                  <td data-label="Bill total" className="phs-num">
                    {inr(r.net_amount)}
                  </td>
                  <td data-label="Paid" className="phs-num">
                    {inr(r.paid_amount)}
                  </td>
                  <td data-label="Due" className="phs-num phb-due">
                    {inr(r.due_amount)}
                  </td>
                  <td className="phb-line-acts">
                    <button
                      type="button"
                      className="flow-btn flow-btn-primary"
                      aria-label={`Collect due on bill ${r.bill_no}`}
                      onClick={() => setCollecting(r)}
                    >
                      Collect
                    </button>
                  </td>
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
          unit="bills"
        />
      </TableState>
      {collecting ? (
        <CollectDueDialog bill={collecting} onClose={() => setCollecting(null)} />
      ) : null}
    </section>
  );
}

export default function PharmacyCreditPage() {
  const me = useAuthStore((s) => s.currentDoctor);
  const canApprove = hasCapability(me?.role, CAPABILITIES.PHARMACY_CREDIT_APPROVE);
  const [tabParam, setTab] = useUrlState("tab", "requests");
  const tab = TABS.some((t) => t.key === tabParam) ? tabParam : "requests";
  const tabRefs = useRef({});

  const select = (key) => {
    setTab(key);
    tabRefs.current[key]?.focus();
  };

  const onKeyDown = (e) => {
    const i = TABS.findIndex((t) => t.key === tab);
    if (e.key === "ArrowRight") select(TABS[(i + 1) % TABS.length].key);
    if (e.key === "ArrowLeft") select(TABS[(i - 1 + TABS.length) % TABS.length].key);
  };

  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Pharmacy credit</h1>
          <p className="phs-sub">
            {canApprove
              ? "Approve or refuse credit asked for at the counter, and collect money still due on pharmacy bills."
              : "Track the credit you asked for, and collect money still due on pharmacy bills."}
          </p>
        </div>
      </header>

      <div className="bst-tabs" role="tablist" aria-label="Credit views" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              tabRefs.current[t.key] = el;
            }}
            type="button"
            role="tab"
            id={`pcr-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`pcr-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            className={`bst-tab${tab === t.key ? " on" : ""}`}
            onClick={() => select(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`pcr-panel-${tab}`} aria-labelledby={`pcr-tab-${tab}`}>
        {tab === "requests" ? (
          <RequestsPanel canApprove={canApprove} myId={me?.id} />
        ) : (
          <DuesPanel />
        )}
      </div>
    </div>
  );
}
