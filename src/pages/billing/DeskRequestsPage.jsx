import { useState } from "react";
import {
  INBOX_POLL_MS,
  useDeskRequests,
  usePendingDeskRequests,
} from "../../queries/hooks/useBillingRequests";
import useDeskRequestsLive from "../../queries/hooks/useDeskRequestsLive";
import { toast } from "../../stores/uiStore";
import DeskRequestDecisionDialog from "../../components/billing/DeskRequestDecisionDialog";
import DeskRequestItemDialog from "../../components/billing/DeskRequestItemDialog";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./deskRequests.css";

const when = (value) =>
  value ? new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "";

export const subjectOf = (request) =>
  request.kind === "new_item"
    ? (request.proposed_name ?? "a new item")
    : (request.item?.name ?? "that item");

const billLabel = (billNo) => (billNo ? `bill ${billNo}` : "this visit's draft bill");

function Patient({ request }) {
  if (!request.patient) return <span className="dreq__muted">No patient — a new item only</span>;
  return (
    <>
      <strong>{request.patient.name}</strong>
      <div className="dreq__muted">
        {[request.patient.file_no, request.patient.age ? `${request.patient.age}y` : null]
          .filter(Boolean)
          .join(" · ")}
      </div>
      {request.visit_date ? <div className="dreq__muted">Visit {request.visit_date}</div> : null}
    </>
  );
}

function Wanted({ request }) {
  const newItem = request.kind === "new_item";
  return (
    <>
      <strong>{subjectOf(request)}</strong>
      <div className="dreq__tag">{newItem ? "New item" : "Bill again"}</div>
      {newItem ? (
        request.proposed_group ? (
          <div className="dreq__muted">Group: {request.proposed_group}</div>
        ) : null
      ) : (
        <div className="dreq__muted">
          {request.item?.code ? `${request.item.code} · ` : ""}already on{" "}
          {billLabel(request.bill_no)}
        </div>
      )}
    </>
  );
}

function Answer({ request }) {
  if (request.status === "rejected") {
    return (
      <>
        <strong>Rejected</strong>
        <div className="dreq__muted">{request.decision_note}</div>
      </>
    );
  }
  if (request.kind === "new_item") {
    return (
      <>
        <strong>Item created</strong>
        <div className="dreq__muted">
          {[request.created_item?.code, request.created_item?.name].filter(Boolean).join(" — ")}
        </div>
        {request.decision_note ? <div className="dreq__muted">{request.decision_note}</div> : null}
      </>
    );
  }
  return (
    <>
      <strong>Approved</strong>
      <div className="dreq__muted">
        {request.usable
          ? "Usable — waiting for the desk to bill it"
          : `Used on ${billLabel(request.used_on?.bill_no)}`}
      </div>
      {request.decision_note ? <div className="dreq__muted">{request.decision_note}</div> : null}
    </>
  );
}

function PendingRow({ request, onAct }) {
  const subject = subjectOf(request);
  const newItem = request.kind === "new_item";
  return (
    <tr>
      <td>
        <strong>{request.requested_by?.name ?? "The desk"}</strong>
        <div className="dreq__muted">{when(request.requested_at)}</div>
      </td>
      <td>
        <Patient request={request} />
      </td>
      <td>
        <Wanted request={request} />
      </td>
      <td className="dreq__reason">{request.reason}</td>
      <td className="bill-items__actions">
        <button
          type="button"
          className="flow-btn flow-btn-primary flow-btn-mini"
          aria-label={newItem ? `Create item for ${subject}` : `Approve billing ${subject} again`}
          onClick={() => onAct(request, newItem ? "create" : "approve")}
        >
          {newItem ? "Create item" : "Approve"}
        </button>
        <button
          type="button"
          className="flow-btn flow-btn-ghost flow-btn-mini"
          aria-label={`Reject request for ${subject}`}
          onClick={() => onAct(request, "reject")}
        >
          Reject
        </button>
      </td>
    </tr>
  );
}

export default function DeskRequestsPage() {
  useDeskRequestsLive();
  const pending = usePendingDeskRequests({ refetchInterval: INBOX_POLL_MS });
  const history = useDeskRequests({ refetchInterval: INBOX_POLL_MS });
  const [acting, setActing] = useState(null);

  const waiting = pending.data ?? [];
  const decided = (history.data ?? []).filter((request) => request.status !== "pending");
  const close = (message) => {
    setActing(null);
    if (message) toast(message, "success");
  };

  return (
    <div className="flow-root fset">
      <div className="flow-card">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Waiting for an answer</h2>
          <span className="fset__count">{waiting.length}</span>
        </div>
        <div className="fset__cardsub">
          The billing desk asks here when an item is missing from the master, or when a patient
          needs an item billed a second time on one visit. A new-item request carries no price — you
          set the price when you create the item.
        </div>
        {pending.isLoading ? (
          <div className="fset__cardsub">Loading…</div>
        ) : pending.isError ? (
          <div className="fset__cardsub">Could not load the requests.</div>
        ) : waiting.length ? (
          <div className="fset__scroll fset__scroll--wide">
            <table className="flow-table" aria-label="Requests waiting">
              <thead>
                <tr>
                  <th>Asked by</th>
                  <th>Patient</th>
                  <th>What for</th>
                  <th>Why</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {waiting.map((request) => (
                  <PendingRow
                    key={request.id}
                    request={request}
                    onAct={(r, mode) => setActing({ request: r, mode })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fset__cardsub">Nothing is waiting for an answer.</div>
        )}
      </div>

      <div className="flow-card">
        <div className="fset__cardhead">
          <h2 className="flow-sec-title">Already answered</h2>
          <span className="fset__count">{decided.length}</span>
        </div>
        {history.isLoading ? (
          <div className="fset__cardsub">Loading…</div>
        ) : history.isError ? (
          <div className="fset__cardsub">Could not load the history.</div>
        ) : decided.length ? (
          <div className="fset__scroll fset__scroll--wide">
            <table className="flow-table" aria-label="Decided requests">
              <thead>
                <tr>
                  <th>Asked by</th>
                  <th>Patient</th>
                  <th>What for</th>
                  <th>Answer</th>
                  <th>Answered by</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <strong>{request.requested_by?.name ?? "The desk"}</strong>
                      <div className="dreq__muted">{when(request.requested_at)}</div>
                    </td>
                    <td>
                      <Patient request={request} />
                    </td>
                    <td>
                      <Wanted request={request} />
                      <div className="dreq__muted dreq__reason">{request.reason}</div>
                    </td>
                    <td>
                      <Answer request={request} />
                    </td>
                    <td>
                      {request.decided_by?.name ?? ""}
                      <div className="dreq__muted">{when(request.decided_at)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="fset__cardsub">Nothing has been answered yet.</div>
        )}
      </div>

      {acting?.mode === "create" ? (
        <DeskRequestItemDialog
          key={acting.request.id}
          request={acting.request}
          onClose={() => setActing(null)}
          onDone={close}
        />
      ) : null}
      {acting && acting.mode !== "create" ? (
        <DeskRequestDecisionDialog
          key={`${acting.request.id}-${acting.mode}`}
          request={acting.request}
          mode={acting.mode}
          subject={subjectOf(acting.request)}
          onClose={() => setActing(null)}
          onDone={close}
        />
      ) : null}
    </div>
  );
}
