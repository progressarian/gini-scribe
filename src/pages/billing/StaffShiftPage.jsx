import { useId, useState } from "react";
import { Link, useLocation, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Printer } from "lucide-react";
import Shimmer from "../../components/Shimmer";
import Pagination from "../../components/ui/Pagination";
import { useStaffShift } from "../../queries/hooks/useStaffDashboard";
import { errorOf } from "../../components/billing/format";
import { receptionBillHref } from "../../components/billing/counter/billHref";
import { paymentModeText, takenModeText } from "../../components/billing/counter/lineText";
import { count, money } from "../../components/billing/dashboard/dashboardText";
import CashBadge from "../../components/billing/staff/CashBadge";
import AdminCloseShift from "../../components/billing/staff/AdminCloseShift";
import SlipDialog from "../../components/billing/staff/SlipDialog";
import { Handover, OtherMoney } from "../../components/billing/staff/ShiftSummary";
import {
  ACTIVITY_LABEL,
  clock,
  hoursOpen,
  SOURCE_LABEL,
} from "../../components/billing/staff/staffText";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasCapability } from "../../../shared/permissions.js";
import { HEALTHRAY_MODE, PREPAID_MODE } from "../../../shared/billingVocab.js";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";
import "./billingDashboard.css";

const PAGE_SIZE = 25;
const OUTSIDE_MODES = [HEALTHRAY_MODE, PREPAID_MODE];

const PAYMENT_KINDS = [
  { key: "", label: "All payments" },
  { key: "cash", label: "Cash" },
  { key: "card", label: "Card" },
  { key: "upi", label: "UPI" },
  { key: "neft", label: "NEFT / Cheque" },
  { key: HEALTHRAY_MODE, label: "Paid in HealthRay" },
  { key: "refund", label: "Refunds" },
  { key: "voided", label: "Voided" },
];

const ACTIVITY_KINDS = [
  { key: "", label: "Everything" },
  { key: "finalised", label: "Bills finalised" },
  { key: "closed_by_cancel", label: "Closed by test cancel" },
  { key: "cancelled", label: "Bills cancelled" },
  { key: "manual_discount", label: "Manual discounts" },
];

const pageOf = (view, total) => Math.min(view.page, Math.max(1, Math.ceil(total / PAGE_SIZE)));

const kindOf = (kinds, kind) => (kinds.some((option) => option.key === kind) ? kind : "");

const matches = (query, ...values) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return values.some((value) =>
    String(value ?? "")
      .toLowerCase()
      .includes(q),
  );
};

function paymentKind(row, kind) {
  if (!kind) return true;
  if (kind === "voided") return Boolean(row.voided_at);
  if (kind === "refund") return row.direction === "out";
  return row.mode === kind && row.direction === "in";
}

function billLink(row) {
  return receptionBillHref({
    ...(row.visit_id ? { visit: row.visit_id } : {}),
    ...(row.bill_id ? { bill: row.bill_id } : {}),
    ...(row.bill_date ? { date: row.bill_date } : {}),
  });
}

function Toolbar({ query, onQuery, kinds, kind, onKind, placeholder, found, unit }) {
  const searchId = useId();
  const kindId = useId();
  return (
    <div className="bill-form brep-filters sd-toolbar" role="search">
      <div className="fset__field brep-field sd-toolbar__search">
        <label htmlFor={searchId}>Search</label>
        <input
          id={searchId}
          className="jb-assign"
          type="search"
          value={query}
          placeholder={placeholder}
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      {kinds ? (
        <div className="fset__field brep-field">
          <label htmlFor={kindId}>Show</label>
          <select
            id={kindId}
            className="jb-assign"
            value={kind}
            onChange={(e) => onKind(e.target.value)}
          >
            {kinds.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <p className="sd-found" role="status">
        {count(found)} {unit}
      </p>
    </div>
  );
}

function Empty({ filtered, what }) {
  return (
    <div className="bdash-empty">
      {filtered ? `No ${what} match this search.` : `No ${what} in this shift.`}
    </div>
  );
}

function PaymentsTab({ rows, view }) {
  const kind = kindOf(PAYMENT_KINDS, view.kind);
  const shown = rows.filter(
    (row) =>
      paymentKind(row, kind) &&
      matches(
        view.query,
        row.patient_name,
        row.file_no,
        row.receipt_no,
        row.bill_no,
        row.reference,
      ),
  );
  const current = pageOf(view, shown.length);
  const page = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const inTotal = shown.reduce(
    (sum, row) =>
      row.voided_at ? sum : sum + (row.direction === "out" ? -row.amount : row.amount),
    0,
  );
  return (
    <>
      <Toolbar
        query={view.query}
        onQuery={view.setQuery}
        kinds={PAYMENT_KINDS}
        kind={kind}
        onKind={view.setKind}
        placeholder="Patient, UHID, receipt, bill or reference"
        found={shown.length}
        unit={`payments · ${money(inTotal)}`}
      />
      {!shown.length ? (
        <Empty filtered={Boolean(view.query || kind)} what="payments" />
      ) : (
        <div className="fset__scroll">
          <table
            className="flow-table brep-table bdash-small sd-wide"
            aria-label="Payments in this shift"
          >
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
              {page.map((row) => {
                const amount = row.direction === "out" ? -row.amount : row.amount;
                const text = `${amount < 0 ? "−" : ""}${money(Math.abs(amount))}`;
                return (
                  <tr key={row.id} className={row.voided_at ? "sd-voided" : undefined}>
                    <td>{clock(row.received_at)}</td>
                    <td>{row.receipt_no ?? "—"}</td>
                    <td className="bdash-wrap">
                      {row.patient_name ?? "—"}
                      {row.file_no ? <span className="bdash-muted"> · {row.file_no}</span> : null}
                    </td>
                    <td>
                      {row.bill_id ? (
                        <Link className="brep-open" to={billLink(row)}>
                          {row.bill_no ?? "Draft"}
                        </Link>
                      ) : (
                        "Deposit"
                      )}
                    </td>
                    <td>
                      {takenModeText(row.mode, row.upi_app)}
                      {row.paid_via ? (
                        <span className="bdash-muted">
                          {" "}
                          · paid by {paymentModeText(row.paid_via)}
                        </span>
                      ) : null}
                      {row.direction === "out" ? (
                        <span className="bdash-muted"> · refund</span>
                      ) : null}
                      {row.outside_shift && !OUTSIDE_MODES.includes(row.mode) ? (
                        <span className="bdash-muted"> · taken with no shift open</span>
                      ) : null}
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
        </div>
      )}
      <Pagination
        page={current}
        pageSize={PAGE_SIZE}
        total={shown.length}
        onChange={view.setPage}
        unit="payments"
      />
    </>
  );
}

function ClearedTab({ rows, view }) {
  const shown = rows.filter((row) => matches(view.query, row.patient_name, row.file_no, row.item));
  const current = pageOf(view, shown.length);
  const page = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  return (
    <>
      <p className="bdash-muted sd-tabnote">
        Tests cleared on the Payments tab and consultant fee changes settled. The money was taken in
        HealthRay, so it is not in this shift&apos;s drawer.
      </p>
      <Toolbar
        query={view.query}
        onQuery={view.setQuery}
        placeholder="Patient, UHID or test"
        found={shown.length}
        unit={`cleared · ${money(shown.reduce((sum, row) => sum + row.amount, 0))}`}
      />
      {!shown.length ? (
        <Empty filtered={Boolean(view.query)} what="clearances" />
      ) : (
        <div className="fset__scroll">
          <table
            className="flow-table brep-table bdash-small sd-wide"
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
              {page.map((row, index) => (
                <tr key={`${row.source}-${row.at}-${index}`}>
                  <td>{clock(row.at)}</td>
                  <td>{SOURCE_LABEL[row.source]}</td>
                  <td className="bdash-wrap">
                    {row.patient_name ?? "—"}
                    {row.file_no ? <span className="bdash-muted"> · {row.file_no}</span> : null}
                  </td>
                  <td className="sd-for">{row.item}</td>
                  <td className="brep-num">{money(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={current}
        pageSize={PAGE_SIZE}
        total={shown.length}
        onChange={view.setPage}
        unit="clearances"
      />
    </>
  );
}

function ActivityTab({ rows, view }) {
  const kind = kindOf(ACTIVITY_KINDS, view.kind);
  const shown = rows.filter(
    (row) =>
      (!kind || row.kind === kind) &&
      matches(view.query, row.patient_name, row.file_no, row.bill_no, row.note),
  );
  const current = pageOf(view, shown.length);
  const page = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  return (
    <>
      <Toolbar
        query={view.query}
        onQuery={view.setQuery}
        kinds={ACTIVITY_KINDS}
        kind={kind}
        onKind={view.setKind}
        placeholder="Patient, UHID, bill number or reason"
        found={shown.length}
        unit="entries"
      />
      {!shown.length ? (
        <Empty filtered={Boolean(view.query || kind)} what="bills or discounts" />
      ) : (
        <div className="fset__scroll">
          <table
            className="flow-table brep-table bdash-small sd-wide"
            aria-label="Bills and discounts"
          >
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">What</th>
                <th scope="col">Bill</th>
                <th scope="col">Patient</th>
                <th scope="col" className="brep-num">
                  Amount
                </th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {page.map((row, index) => (
                <tr key={`${row.kind}-${row.bill_id}-${index}`}>
                  <td>{clock(row.at)}</td>
                  <td>{ACTIVITY_LABEL[row.kind]}</td>
                  <td>
                    {row.bill_id ? (
                      <Link className="brep-open" to={billLink(row)}>
                        {row.bill_no ?? "Draft"}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="bdash-wrap">
                    {row.patient_name ?? "—"}
                    {row.file_no ? <span className="bdash-muted"> · {row.file_no}</span> : null}
                  </td>
                  <td className="brep-num">
                    {row.kind === "manual_discount" ? `−${money(row.amount)}` : money(row.amount)}
                  </td>
                  <td className="bdash-wrap">{row.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination
        page={current}
        pageSize={PAGE_SIZE}
        total={shown.length}
        onChange={view.setPage}
        unit="entries"
      />
    </>
  );
}

const TABS = [
  { key: "payments", label: "Payments" },
  { key: "cleared", label: "Cleared in HealthRay" },
  { key: "activity", label: "Bills and discounts" },
];

export default function StaffShiftPage() {
  const { id } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const tabsId = useId();
  const role = useAuthStore((st) => st.currentDoctor?.role);
  const { data, isLoading, isError, error, refetch } = useStaffShift(id);
  const [slipOpen, setSlipOpen] = useState(false);
  const back = `/billing/staff${location.state?.back ?? ""}`;
  const tab = TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "payments";

  const setParam = (patch) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true, state: location.state },
    );

  const view = {
    query: params.get("q") ?? "",
    kind: params.get("show") ?? "",
    page: Math.max(1, Number(params.get("page")) || 1),
    setQuery: (q) => setParam({ q, page: "" }),
    setKind: (show) => setParam({ show, page: "" }),
    setPage: (page) => setParam({ page: page > 1 ? String(page) : "" }),
  };

  if (isLoading) {
    return (
      <div className="flow-root fset bill-ui bdash-page">
        <Shimmer type="stats" count={2} />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flow-root fset bill-ui bdash-page">
        <div className="flow-card brep-error" role="alert">
          {errorOf(error, "Could not load this shift")}{" "}
          <button type="button" className="flow-btn flow-btn-mini" onClick={() => refetch()}>
            Try again
          </button>{" "}
          <Link to={back}>Back to Staff &amp; shifts</Link>
        </div>
      </div>
    );
  }

  const shift = data.shift;
  const outsideCount = data.payments.filter((row) => OUTSIDE_MODES.includes(row.mode)).length;
  const canClose = shift.is_open && hasCapability(role, CAPABILITIES.BILLING_MASTER);
  const counts = {
    payments: data.payments.length,
    cleared: data.cleared.length,
    activity: data.activity.length,
  };
  return (
    <div className="flow-root fset bill-ui bdash-page">
      <div className="flow-card bill-stack">
        <Link className="sd-back" to={back} aria-label="Back to Staff & shifts">
          <ArrowLeft size={14} aria-hidden="true" /> Staff &amp; shifts
        </Link>
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">
            {shift.user.name ?? "Desk"} · shift of {clock(shift.opened_at)}{" "}
            <CashBadge shift={shift} withAmount />
          </h1>
          <div className="bdash-actions">
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-ghost"
              onClick={() => setSlipOpen(true)}
            >
              <Printer size={13} aria-hidden="true" /> Print handover slip
            </button>
          </div>
        </div>
        <div className="fset__cardsub">
          Opened {clock(shift.opened_at)}
          {shift.is_open
            ? ` · open for ${hoursOpen(shift)}`
            : ` · closed ${clock(shift.closed_at)} (${hoursOpen(shift)})`}
          {` · ${count(data.payments.length)} payments`}
          {outsideCount ? ` (${count(outsideCount)} of them marked paid in HealthRay)` : ""}
          {shift.note ? ` · Note: “${shift.note}”` : ""}
        </div>
      </div>

      <div className="bdash-grid">
        <section className="flow-card bdash-card" aria-labelledby="sd-cash">
          <div className="fset__cardhead">
            <h2 id="sd-cash" className="flow-sec-title">
              Cash in the drawer
            </h2>
          </div>
          <Handover shift={shift} />
        </section>
        <section className="flow-card bdash-card" aria-labelledby="sd-other">
          <div className="fset__cardhead">
            <h2 id="sd-other" className="flow-sec-title">
              Other money (not in the drawer)
            </h2>
          </div>
          <OtherMoney shift={shift} cleared={data.cleared} />
        </section>
      </div>

      {canClose ? (
        <section className="flow-card bdash-card sd-drawer">
          <AdminCloseShift shift={shift} />
        </section>
      ) : null}

      {data.changes.length ? (
        <section className="flow-card bdash-card" aria-labelledby="sd-changes">
          <div className="fset__cardhead">
            <h2 id="sd-changes" className="flow-sec-title">
              Changed after close
            </h2>
          </div>
          <ul className="sd-list">
            {data.changes.map((row) => (
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
        </section>
      ) : null}

      <section className="flow-card bdash-card">
        <div className="set__tabs brep-tabs" role="tablist" aria-label="Shift details">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`${tabsId}-${t.key}`}
              aria-selected={t.key === tab}
              aria-controls={`${tabsId}-panel`}
              className={`set__tab brep-tab${t.key === tab ? " set__tab--on" : ""}`}
              onClick={() =>
                setParam({ tab: t.key === "payments" ? "" : t.key, q: "", show: "", page: "" })
              }
            >
              {t.label} <span className="fset__count">{count(counts[t.key])}</span>
            </button>
          ))}
        </div>
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${tab}`}>
          {tab === "payments" ? <PaymentsTab rows={data.payments} view={view} /> : null}
          {tab === "cleared" ? <ClearedTab rows={data.cleared} view={view} /> : null}
          {tab === "activity" ? <ActivityTab rows={data.activity} view={view} /> : null}
        </div>
        {data.payments_truncated && tab === "payments" ? (
          <p className="bdash-muted">Only the first 1,000 payments are listed.</p>
        ) : null}
      </section>
      <SlipDialog data={data} open={slipOpen} onClose={() => setSlipOpen(false)} />
    </div>
  );
}
