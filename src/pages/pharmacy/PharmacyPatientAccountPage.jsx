import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasAnyCapability, hasCapability } from "../../../shared/permissions";
import { DepositDialog, WriteOffDialog } from "../../components/pharmacy/AccountDialogs";
import { inr, showDate } from "../../components/pharmacy/format";
import { usePatientAccount } from "../../queries/hooks/usePharmacyAccounts";
import { ACCOUNT_ENTRY_LABEL } from "../../../shared/pharmacyVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const OUT = ["bill", "deposit_refund", "voucher_debit", "refund_paid"];

const when = (value) =>
  new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export default function PharmacyPatientAccountPage() {
  const { patientId } = useParams();
  const role = useAuthStore((s) => s.currentDoctor?.role);
  const canMoney = hasAnyCapability(role, [
    CAPABILITIES.PHARMACY_BILL,
    CAPABILITIES.PHARMACY_COLLECT,
  ]);
  const canAdjust = hasCapability(role, CAPABILITIES.PHARMACY_CREDIT_APPROVE);
  const canSeeLedger = hasAnyCapability(role, [
    CAPABILITIES.PHARMACY_REPORTS,
    CAPABILITIES.PHARMACY_CREDIT_APPROVE,
  ]);
  const query = usePatientAccount(patientId);
  const [dialog, setDialog] = useState(null);
  const account = query.data;

  return (
    <div className="flow-root fset bill-ui phs phb">
      {canSeeLedger ? (
        <Link className="phb-back" to="/pharmacy/ledger">
          <ArrowLeft size={14} aria-hidden="true" />
          Patient ledger
        </Link>
      ) : null}
      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load this account. Please try again.</p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : !account ? (
        <p className="phs-empty" role="status">
          Loading…
        </p>
      ) : (
        <>
          <header className="phs-head">
            <div>
              <h1 className="phs-title">{account.name}</h1>
              <p className="phs-sub">
                {[account.file_no, account.phone].filter(Boolean).join(" · ")} · pharmacy account
              </p>
            </div>
            <div className="phs-head__acts">
              {canMoney && Number(account.balance) > 0 ? (
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost"
                  onClick={() => setDialog({ kind: "refund" })}
                >
                  Refund deposit
                </button>
              ) : null}
              {canMoney ? (
                <button
                  type="button"
                  className="flow-btn flow-btn-primary"
                  onClick={() => setDialog({ kind: "deposit" })}
                >
                  Receive deposit
                </button>
              ) : null}
            </div>
          </header>

          <section className="flow-card" aria-label="Account summary">
            <dl className="phs-tiles">
              <div className="phs-tile">
                <dt>Deposit balance</dt>
                <dd>{inr(account.balance)}</dd>
                <dd className="phd-note">Can be used to pay pharmacy bills</dd>
              </div>
              <div className={`phs-tile${account.open_bills.length ? " phd-tile--warn" : ""}`}>
                <dt>Money due</dt>
                <dd>{inr(account.open_bills.reduce((sum, b) => sum + Number(b.due_amount), 0))}</dd>
                <dd className="phd-note">
                  {account.open_bills.length} bill{account.open_bills.length === 1 ? "" : "s"}
                </dd>
              </div>
            </dl>
          </section>

          {account.open_bills.length ? (
            <section className="flow-card" aria-labelledby="pac-open-title">
              <h2 id="pac-open-title" className="flow-sec-title">
                Bills with money due
              </h2>
              <table className="flow-table phs-table" aria-label="Bills with money due">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th className="phs-num">Bill total</th>
                    <th className="phs-num">Due</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {account.open_bills.map((b) => (
                    <tr key={b.id}>
                      <td data-label="Bill">
                        <Link className="phs-item" to={`/pharmacy/billing/${b.id}`}>
                          {b.bill_no}
                        </Link>
                        <span className="phs-meta">{showDate(b.bill_date)}</span>
                      </td>
                      <td data-label="Bill total" className="phs-num">
                        {inr(b.net_amount)}
                      </td>
                      <td data-label="Due" className="phs-num phb-due">
                        {inr(b.due_amount)}
                      </td>
                      <td className="phb-line-acts">
                        {canAdjust ? (
                          <button
                            type="button"
                            className="flow-btn flow-btn-ghost"
                            aria-label={`Write off due on bill ${b.bill_no}`}
                            onClick={() => setDialog({ kind: "writeoff", bill: b })}
                          >
                            Write off
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <section className="flow-card" aria-labelledby="pac-statement-title">
            <h2 id="pac-statement-title" className="flow-sec-title">
              Statement
            </h2>
            {!account.statement.length ? (
              <p className="phs-empty">Nothing on this account yet.</p>
            ) : (
              <div className="fset__scroll">
                <table className="flow-table phs-table psl-table" aria-label="Account statement">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Type</th>
                      <th>Reference</th>
                      <th>Note</th>
                      <th className="phs-num">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.statement.map((s, i) => (
                      <tr key={`${s.ref}-${i}`}>
                        <td data-label="Date">{when(s.at)}</td>
                        <td data-label="Type">{ACCOUNT_ENTRY_LABEL[s.kind] ?? s.kind}</td>
                        <td data-label="Reference">
                          {s.bill_id && s.kind === "bill" ? (
                            <Link className="phs-item" to={`/pharmacy/billing/${s.bill_id}`}>
                              {s.ref}
                            </Link>
                          ) : (
                            <span className="phv-mono">{s.ref}</span>
                          )}
                        </td>
                        <td data-label="Note">{s.note ?? "—"}</td>
                        <td data-label="Amount" className="phs-num">
                          {OUT.includes(s.kind) ? "" : "+"}
                          {inr(s.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {dialog?.kind === "deposit" ? (
            <DepositDialog account={account} onClose={() => setDialog(null)} />
          ) : null}
          {dialog?.kind === "refund" ? (
            <DepositDialog account={account} refund onClose={() => setDialog(null)} />
          ) : null}
          {dialog?.kind === "writeoff" ? (
            <WriteOffDialog bill={dialog.bill} onClose={() => setDialog(null)} />
          ) : null}
        </>
      )}
    </div>
  );
}
