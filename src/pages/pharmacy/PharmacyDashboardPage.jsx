import { Link } from "react-router-dom";
import { inr } from "../../components/pharmacy/format";
import { usePharmacyDashboard } from "../../queries/hooks/usePharmacyReports";
import { SALE_TYPE_LABEL } from "../../../shared/pharmacyVocab";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "./pharmacyStock.css";
import "./pharmacyVendors.css";
import "./pharmacyBills.css";

const time = (value) =>
  new Date(value).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

function Tile({ label, value, to, note, tone }) {
  return (
    <div className={`phs-tile${tone ? ` phd-tile--${tone}` : ""}`}>
      <dt>{label}</dt>
      <dd>{to ? <Link to={to}>{value}</Link> : value}</dd>
      {note ? <dd className="phd-note">{note}</dd> : null}
    </div>
  );
}

export default function PharmacyDashboardPage() {
  const query = usePharmacyDashboard();
  const d = query.data;

  return (
    <div className="flow-root fset bill-ui phs phb">
      <header className="phs-head">
        <div>
          <h1 className="phs-title">Pharmacy today</h1>
          <p className="phs-sub">
            Sales, money due, stock and expiry at a glance. Updates every minute.
          </p>
        </div>
        <div className="phs-head__acts">
          <Link className="flow-btn flow-btn-ghost phs-upload" to="/pharmacy/reports">
            Reports
          </Link>
          <Link className="flow-btn flow-btn-primary phs-upload" to="/pharmacy/billing">
            Pharmacy bills
          </Link>
        </div>
      </header>

      {query.isError ? (
        <div className="phs-empty" role="alert">
          <p>Unable to load the dashboard. Please try again.</p>
          <button type="button" className="flow-btn flow-btn-ghost" onClick={() => query.refetch()}>
            Try again
          </button>
        </div>
      ) : !d ? (
        <p className="phs-empty" role="status">
          Loading…
        </p>
      ) : (
        <>
          <section className="flow-card" aria-label="Today's figures">
            <dl className="phs-tiles">
              <Tile
                label="Net sales today"
                value={inr(d.sales.net_sales)}
                note={`${d.sales.bills} bill${d.sales.bills === 1 ? "" : "s"}`}
                to="/pharmacy/reports?report=sales"
              />
              <Tile
                label="Collected today"
                value={inr(d.collected)}
                to="/pharmacy/reports?report=collections"
              />
              <Tile
                label="Money due"
                value={inr(d.dues.due)}
                note={`${d.dues.bills} bill${d.dues.bills === 1 ? "" : "s"}`}
                to="/pharmacy/credit?tab=dues"
                tone={Number(d.dues.due) > 0 ? "warn" : null}
              />
              <Tile
                label="Credit requests waiting"
                value={d.pending_credit}
                to="/pharmacy/credit"
                tone={d.pending_credit ? "warn" : null}
              />
              <Tile
                label="Out of stock"
                value={d.stock.out_of_stock}
                note="Medicines with a minimum set"
                to="/pharmacy/stock?filter=out"
                tone={d.stock.out_of_stock ? "bad" : null}
              />
              <Tile
                label="Below minimum"
                value={d.stock.low}
                to="/pharmacy/stock?filter=low"
                tone={d.stock.low ? "warn" : null}
              />
              <Tile
                label="Expired on shelf"
                value={d.expiry.expired}
                note="Batches"
                to="/pharmacy/expiry?bucket=expired"
                tone={d.expiry.expired ? "bad" : null}
              />
              <Tile
                label="Expiring in 30 days"
                value={d.expiry.within_30}
                note="Batches"
                to="/pharmacy/expiry?bucket=30"
                tone={d.expiry.within_30 ? "warn" : null}
              />
            </dl>
          </section>

          <section className="flow-card" aria-labelledby="phd-recent-title">
            <h2 id="phd-recent-title" className="flow-sec-title">
              Latest bills
            </h2>
            {!d.recent.length ? (
              <p className="phs-empty">No pharmacy bills yet.</p>
            ) : (
              <table className="flow-table phs-table" aria-label="Latest bills">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Patient</th>
                    <th>Type</th>
                    <th className="phs-num">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recent.map((b) => (
                    <tr key={b.id}>
                      <td data-label="Bill">
                        <Link className="phs-item" to={`/pharmacy/billing/${b.id}`}>
                          {b.bill_no}
                        </Link>
                        <span className="phs-meta">{time(b.finalised_at)}</span>
                      </td>
                      <td data-label="Patient">{b.patient_name}</td>
                      <td data-label="Type">
                        {b.bill_type === "credit_note" ? "Return" : SALE_TYPE_LABEL[b.sale_type]}
                      </td>
                      <td data-label="Amount" className="phs-num">
                        {b.bill_type === "credit_note" ? "−" : ""}
                        {inr(b.net_amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
