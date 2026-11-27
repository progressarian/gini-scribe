import { useState } from "react";
import { Check, X } from "lucide-react";
import {
  useApproveReleaseRequest,
  useRejectReleaseRequest,
  useReleaseRequests,
  useWithdrawReleaseRequest,
} from "../../queries/hooks/useReportReleases";
import useDeskRequestsLive from "../../queries/hooks/useDeskRequestsLive";
import useDebounced from "../../hooks/useDebounced";
import useAuthStore from "../../stores/authStore";
import { toast } from "../../stores/uiStore";
import Pagination from "../../components/ui/Pagination";
import RequestFilters, {
  STATUS_ALL,
  useRequestFilters,
} from "../../components/billing/RequestFilters";
import DayGroups, { OlderWaiting } from "../../components/billing/DayGroups";
import { fromPaise, requestErrorOf } from "../../components/billing/format";
import ReleaseNoteDialog from "../../components/giniflow/ReleaseNoteDialog";
import { RELEASE_STATUS_LABEL } from "../../../shared/reportRelease.js";
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
const PAGE_SIZE = 20;
const ANSWER_CLASS = { approved: "dreq__answer--yes", rejected: "dreq__answer--no" };

const when = (value) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "";

function Status({ row }) {
  return (
    <>
      <span className={`bill-status ${ANSWER_CLASS[row.status] ?? "dreq__tag"}`}>
        {RELEASE_STATUS_LABEL[row.status] ?? row.status}
      </span>
      {row.decided_at ? (
        <div className="dreq__muted">
          {row.decided_by?.name ?? "—"} · {when(row.decided_at)}
        </div>
      ) : null}
      {row.decision_note ? <div className="dreq__muted">{row.decision_note}</div> : null}
    </>
  );
}

function Payment({ row }) {
  if (!row.payment_pending) return <span className="bill-status dreq__answer--yes">Paid</span>;
  return (
    <>
      <span className="bill-status dreq__tag">Payment pending</span>
      <div className="dreq__muted">
        {row.due > 0
          ? `${fromPaise(row.due)} due${row.bills.length ? ` · ${row.bills.join(", ")}` : ""}`
          : "Bill not finalised yet"}
      </div>
    </>
  );
}

function Decide({ acting, onClose }) {
  const approve = useApproveReleaseRequest();
  const reject = useRejectReleaseRequest();
  const rejecting = acting.mode === "reject";
  const { row } = acting;
  return (
    <ReleaseNoteDialog
      title={rejecting ? "Reject report release" : "Release report before payment?"}
      intro={
        rejecting
          ? "The lab sees this note. The report stays held until the bill is paid."
          : "Approving lets the lab upload every report for this visit while the bill is still on credit. Reception still collects the payment."
      }
      patient={{ ...row.patient, visit_date: row.visit_date }}
      due={row.due}
      quote={row.reason}
      label={rejecting ? "Why it is rejected" : "Note for the lab"}
      required={rejecting}
      submitLabel={rejecting ? "Reject release" : "Approve release"}
      pendingLabel={rejecting ? "Rejecting…" : "Approving…"}
      danger={rejecting}
      failText={rejecting ? "Could not reject the request" : "Could not approve the request"}
      onSubmit={async (note) => {
        await (rejecting ? reject : approve).mutateAsync({ id: row.id, note });
        onClose(
          rejecting
            ? `Release rejected for ${row.patient.name}`
            : `Report release approved for ${row.patient.name}`,
          true,
        );
      }}
      onClose={() => onClose()}
    />
  );
}

export default function ReportReleasesPage({ live = true, filters: shared, canDecide = false }) {
  useDeskRequestsLive(live);
  const own = useRequestFilters();
  const filters = shared ?? own;
  const me = useAuthStore((s) => s.currentDoctor?.id ?? null);
  const [page, setPage] = useState(1);
  const [acting, setActing] = useState(null);
  const withdraw = useWithdrawReleaseRequest();
  const search = useDebounced(filters.value.q, 300);
  const status = STATUS_OPTIONS.some(([key]) => key === filters.value.status)
    ? filters.value.status
    : STATUS_ALL;
  const list = useReleaseRequests({
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
  const pullBack = (row) =>
    withdraw.mutate(
      { id: row.id },
      {
        onSuccess: () => toast(`Release request withdrawn for ${row.patient.name}`, "success"),
        onError: (e) => toast(requestErrorOf(e, "Could not withdraw the request"), "error"),
      },
    );

  return (
    <div className="flow-root fset bill-ui dreq-page cxl-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Home-collection reports to release before payment</h2>
          <span className={`fset__count bill-count--${list.data?.waiting ? "todo" : "done"}`}>
            {list.data?.waiting ?? 0} waiting
          </span>
        </div>

        <RequestFilters
          filters={filters}
          statuses={STATUS_OPTIONS}
          searchPlaceholder="Search by patient name or UHID"
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
            Loading release requests…
          </div>
        ) : list.isError ? (
          <div className="cxl-empty" role="alert">
            <strong>Unable to load release requests.</strong>
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
              <table className="flow-table cxl-table" aria-label="Report release requests">
                <thead>
                  <tr>
                    <th>Asked</th>
                    <th>Patient</th>
                    <th>Payment</th>
                    <th>Reason</th>
                    <th>Status</th>
                    <th className="bill-items__actions-head">Action</th>
                  </tr>
                </thead>
                <tbody>
                  <DayGroups
                    rows={rows}
                    days={list.data.days}
                    columns={6}
                    renderRow={(row) => (
                      <tr>
                        <td data-label="Asked">
                          <strong>{row.requested_by?.name ?? "—"}</strong>
                          <div className="dreq__muted">{when(row.requested_at)}</div>
                        </td>
                        <td data-label="Patient">
                          <strong>{row.patient.name}</strong>
                          <div className="dreq__muted">
                            {[
                              row.patient.file_no,
                              row.patient.age ? `${row.patient.age}y` : null,
                              row.patient.sex ? String(row.patient.sex)[0] : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                          <div className="dreq__muted">Visit {row.visit_date}</div>
                        </td>
                        <td data-label="Payment">
                          <Payment row={row} />
                        </td>
                        <td data-label="Reason" className="dreq__reason">
                          {row.reason}
                        </td>
                        <td data-label="Status">
                          <Status row={row} />
                        </td>
                        <td data-label="" className="bill-items__actions">
                          {row.status === "pending" && canDecide ? (
                            <>
                              <button
                                type="button"
                                className="flow-btn flow-btn-primary flow-btn-mini"
                                aria-label={`Approve report release for ${row.patient.name}`}
                                onClick={() => setActing({ row, mode: "approve" })}
                              >
                                <Check size={14} aria-hidden="true" />
                                Approve
                              </button>
                              <button
                                type="button"
                                className="flow-btn flow-btn-ghost flow-btn-mini dreq__reject"
                                aria-label={`Reject report release for ${row.patient.name}`}
                                onClick={() => setActing({ row, mode: "reject" })}
                              >
                                <X size={14} aria-hidden="true" />
                                Reject
                              </button>
                            </>
                          ) : row.status === "pending" && row.requested_by?.id === me ? (
                            <button
                              type="button"
                              className="flow-btn flow-btn-ghost flow-btn-mini"
                              aria-label={`Withdraw report release request for ${row.patient.name}`}
                              disabled={withdraw.isPending}
                              onClick={() => pullBack(row)}
                            >
                              Withdraw
                            </button>
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
                  ? "No release requests waiting today."
                  : "No release requests today."}
            </strong>
            {!filters.isDefault ? (
              <button type="button" className="flow-btn flow-btn-ghost" onClick={clear}>
                Clear filters
              </button>
            ) : (
              <span>
                {status === "pending"
                  ? "Approved and rejected requests are under Status → All."
                  : "When the lab asks to release a home-collection report before payment, it appears here."}
              </span>
            )}
          </div>
        )}
      </div>
      {acting ? <Decide acting={acting} onClose={close} /> : null}
    </div>
  );
}
