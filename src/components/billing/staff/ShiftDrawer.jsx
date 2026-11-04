import { Link } from "react-router-dom";
import { useStaffShift } from "../../../queries/hooks/useStaffDashboard";
import { errorOf } from "../format";
import useDialog from "../useDialog";
import BillDialogLayer from "../BillDialogLayer";
import { receptionBillHref } from "../counter/billHref";
import { NEFT_LABEL } from "../../../../shared/billingVocab.js";
import { paymentModeText, takenModeText } from "../counter/lineText";
import { count, money } from "../dashboard/dashboardText";
import CashBadge from "./CashBadge";
import AdminCloseShift from "./AdminCloseShift";
import useAuthStore from "../../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../../shared/permissions.js";
import { ACTIVITY_LABEL, clock, hoursOpen, SOURCE_LABEL, timeOnly } from "./staffText";

function Handover({ shift }) {
  const takenCount = shift.payment_count + shift.deposits.count;
  return (
    <table className="bdash-bridge" aria-label="Cash handover">
      <tbody>
        <tr>
          <th scope="row">Opening cash</th>
          <td className="brep-num">{money(shift.opening_cash)}</td>
        </tr>
        <tr>
          <th scope="row">+ Cash taken</th>
          <td className="brep-num">{money(shift.collected.cash)}</td>
        </tr>
        <tr>
          <th scope="row">− Cash paid back</th>
          <td className="brep-num">
            {shift.refunded.cash ? `−${money(shift.refunded.cash)}` : money(0)}
          </td>
        </tr>
        <tr className="bdash-bridge__total">
          <th scope="row">= Expected in drawer</th>
          <td className="brep-num">{money(shift.expected_cash)}</td>
        </tr>
        <tr>
          <th scope="row">Counted</th>
          <td className="brep-num">
            {shift.counted_cash === null
              ? shift.is_open
                ? "Not closed yet"
                : "Not counted"
              : money(shift.counted_cash)}
          </td>
        </tr>
        <tr className="bdash-bridge__total">
          <th scope="row">Difference</th>
          <td className="brep-num">
            {shift.difference === null ? "—" : money(shift.difference)} <CashBadge shift={shift} />
          </td>
        </tr>
      </tbody>
      <caption className="sr-only">{count(takenCount)} payments and deposits in this shift</caption>
    </table>
  );
}

function OtherMoney({ shift, cleared }) {
  const net = (mode) => (shift.collected[mode] ?? 0) - (shift.refunded[mode] ?? 0);
  const clearedTotal = cleared.reduce((sum, row) => sum + row.amount, 0);
  const rows = [
    ["Card", net("card")],
    ["UPI", net("upi")],
    [NEFT_LABEL, net("neft")],
    ["Deposits taken (in the modes above)", shift.deposits.received],
    ["Paid in HealthRay (marked here)", shift.healthray.collected - shift.healthray.refunded],
    ["Paid earlier / online", shift.prepaid.collected],
    ["Cleared on Payments tab / fee changes (taken in HealthRay)", clearedTotal],
  ].filter(([, value]) => value);
  if (!rows.length)
    return <p className="bdash-muted">No card, UPI or HealthRay money in this shift.</p>;
  return (
    <table className="bdash-bridge" aria-label="Other money">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td className="brep-num">{money(value)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Payments({ detail, multiDay }) {
  if (!detail.payments.length) return <p className="bdash-muted">No payments in this shift.</p>;
  return (
    <div className="fset__scroll fset__scroll--tall">
      <table className="flow-table brep-table bdash-small" aria-label="Payments in this shift">
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Receipt</th>
            <th scope="col">Patient</th>
            <th scope="col">Bill</th>
            <th scope="col">Mode</th>
            <th scope="col">Reference</th>
            <th scope="col" className="brep-num">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {detail.payments.map((row) => {
            const amount = row.direction === "out" ? -row.amount : row.amount;
            const text = `${amount < 0 ? "−" : ""}${money(Math.abs(amount))}`;
            return (
              <tr key={row.id} className={row.voided_at ? "sd-voided" : undefined}>
                <td>{multiDay ? clock(row.received_at) : timeOnly(row.received_at)}</td>
                <td>{row.receipt_no ?? "—"}</td>
                <td className="bdash-wrap">
                  {row.patient_name ?? "—"}
                  {row.file_no ? <span className="bdash-muted"> · {row.file_no}</span> : null}
                </td>
                <td>
                  {row.bill_id ? (
                    <Link
                      className="brep-open"
                      to={receptionBillHref({
                        visit: row.visit_id,
                        bill: row.bill_id,
                        ...(row.bill_date ? { date: row.bill_date } : {}),
                      })}
                    >
                      {row.bill_no ?? "Draft"}
                    </Link>
                  ) : (
                    "Deposit"
                  )}
                </td>
                <td>
                  {takenModeText(row.mode, row.upi_app)}
                  {row.paid_via ? (
                    <span className="bdash-muted"> · paid by {paymentModeText(row.paid_via)}</span>
                  ) : null}
                  {row.direction === "out" ? <span className="bdash-muted"> · refund</span> : null}
                </td>
                <td className="bdash-wrap">{row.reference ?? "—"}</td>
                <td className="brep-num">
                  {row.voided_at ? (
                    <>
                      <s>{text}</s>
                      <span className="bdash-muted"> voided by {row.voided_by ?? "—"}</span>
                    </>
                  ) : (
                    text
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {detail.payments_truncated ? (
        <p className="bdash-muted">Only the first 1,000 payments are listed.</p>
      ) : null}
    </div>
  );
}

function Cleared({ rows, multiDay }) {
  if (!rows.length) return null;
  return (
    <>
      <h3 className="sd-drawer__sub">Cleared, taken in HealthRay ({rows.length})</h3>
      <div className="fset__scroll">
        <table
          className="flow-table brep-table bdash-small"
          aria-label="Cleared, taken in HealthRay"
        >
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Where</th>
              <th scope="col">Patient</th>
              <th scope="col">For</th>
              <th scope="col" className="brep-num">
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${row.source}-${index}`}>
                <td>{multiDay ? clock(row.at) : timeOnly(row.at)}</td>
                <td>{SOURCE_LABEL[row.source]}</td>
                <td className="bdash-wrap">
                  {row.patient_name ?? "—"}
                  {row.file_no ? <span className="bdash-muted"> · {row.file_no}</span> : null}
                </td>
                <td className="bdash-wrap">{row.item}</td>
                <td className="brep-num">{money(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Activity({ rows, changes, multiDay }) {
  return (
    <>
      <h3 className="sd-drawer__sub">Bills and discounts ({rows.length})</h3>
      {!rows.length ? (
        <p className="bdash-muted">No bills finalised or cancelled, and no manual discounts.</p>
      ) : (
        <ul className="sd-list">
          {rows.map((row, index) => (
            <li key={`${row.kind}-${row.bill_id}-${index}`}>
              <span>
                {multiDay ? clock(row.at) : timeOnly(row.at)} ·{" "}
                <strong>{ACTIVITY_LABEL[row.kind]}</strong> {row.bill_no ?? "draft"} ·{" "}
                {row.patient_name ?? "—"} · {money(row.amount)}
                {row.note ? ` · “${row.note}”` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {changes.length ? (
        <>
          <h3 className="sd-drawer__sub">Changed after close ({changes.length})</h3>
          <ul className="sd-list" aria-label="Changed after close">
            {changes.map((row) => (
              <li key={`${row.payment_id}-${row.at}`}>
                <span>
                  {clock(row.at)} · {row.by ?? "—"} changed a payment from{" "}
                  {takenModeText(row.before?.mode, row.before?.upi_app) || "—"} to{" "}
                  {takenModeText(row.after?.mode, row.after?.upi_app) || "—"}
                  {row.after?.reason ? ` · “${row.after.reason}”` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

export default function ShiftDrawer({ id, onClose }) {
  const { data, isLoading, isError, error, refetch } = useStaffShift(id);
  const ref = useDialog(Boolean(id), onClose);
  if (!id) return null;
  const role = useAuthStore((st) => st.currentDoctor?.role);
  const canClose = hasCapability(role, CAPABILITIES.BILLING_MASTER);
  const shift = data?.shift;
  const multiDay = Boolean(shift) && (shift.is_open ? shift.left_open : shift.crosses_midnight);
  return (
    <BillDialogLayer>
      <div
        className="flow-dialog-backdrop bill-drawer-backdrop"
        onClick={onClose}
        role="presentation"
      >
        <aside
          ref={ref}
          className="flow-card bill-drawer sd-drawer bdash-page"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sd-drawer-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bill-dialog__head">
            <h2 id="sd-drawer-title" className="bill-dialog__title">
              {shift
                ? `${shift.user.name ?? "Desk"} · shift of ${clock(shift.opened_at)}`
                : "Shift"}
            </h2>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={onClose}
            >
              Close
            </button>
          </div>
          {isLoading ? <p className="bdash-muted">Loading the shift…</p> : null}
          {isError ? (
            <div className="brep-error" role="alert">
              {errorOf(error, "Could not load this shift")}{" "}
              <button type="button" className="flow-btn flow-btn-mini" onClick={() => refetch()}>
                Try again
              </button>
            </div>
          ) : null}
          {shift ? (
            <>
              <p className="bdash-muted sd-drawer__meta">
                Opened {clock(shift.opened_at)}
                {shift.is_open
                  ? ` · open for ${hoursOpen(shift)}`
                  : ` · closed ${clock(shift.closed_at)} (${hoursOpen(shift)})`}
                {shift.note ? ` · Note: “${shift.note}”` : ""}
              </p>
              <p>
                <Link
                  className="brep-open"
                  to={`/billing/shift-slip/${shift.id}`}
                  target="_blank"
                  rel="noopener"
                >
                  Print handover slip
                </Link>
              </p>
              <h3 className="sd-drawer__sub">Cash handover</h3>
              <Handover shift={shift} />
              {shift.is_open && canClose ? <AdminCloseShift shift={shift} /> : null}
              <h3 className="sd-drawer__sub">Other money (not in the drawer)</h3>
              <OtherMoney shift={shift} cleared={data.cleared} />
              <h3 className="sd-drawer__sub">Payments ({data.payments.length})</h3>
              <Payments detail={data} multiDay={multiDay} />
              <Cleared rows={data.cleared} multiDay={multiDay} />
              <Activity rows={data.activity} changes={data.changes} multiDay={multiDay} />
            </>
          ) : null}
        </aside>
      </div>
    </BillDialogLayer>
  );
}
