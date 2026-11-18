import { useState } from "react";
import { Link } from "react-router-dom";
import { DecideCreditDialog } from "./CreditDialogs";
import { inr } from "./format";
import { useCreditRequests } from "../../queries/hooks/usePharmacyCredit";
import { CREDIT_STATUS_LABEL } from "../../../shared/pharmacyVocab";

const BADGE = { pending: "review", approved: "ok", used: "ok", rejected: "out", withdrawn: "out" };

const moment = (value) =>
  value
    ? new Date(value).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

export function DecideButtons({ request, onDecide }) {
  return (
    <span className="pcr-decide">
      <button
        type="button"
        className="flow-btn flow-btn-primary"
        aria-label={`Approve credit for ${request.patient_name}`}
        onClick={() => onDecide({ request, decision: "approve" })}
      >
        Approve
      </button>
      <button
        type="button"
        className="flow-btn flow-btn-ghost"
        aria-label={`Refuse credit for ${request.patient_name}`}
        onClick={() => onDecide({ request, decision: "reject" })}
      >
        Refuse
      </button>
    </span>
  );
}

export function useBillCreditRequest(billId, enabled) {
  const query = useCreditRequests({ status: "pending", bill_id: billId, limit: 1 }, { enabled });
  return query.data?.rows?.[0] ?? null;
}

export function DecideCreditFor({ deciding, onClose }) {
  return deciding ? (
    <DecideCreditDialog request={deciding.request} decision={deciding.decision} onClose={onClose} />
  ) : null;
}

export default function PatientCreditRequests({ patientId }) {
  const query = useCreditRequests({ status: "all", patient_id: patientId, limit: 20 });
  const [deciding, setDeciding] = useState(null);
  const rows = query.data?.rows ?? [];
  const waiting = rows.filter((r) => r.status === "pending").length;

  return (
    <section className="flow-card" aria-labelledby="pac-credit-title">
      <div className="fset__cardhead">
        <h2 id="pac-credit-title" className="flow-sec-title">
          Credit requests
        </h2>
        <span className="fset__count">{query.data?.total ?? 0}</span>
        {waiting ? (
          <span className="bill-status phs-badge phs-badge--review">{waiting} waiting</span>
        ) : null}
      </div>
      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load the credit requests.</p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : query.isLoading ? (
        <p className="phs-empty" role="status">
          Loading…
        </p>
      ) : !rows.length ? (
        <p className="phs-empty">This patient has never asked for credit.</p>
      ) : (
        <div className="fset__scroll">
          <table className="flow-table phs-table" aria-label="Credit requests for this patient">
            <thead>
              <tr>
                <th>Bill</th>
                <th className="phs-num">Bill total</th>
                <th className="phs-num">Pay later</th>
                <th>Reason</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="Bill">
                    <Link className="phs-item" to={`/pharmacy/billing/${r.bill_id}`}>
                      {r.bill_no ?? "Draft bill"}
                    </Link>
                    <span className="phs-meta">
                      Asked by {r.requested_by_name ?? "—"} {moment(r.requested_at)}
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
                    <span className={`bill-status phs-badge phs-badge--${BADGE[r.status]}`}>
                      {CREDIT_STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="phb-line-acts">
                    {r.status === "pending" ? (
                      <DecideButtons request={r} onDecide={setDeciding} />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DecideCreditFor deciding={deciding} onClose={() => setDeciding(null)} />
    </section>
  );
}
