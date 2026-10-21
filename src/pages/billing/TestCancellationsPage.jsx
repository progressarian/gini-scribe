import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import {
  useCancelRequestDetail,
  useCancelRequests,
} from "../../queries/hooks/useTestCancelRequests";
import useDeskRequestsLive from "../../queries/hooks/useDeskRequestsLive";
import useDebounced from "../../hooks/useDebounced";
import { toast } from "../../stores/uiStore";
import Pagination from "../../components/ui/Pagination";
import RequestFilters, {
  STATUS_ALL,
  useRequestFilters,
} from "../../components/billing/RequestFilters";
import DayGroups, { OlderWaiting } from "../../components/billing/DayGroups";
import CancelDecisionDialog from "../../components/giniflow/CancelDecisionDialog";
import { fromPaise } from "../../components/billing/format";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";
import "./deskRequests.css";
import "../../components/giniflow/cancelRequests.css";
import "../../components/billing/deskRequestsInbox.css";

const STATUS_OPTIONS = [
  [STATUS_ALL, "All"],
  ["pending", "Waiting"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["withdrawn", "Withdrawn"],
];
const STATUS_TEXT = {
  pending: "Waiting for admin",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
const STAGE_TEXT = {
  sample_collected: "Sample collected",
  sample_sent: "Sample sent to lab",
  sent_outside: "Sent to outside lab",
  sample_received: "Received at lab",
  processing: "Processing",
  in_progress: "On the machine",
  done: "Machine test done",
};
const PAGE_SIZE = 20;

const when = (value) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "";

const stageOf = (target) =>
  target?.kind === "healthray_case"
    ? `HealthRay case ${target.case_no} — collected`
    : STAGE_TEXT[target?.sample_status] || target?.sample_status || "";

function Decision({ row }) {
  if (row.status === "pending") return <span className="bill-status dreq__tag">Waiting</span>;
  if (row.status === "approved") {
    return (
      <>
        <span className="bill-status dreq__answer--yes">Approved</span>
        <div className="dreq__muted">
          Kept {fromPaise(row.charge ?? 0)} ·{" "}
          {row.credit_note
            ? `refund ${fromPaise(row.credit_note.amount)} (${row.credit_note.bill_no})`
            : "no refund"}
        </div>
        <div className="dreq__muted">
          {row.decided_by?.name} · {when(row.decided_at)}
        </div>
        {row.decision_note ? <div className="dreq__muted">{row.decision_note}</div> : null}
      </>
    );
  }
  return (
    <>
      <span className="bill-status dreq__answer--no">{STATUS_TEXT[row.status]}</span>
      <div className="dreq__muted">
        {row.decided_by?.name} · {when(row.decided_at)}
      </div>
      {row.decision_note ? <div className="dreq__muted">{row.decision_note}</div> : null}
    </>
  );
}

function Answer({ acting, onClose }) {
  const detail = useCancelRequestDetail(acting.row.id);
  useEffect(() => {
    if (detail.isError) onClose("Could not load the request — try again");
  }, [detail.isError]);
  if (detail.isLoading || detail.isError) return null;
  const row = acting.row;
  return (
    <CancelDecisionDialog
      mode={acting.mode}
      request={row}
      paid={detail.data.paid}
      defaults={detail.data.defaults}
      patient={{ name: row.patient.name, fileNo: row.patient.file_no }}
      testName={row.target?.test_name ?? "test"}
      stageText={stageOf(row.target)}
      reasonText={row.reason}
      billText={detail.data.bills.filter((b) => b !== "draft").join(", ") || "Draft bill"}
      onClose={() => onClose()}
      onDone={(message) => onClose(message, true)}
    />
  );
}

export default function TestCancellationsPage({ live = true, filters: shared }) {
  useDeskRequestsLive(live);
  const own = useRequestFilters();
  const filters = shared ?? own;
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState(null);
  const search = useDebounced(filters.value.q, 300);
  const status = STATUS_OPTIONS.some(([key]) => key === filters.value.status)
    ? filters.value.status
    : STATUS_ALL;
  const list = useCancelRequests({
    status,
    q: search,
    from: filters.value.from,
    to: filters.value.to,
    page,
    limit: PAGE_SIZE,
  });
  const rows = list.data?.rows ?? [];

  const close = (message, ok) => {
    setActing(null);
    if (message) toast(message, ok ? "success" : "error");
  };
  const clear = () => {
    filters.reset();
    setPage(1);
  };

  return (
    <div className="flow-root fset bill-ui dreq-page cxl-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Test cancellations after collection</h2>
          <span className={`fset__count bill-count--${list.data?.waiting ? "todo" : "done"}`}>
            {list.data?.waiting ?? 0} waiting
          </span>
        </div>
        <div className="fset__cardsub">
          The lab, machine room and reception ask here when a test whose sample is already collected
          must be cancelled. While a request waits, that test is on hold. Approving cancels it,
          keeps a collection charge and sends the rest to the Refunds tab.
        </div>

        <RequestFilters
          filters={filters}
          statuses={STATUS_OPTIONS}
          searchPlaceholder="Search by patient name, UHID or test"
          onChange={() => setPage(1)}
        />
        <OlderWaiting
          count={list.data?.olderWaiting ?? 0}
          onShow={() => {
            filters.set({ status: "pending", from: "", to: "" });
            setPage(1);
          }}
        />

        {list.isLoading ? (
          <div className="fset__cardsub" role="status">
            Loading cancellation requests…
          </div>
        ) : list.isError ? (
          <div className="cxl-empty" role="alert">
            <strong>Unable to load cancellation requests.</strong>
            <span>Please try again. If the problem continues, contact an administrator.</span>
            <button
              type="button"
              className="flow-btn flow-btn-ghost"
              onClick={() => list.refetch()}
            >
              Try again
            </button>
          </div>
        ) : rows.length ? (
          <>
            <div className="fset__scroll fset__scroll--wide">
              <table className="flow-table cxl-table" aria-label="Test cancellation requests">
                <thead>
                  <tr>
                    <th>Asked</th>
                    <th>Patient</th>
                    <th>Test</th>
                    <th className="cxl-num">Paid</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th className="bill-items__actions-head">Action</th>
                  </tr>
                </thead>
                <tbody>
                  <DayGroups
                    rows={rows}
                    days={list.data.days}
                    columns={7}
                    renderRow={(row) => (
                      <tr>
                        <td data-label="Asked">
                          <strong>{row.requested_by?.name ?? "—"}</strong>
                          <div className="dreq__muted">{when(row.requested_at)}</div>
                        </td>
                        <td data-label="Patient">
                          <strong>{row.patient.name}</strong>
                          <div className="dreq__muted">
                            {row.patient.file_no}
                            {row.patient.age ? ` · ${row.patient.age}` : ""}
                            {row.patient.sex ? `${String(row.patient.sex)[0]}` : ""}
                          </div>
                        </td>
                        <td data-label="Test">
                          <strong>{row.target?.test_name}</strong>
                          <div className="dreq__muted">{stageOf(row.target)}</div>
                        </td>
                        <td data-label="Paid" className="cxl-num">
                          {row.paid === null ? "—" : fromPaise(row.paid)}
                        </td>
                        <td data-label="Reason" className="dreq__reason">
                          {row.reason}
                        </td>
                        <td data-label="Status">
                          <Decision row={row} />
                        </td>
                        <td data-label="" className="bill-items__actions">
                          {row.status === "pending" ? (
                            <>
                              <button
                                type="button"
                                className="flow-btn flow-btn-primary flow-btn-mini"
                                aria-label={`Answer cancellation of ${row.target?.test_name} for ${row.patient.name}`}
                                onClick={() => setActing({ row, mode: "approve" })}
                              >
                                <Check size={14} aria-hidden="true" />
                                Answer
                              </button>
                              <button
                                type="button"
                                className="flow-btn flow-btn-ghost flow-btn-mini dreq__reject"
                                aria-label={`Reject cancellation of ${row.target?.test_name} for ${row.patient.name}`}
                                onClick={() => setActing({ row, mode: "reject" })}
                              >
                                <X size={14} aria-hidden="true" />
                                Reject
                              </button>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    )}
                  />
                </tbody>
              </table>
            </div>
            <Pagination
              page={list.data.page}
              pageSize={PAGE_SIZE}
              total={list.data.total}
              onChange={setPage}
              disabled={list.isFetching}
              unit="requests"
            />
          </>
        ) : (
          <div className="cxl-empty">
            <strong>
              {!filters.isDefault
                ? "No requests match these filters."
                : status === "pending"
                  ? "No cancellation requests waiting today."
                  : "No cancellation requests today."}
            </strong>
            {!filters.isDefault ? (
              <button type="button" className="flow-btn flow-btn-ghost" onClick={clear}>
                Clear filters
              </button>
            ) : (
              <span>
                {status === "pending"
                  ? "Approved and rejected requests are under Status → All."
                  : "Requests from the lab, machine room and reception appear here."}
              </span>
            )}
          </div>
        )}
      </div>
      {acting ? <Answer acting={acting} onClose={close} /> : null}
    </div>
  );
}
