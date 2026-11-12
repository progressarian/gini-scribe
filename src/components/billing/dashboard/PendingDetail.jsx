import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import Shimmer from "../../Shimmer";
import { usePendingDetail } from "../../../queries/hooks/useBillingDashboard";
import { receptionBillHref } from "../counter/billHref";
import { errorOf } from "../format";
import { count, fullDayLabel, money } from "./dashboardText";

function reasonOf(row) {
  if (row.reason === "to_deposit") return "No bill — kept as the patient's deposit";
  if (row.reason === "earlier_dues") {
    const day = fullDayLabel(row.bill_date);
    return row.credit_note
      ? `Refund on a credit note dated ${day}`
      : `Due on a bill dated ${day}, paid later`;
  }
  const short = row.bill_total - row.bill_paid;
  if (row.bill_status === "cancelled") return "Bill was cancelled";
  if (short > 0) {
    return `Not final — ${money(short)} still due (bill ${money(row.bill_total)}, paid ${money(row.bill_paid)})`;
  }
  return "Paid in full but not finalised yet";
}

const IST_DAY_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

function Patient({ patient }) {
  return (
    <td className="bdash-wrap">
      {patient.name || "—"}
      <span className="bdash-muted"> · {patient.file_no || "No UHID"}</span>
    </td>
  );
}

function Services({ text }) {
  return <td className="bdash-wrap bdash-services">{text || "—"}</td>;
}

function BillRef({ row }) {
  if (!row.bill_id) return <span className="bdash-muted">No bill</span>;
  const label = row.bill_no || "Draft";
  return (
    <Link
      className="brep-open"
      to={receptionBillHref({ patient: row.patient.id, date: row.bill_date })}
      title="Open at the counter"
    >
      {label}
      {row.credit_note ? " (credit note)" : ""}
    </Link>
  );
}

function billReasonOf(row) {
  if (row.from_deposit && row.from_deposit === row.gap) {
    return row.credit_note
      ? "Refund kept as the patient's deposit"
      : "Paid from the patient's deposit";
  }
  if (row.credit_note) return "Refund not paid back in this period";
  if (!row.collected) return "Not collected in this period";
  return row.gap > 0 ? "Partly collected in this period" : "More collected than billed";
}

function PaymentsTable({ block }) {
  if (!block.rows.length) {
    return <p className="bdash-small-empty bdash-muted">No money from other days or deposits.</p>;
  }
  return (
    <div className="fset__scroll fset__scroll--tall">
      <table className="flow-table brep-table bdash-small" aria-label="Money taken in this period">
        <thead>
          <tr>
            <th scope="col">Taken on</th>
            <th scope="col">Patient</th>
            <th scope="col">Bill</th>
            <th scope="col">Bill date</th>
            <th scope="col">Services</th>
            <th scope="col">Reason</th>
            <th scope="col">Mode</th>
            <th scope="col" className="brep-num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{IST_DAY_TIME.format(new Date(row.received_at))}</th>
              <Patient patient={row.patient} />
              <td>
                <BillRef row={row} />
              </td>
              <td>{row.bill_date ? fullDayLabel(row.bill_date) : "—"}</td>
              <Services text={row.services} />
              <td className="bdash-wrap bdash-reason">{reasonOf(row)}</td>
              <td>{row.mode}</td>
              <td className="brep-num">{money(row.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={7}>
              Total
            </th>
            <td className="brep-num">{money(block.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function BillsTable({ block }) {
  if (!block.rows.length) {
    return (
      <p className="bdash-small-empty bdash-muted">Every bill in this period was collected.</p>
    );
  }
  return (
    <div className="fset__scroll fset__scroll--tall">
      <table className="flow-table brep-table bdash-small" aria-label="Bills not fully collected">
        <thead>
          <tr>
            <th scope="col">Bill date</th>
            <th scope="col">Patient</th>
            <th scope="col">Bill</th>
            <th scope="col">Services</th>
            <th scope="col" className="brep-num">
              Billed
            </th>
            <th scope="col" className="brep-num">
              Collected in period
            </th>
            <th scope="col" className="brep-num">
              From deposit
            </th>
            <th scope="col" className="brep-num">
              Pending
            </th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row) => (
            <tr key={row.bill_id}>
              <th scope="row">{fullDayLabel(row.bill_date)}</th>
              <Patient patient={row.patient} />
              <td>
                <BillRef row={row} />
              </td>
              <Services text={row.services} />
              <td className="brep-num">{money(row.billed)}</td>
              <td className="brep-num">{money(row.collected)}</td>
              <td className="brep-num">{row.from_deposit ? money(row.from_deposit) : "—"}</td>
              <td className="brep-num bdash-strong">{money(row.gap)}</td>
              <td className="bdash-wrap bdash-reason">{billReasonOf(row)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row" colSpan={7}>
              Total
            </th>
            <td className="brep-num">{money(block.total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const moreText = (block) =>
  block.truncated
    ? `Showing the first ${block.rows.length} of ${count(block.count)} — narrow the dates to see the rest.`
    : null;

export default function PendingDetail({ filters, onClose }) {
  const detail = usePendingDetail(filters);
  const section = useRef(null);
  const heading = useRef(null);
  useEffect(() => {
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    section.current?.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
    heading.current?.focus?.({ preventScroll: true });
  }, []);
  const data = detail.data;
  return (
    <section
      ref={section}
      className="flow-card bdash-card bdash-pending"
      aria-labelledby="bdash-pending-detail"
    >
      <div className="fset__cardhead">
        <h2 id="bdash-pending-detail" className="flow-sec-title" ref={heading} tabIndex={-1}>
          Pending detail{data ? ` · ${money(data.pending)}` : ""}
        </h2>
        <button
          type="button"
          className="flow-btn flow-btn-mini flow-btn-ghost bdash-close"
          onClick={onClose}
          aria-label="Close pending detail"
        >
          <X size={14} aria-hidden="true" /> Close
        </button>
      </div>
      {detail.isError ? (
        <div className="brep-error" role="alert">
          {errorOf(detail.error, "Could not load the pending detail")}{" "}
          <button type="button" className="flow-btn flow-btn-mini" onClick={() => detail.refetch()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <Shimmer type="table" count={4} />
      ) : (
        <>
          <h3 className="bdash-subtitle">
            Money taken in this period, not for this period&apos;s final bills ·{" "}
            {count(data.payments.count)} · {money(data.payments.total)}
          </h3>
          <PaymentsTable block={data.payments} />
          {moreText(data.payments) ? <p className="bdash-foot">{moreText(data.payments)}</p> : null}
          <h3 className="bdash-subtitle">
            Bills in this period not fully collected in this period · {count(data.bills.count)} ·{" "}
            {money(data.bills.total)}
          </h3>
          <BillsTable block={data.bills} />
          {moreText(data.bills) ? <p className="bdash-foot">{moreText(data.bills)}</p> : null}
          <p className="bdash-foot">
            Pending = bills not collected ({money(data.bills.total)}) − extra money taken (
            {money(data.payments.total)}) = {money(data.pending)}
          </p>
        </>
      )}
    </section>
  );
}
