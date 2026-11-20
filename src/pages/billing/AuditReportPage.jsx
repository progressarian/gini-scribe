import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, FileText, RotateCcw } from "lucide-react";
import {
  AUDIT_BILL_KINDS,
  AUDIT_BILL_SORT_DEFAULT,
  AUDIT_BILL_SORTS,
  AUDIT_CLAIM_STATUSES,
  AUDIT_DOCUMENTS,
  AUDIT_ITEM_KINDS,
  AUDIT_ITEM_SORTS,
  AUDIT_LINE_SOURCES,
  AUDIT_PAGE_SIZE,
  AUDIT_PAGE_SIZES,
  AUDIT_PAYMENT_MODES,
  AUDIT_PAYMENT_STATES,
  AUDIT_SEARCH_MAX,
  AUDIT_STATUSES,
  AUDIT_VIEWS,
  auditRangeProblem,
  labelOf,
} from "../../../shared/billingAudit";
import { DEPOSIT_MODE, HEALTHRAY_MODE } from "../../../shared/billingVocab";
import {
  auditBillPdfHref,
  useBillingAudit,
  useBillingAuditExport,
} from "../../queries/hooks/useBillingAudit";
import { toast } from "../../stores/uiStore";
import { fromPaise, requestErrorOf } from "../../components/billing/format";
import { saveBlob } from "../../components/billing/importText";
import { todayInIndia } from "../../components/billing/RequestFilters";
import { RANGES } from "../../components/billing/reportRanges";
import FilterPopover from "../../components/billing/FilterPopover";
import Dropdown from "../../components/ui/Dropdown";
import DatePicker from "../../components/DatePicker";
import TimePicker from "../../components/ui/TimePicker";
import { PdfButton } from "../../components/billing/counter/PdfViewer";
import Pagination from "../../components/ui/Pagination";
import PinnableTable from "../../components/billing/PinnableTable";
import useDialog from "../../components/billing/useDialog";
import BillDialogLayer from "../../components/billing/BillDialogLayer";
import Shimmer from "../../components/Shimmer";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";
import "./cghsRegister.css";
import "./auditReport.css";

const VIEW_LABEL = { bills: "Bills", items: "Bill items" };
const PRESETS = RANGES.filter((r) => r.range && !r.openOnly);
const RANGE_KEYS = ["from", "to", "from_time", "to_time"];

const BILL_FILTERS = {
  kind: "",
  group: "",
  document: "",
  status: "",
  payment: "",
  category: "",
  sub_category: "",
  consultant: "",
  created_by: "",
  finalised_by: "",
  payer: "",
  claim: "",
  mode: "",
  bill_no: "",
  min: "",
  max: "",
  sort: AUDIT_BILL_SORT_DEFAULT,
};

const ITEM_FILTERS = {
  item: "",
  kind: "",
  group: "",
  subgroup: "",
  source: "",
  doctor: "",
  document: "",
  status: "",
  category: "",
  sub_category: "",
  min: "",
  max: "",
  sort: "newest",
};

const FILTERS_OF = { bills: BILL_FILTERS, items: ITEM_FILTERS };

function readState(params, today) {
  const view = AUDIT_VIEWS.includes(params.get("view")) ? params.get("view") : "bills";
  const preset = PRESETS.find((r) => r.key === "month").range(today);
  const blank = FILTERS_OF[view];
  const filters = Object.fromEntries(
    Object.keys(blank).map((key) => [key, params.get(key) ?? blank[key]]),
  );
  const size = Number(params.get("page_size"));
  return {
    view,
    q: params.get("q") ?? "",
    from: params.get("from") ?? preset.from,
    to: params.get("to") ?? preset.to,
    from_time: params.get("from_time") ?? "",
    to_time: params.get("to_time") ?? "",
    filters,
    page: Math.max(1, Number(params.get("page")) || 1),
    page_size: AUDIT_PAGE_SIZES.includes(size) ? size : AUDIT_PAGE_SIZE,
  };
}

function writeState(state) {
  const next = new URLSearchParams();
  next.set("view", state.view);
  for (const key of ["q", ...RANGE_KEYS]) if (state[key]) next.set(key, state[key]);
  const blank = FILTERS_OF[state.view];
  for (const [key, value] of Object.entries(state.filters)) {
    if (value !== "" && value !== blank[key]) next.set(key, value);
  }
  if (state.page > 1) next.set("page", String(state.page));
  if (state.page_size !== AUDIT_PAGE_SIZE) next.set("page_size", String(state.page_size));
  return next;
}

function amountProblem({ min, max }) {
  const lo = min === "" ? null : Number(min);
  const hi = max === "" ? null : Number(max);
  if (
    (lo !== null && (!Number.isFinite(lo) || lo < 0)) ||
    (hi !== null && (!Number.isFinite(hi) || hi < 0))
  ) {
    return "Enter amounts as positive numbers, like 500 or 1250.50";
  }
  if (lo !== null && hi !== null && lo > hi) return "The smallest amount is more than the largest";
  return null;
}

const STATUS_TONE = { draft: "draft", final: "final", cancelled: "cancelled" };
const PAYMENT_TONE = {
  paid: "ok",
  partial: "warn",
  unpaid: "bad",
  no_charge: "muted",
  not_applicable: "muted",
};

function SelectField({ label, value, onChange, options, anyLabel }) {
  const choices = anyLabel === undefined ? options : [{ value: "", label: anyLabel }, ...options];
  return (
    <div className="fset__field brep-field audit-select">
      <span aria-hidden="true">{label}</span>
      <Dropdown value={value} options={choices} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

const DATE_STYLE = {
  height: 36,
  padding: "0 32px 0 34px",
  borderRadius: 8,
  border: "1px solid var(--ui-field)",
  fontSize: 13,
  color: "var(--ui-ink)",
};

function DateChoice({ label, value, onChange, minDate, maxDate }) {
  return (
    <div className="fset__field brep-field audit-select">
      <span aria-hidden="true">{label}</span>
      <DatePicker
        value={value}
        onChange={onChange}
        minDate={minDate}
        maxDate={maxDate}
        clearable={false}
        placeholder="Choose a date"
        ariaLabel={label}
        style={DATE_STYLE}
      />
    </div>
  );
}

function TimeChoice({ label, value, onChange }) {
  return (
    <div className="fset__field brep-field audit-select">
      <span aria-hidden="true">{label}</span>
      <TimePicker value={value} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

function Pill({ tone, children }) {
  return <span className={`audit-pill audit-pill--${tone}`}>{children}</span>;
}

function RangeBar({ state, today, onRange }) {
  const presetKey =
    PRESETS.find((r) => {
      const range = r.range(today);
      return range.from === state.from && range.to === state.to;
    })?.key ?? "custom";
  return (
    <fieldset className="audit-range">
      <legend className="cghs-sr">Bill date and time</legend>
      <SelectField
        label="Period"
        value={presetKey}
        onChange={(key) => {
          const preset = PRESETS.find((r) => r.key === key);
          if (preset) onRange(preset.range(today));
        }}
        options={[
          ...PRESETS.map((r) => ({ value: r.key, label: r.label })),
          { value: "custom", label: "Custom range" },
        ]}
      />
      <DateChoice
        label="Start date"
        value={state.from}
        maxDate={today}
        onChange={(from) => onRange({ from })}
      />
      <TimeChoice
        label="Start time"
        value={state.from_time}
        onChange={(from_time) => onRange({ from_time })}
      />
      <DateChoice
        label="End date"
        value={state.to}
        minDate={state.from || undefined}
        maxDate={today}
        onChange={(to) => onRange({ to })}
      />
      <TimeChoice
        label="End time"
        value={state.to_time}
        onChange={(to_time) => onRange({ to_time })}
      />
    </fieldset>
  );
}

function MoreFilters({ view, filters, options, onChange }) {
  const set = (key) => (value) => {
    const next = { ...filters, [key]: value };
    if (key === "category") next.sub_category = "";
    if (key === "group" && "subgroup" in next) next.subgroup = "";
    onChange(next);
  };
  const subs = (options?.sub_categories ?? []).filter(
    (s) => !filters.category || s.parent === filters.category,
  );
  const subgroups = (options?.subgroups ?? []).filter(
    (s) => !filters.group || s.parent === filters.group,
  );
  const blank = FILTERS_OF[view];
  const active = Object.keys(blank).filter(
    (key) => key !== "sort" && key !== "status" && filters[key] !== blank[key],
  ).length;
  const cleared = !active && filters.sort === blank.sort;
  const money = (key, label) => (
    <div className="fset__field brep-field">
      <label htmlFor={`audit-${view}-${key}`}>{label}</label>
      <input
        id={`audit-${view}-${key}`}
        type="number"
        min="0"
        step="0.01"
        inputMode="decimal"
        className="jb-assign"
        value={filters[key]}
        onChange={(e) => set(key)(e.target.value)}
      />
    </div>
  );
  const text = (key, label, placeholder) => (
    <div className="fset__field brep-field">
      <label htmlFor={`audit-${view}-${key}`}>{label}</label>
      <input
        id={`audit-${view}-${key}`}
        type="search"
        className="jb-assign"
        value={filters[key]}
        maxLength={key === "payer" ? 120 : AUDIT_SEARCH_MAX}
        placeholder={placeholder}
        onChange={(e) => set(key)(e.target.value)}
      />
    </div>
  );
  return (
    <FilterPopover
      active={active}
      cleared={cleared}
      onClear={() => onChange({ ...blank, status: filters.status })}
    >
      {view === "items" && text("item", "Item", "Item name or code")}
      <SelectField
        label={view === "bills" ? "Bill type" : "Item type"}
        value={filters.kind}
        onChange={set("kind")}
        options={view === "bills" ? AUDIT_BILL_KINDS : AUDIT_ITEM_KINDS}
        anyLabel="All types"
      />
      <SelectField
        label="Department"
        value={filters.group}
        onChange={set("group")}
        options={options?.groups ?? []}
        anyLabel="All departments"
      />
      {view === "items" && (
        <SelectField
          label="Sub-department"
          value={filters.subgroup}
          onChange={set("subgroup")}
          options={subgroups}
          anyLabel="All sub-departments"
        />
      )}
      <SelectField
        label="Document"
        value={filters.document}
        onChange={set("document")}
        options={AUDIT_DOCUMENTS}
        anyLabel="Invoices and credit notes"
      />
      {view === "bills" && (
        <SelectField
          label="Payment status"
          value={filters.payment}
          onChange={set("payment")}
          options={AUDIT_PAYMENT_STATES}
          anyLabel="Any payment status"
        />
      )}
      <SelectField
        label="Doctor"
        value={view === "bills" ? filters.consultant : filters.doctor}
        onChange={set(view === "bills" ? "consultant" : "doctor")}
        options={options?.doctors ?? []}
        anyLabel="All doctors"
      />
      <SelectField
        label="Category"
        value={filters.category}
        onChange={set("category")}
        options={options?.categories ?? []}
        anyLabel="All categories"
      />
      <SelectField
        label="Sub-category"
        value={filters.sub_category}
        onChange={set("sub_category")}
        options={subs}
        anyLabel="All sub-categories"
      />
      {view === "items" && (
        <SelectField
          label="Item source"
          value={filters.source}
          onChange={set("source")}
          options={AUDIT_LINE_SOURCES}
          anyLabel="All sources"
        />
      )}
      {view === "bills" && (
        <>
          <SelectField
            label="Payment mode"
            value={filters.mode}
            onChange={set("mode")}
            options={AUDIT_PAYMENT_MODES}
            anyLabel="Any mode"
          />
          <SelectField
            label="Claim status"
            value={filters.claim}
            onChange={set("claim")}
            options={AUDIT_CLAIM_STATUSES}
            anyLabel="Any claim status"
          />
          {text("payer", "Payer", "Payer name")}
          <SelectField
            label="Created by"
            value={filters.created_by}
            onChange={set("created_by")}
            options={options?.staff ?? []}
            anyLabel="Anyone"
          />
          <SelectField
            label="Finalised by"
            value={filters.finalised_by}
            onChange={set("finalised_by")}
            options={options?.staff ?? []}
            anyLabel="Anyone"
          />
        </>
      )}
      {money("min", view === "bills" ? "Payable at least (₹)" : "Amount at least (₹)")}
      {money("max", view === "bills" ? "Payable at most (₹)" : "Amount at most (₹)")}
      <SelectField
        label="Sort"
        value={filters.sort}
        onChange={set("sort")}
        options={view === "bills" ? AUDIT_BILL_SORTS : AUDIT_ITEM_SORTS}
      />
    </FilterPopover>
  );
}

function ModeCollections({ view, modes }) {
  const received = modes
    .filter((m) => m.collected > 0)
    .map((m) => (m.mode === DEPOSIT_MODE ? { ...m, label: "Paid from patient deposit" } : m));
  return (
    <section className="audit-modes" aria-labelledby="audit-modes-title" data-testid="audit-modes">
      <div className="audit-modes__head">
        <h2 id="audit-modes-title" className="audit-modes__title">
          Collected by payment mode
        </h2>
        <p className="flow-muted">
          {view === "items"
            ? "Payments on the bills that contain these items"
            : "Payments on the bills in this report"}
        </p>
      </div>
      {received.length ? (
        <dl className="audit-totals">
          {received.map((m) => (
            <div key={m.mode} className="audit-totals__cell">
              <dt>{m.label}</dt>
              <dd>{fromPaise(m.collected)}</dd>
              <dd className="audit-modes__meta">
                {m.payments} payment{m.payments === 1 ? "" : "s"}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="flow-muted">No payments recorded on these bills.</p>
      )}
    </section>
  );
}

const REFUND_LABEL = {
  [DEPOSIT_MODE]: "Kept as patient deposit",
  [HEALTHRAY_MODE]: "Refunded in HealthRay (mode not recorded)",
};

function RefundsByMode({ modes, creditNotes }) {
  const refunds = modes
    .filter((m) => m.refunded > 0)
    .sort((a, b) => b.refunded - a.refunded)
    .map((m) => ({ ...m, label: REFUND_LABEL[m.mode] ?? m.label }));
  if (!refunds.length) return null;
  const total = refunds.reduce((sum, m) => sum + m.refunded, 0);
  const paidBack = refunds
    .filter((m) => m.mode !== DEPOSIT_MODE)
    .reduce((sum, m) => sum + m.refunded, 0);
  return (
    <section
      className="audit-modes"
      aria-labelledby="audit-refunds-title"
      data-testid="audit-refunds"
    >
      <div className="audit-modes__head">
        <h2 id="audit-refunds-title" className="audit-modes__title">
          Refunds
        </h2>
        <p className="flow-muted">
          <strong>{fromPaise(total)}</strong> refunded
          {creditNotes > 0 ? ` on ${creditNotes} credit note${creditNotes === 1 ? "" : "s"}` : ""}
          {paidBack !== total ? ` · ${fromPaise(paidBack)} paid back to patients` : ""}
        </p>
      </div>
      <dl className="audit-totals">
        {refunds.map((m) => (
          <div key={m.mode} className="audit-totals__cell">
            <dt>{m.label}</dt>
            <dd>{fromPaise(m.refunded)}</dd>
            <dd className="audit-modes__meta">
              {m.refunds} refund{m.refunds === 1 ? "" : "s"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function GroupTotals({ groups, totals }) {
  if (!groups.length) return null;
  return (
    <section
      className="audit-modes"
      aria-labelledby="audit-groups-title"
      data-testid="audit-groups"
    >
      <div className="audit-modes__head">
        <h2 id="audit-groups-title" className="audit-modes__title">
          Amount by department
        </h2>
        <p className="flow-muted">
          Total <strong>{fromPaise(totals.payable)}</strong> payable · {totals.items} item
          {totals.items === 1 ? "" : "s"} on {totals.bills} bill{totals.bills === 1 ? "" : "s"}
        </p>
      </div>
      <dl className="audit-totals">
        {groups.map((g) => (
          <div key={g.code ?? "none"} className="audit-totals__cell">
            <dt>{g.name ?? "No department"}</dt>
            <dd>{fromPaise(g.payable)}</dd>
            <dd className="audit-modes__meta">
              {g.items} item{g.items === 1 ? "" : "s"} · {g.bills} bill{g.bills === 1 ? "" : "s"}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const percentOf = (discount, total) =>
  discount > 0 && total > 0 ? `${Number(((discount * 100) / total).toFixed(1))}%` : null;

const MONEY_PARTS = [
  { key: "total", label: "Total amount", field: "basic" },
  { key: "discount", label: "Discount", field: "discount", percentOf: "basic" },
  { key: "payable", label: "Payable", field: "payable" },
  {
    key: "billed",
    label: "Billed in Scribe",
    field: "billed",
    count: "billed_bills",
    noun: "final bill",
    totalsOnly: true,
  },
  { key: "paid", label: "Net paid", field: "paid", lessRefunds: true },
  { key: "due", label: "Due", field: "due" },
  {
    key: "draft",
    label: "In draft (not billed)",
    field: "draft",
    count: "drafts",
    noun: "draft bill",
    totalsOnly: true,
  },
  { key: "refunded", label: "Refunded", field: "refunded" },
];

function Totals({ view, totals }) {
  if (view !== "bills") {
    const cells = [
      ["Items", totals.items],
      ["Bills", totals.bills],
      ["Quantity", totals.quantity],
      ["Gross", fromPaise(totals.gross)],
      ["Discount", fromPaise(totals.discount)],
      ["Tax", fromPaise(totals.tax)],
      ["Payable", fromPaise(totals.payable)],
      ["Claim", fromPaise(totals.claim)],
    ];
    return (
      <dl className="audit-totals" aria-label="Totals for these filters" data-testid="audit-totals">
        {cells.map(([label, value]) => (
          <div key={label} className="audit-totals__cell">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <div
      className="audit-totals audit-totals--split"
      role="group"
      aria-label="Totals for these filters"
      data-testid="audit-totals"
    >
      <div className="audit-totals__cell">
        <p className="audit-totals__label">Rows</p>
        <p className="audit-totals__value">{totals.bills}</p>
        <p className="flow-muted">
          {totals.scribe_bills} bill{totals.scribe_bills === 1 ? "" : "s"}
        </p>
      </div>
      {MONEY_PARTS.map((part) => {
        const percent = part.percentOf
          ? percentOf(totals[part.field], totals[part.percentOf])
          : null;
        return (
          <div key={part.key} className="audit-totals__cell">
            <p className="audit-totals__label">{part.label}</p>
            <p className="audit-totals__value">
              {fromPaise(totals[part.field])}
              {percent ? <span className="audit-pct"> {percent} off</span> : null}
            </p>
            {part.lessRefunds ? (
              <NetOfRefunds net={totals[part.field]} refunded={totals.refunded} />
            ) : null}
            {part.count ? (
              <p className="flow-muted">
                {totals[part.count]} {part.noun}
                {totals[part.count] === 1 ? "" : "s"}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ViewBill({ billId, billNo }) {
  if (!billId) return <span className="flow-muted">No Scribe bill</span>;
  const name = billNo || "draft";
  return (
    <PdfButton
      className="flow-btn flow-btn-ghost flow-btn-mini"
      href={auditBillPdfHref(billId)}
      title={`Bill ${name}`}
      fileName={`Bill_${billNo || "draft"}.pdf`}
      aria-label={`View bill ${name}`}
    >
      <FileText size={13} aria-hidden="true" /> View bill
    </PdfButton>
  );
}

const billNoText = (bill) => bill.bill_no || "Draft";

function DayBillsDialog({ row, onClose }) {
  const ref = useDialog(Boolean(row), onClose);
  const titleId = useId();
  if (!row) return null;
  return (
    <BillDialogLayer>
      <div
        className="flow-dialog-backdrop bill-drawer-backdrop"
        onClick={onClose}
        role="presentation"
      >
        <aside
          ref={ref}
          className="flow-card bill-drawer audit-day-bills"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bill-dialog__head">
            <h2 id={titleId} className="bill-dialog__title">
              Bills of {row.patient.name}
            </h2>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={onClose}
            >
              Close
            </button>
          </div>
          <p className="flow-muted audit-day-bills__meta">
            {[row.patient.file_no, row.bill_date].filter(Boolean).join(" · ")}
          </p>
          <div className="fset__scroll">
            <table className="flow-table" aria-label={`Bills of ${row.patient.name}`}>
              <thead>
                <tr>
                  <th scope="col">S.No</th>
                  <th scope="col">Bill number</th>
                  <th scope="col">Date and time</th>
                  <th scope="col">Status</th>
                  <th scope="col" className={NUM}>
                    Payable
                  </th>
                  <th scope="col">PDF</th>
                </tr>
              </thead>
              <tbody>
                {row.bills.map((bill, index) => (
                  <tr key={bill.id}>
                    <td data-label="S.No">{index + 1}</td>
                    <td data-label="Bill number">
                      <strong>{billNoText(bill)}</strong>
                      {bill.document === "credit_note" ? (
                        <div className="flow-muted">
                          Credit note for {dash(bill.original_bill_no)}
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Date and time">{bill.bill_at || row.bill_date}</td>
                    <td data-label="Status">
                      <Pill tone={STATUS_TONE[bill.status]}>
                        {labelOf(AUDIT_STATUSES, bill.status)}
                      </Pill>
                    </td>
                    <td data-label="Payable" className={NUM}>
                      {fromPaise(bill.payable)}
                    </td>
                    <td data-label="PDF" className="bill-items__actions">
                      <ViewBill billId={bill.id} billNo={bill.bill_no} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </BillDialogLayer>
  );
}

function BillActions({ row }) {
  const [open, setOpen] = useState(false);
  if (row.bill_count <= 1) return <ViewBill billId={row.bill_id} billNo={row.bill_no} />;
  return (
    <>
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`View ${row.bill_count} bills of ${row.patient.name}`}
      >
        <FileText size={13} aria-hidden="true" /> View bills ({row.bill_count})
      </button>
      <DayBillsDialog row={open ? row : null} onClose={() => setOpen(false)} />
    </>
  );
}

const dash = (value) => (value === null || value === undefined || value === "" ? "—" : value);
const ageSex = (p) => [p.age ? `${p.age}y` : null, p.sex].filter(Boolean).join(" / ");
const rupeeOrDash = (value) => (value === null || value === undefined ? "—" : fromPaise(value));

function NetOfRefunds({ net, refunded }) {
  if (!(refunded > 0)) return null;
  return (
    <p className="flow-muted audit-net">
      {fromPaise(net + refunded)} received − {fromPaise(refunded)} refunded
    </p>
  );
}

function MoneyCell({ row, part }) {
  const amount = row.amounts[part.field];
  const percent = part.percentOf ? percentOf(amount, row.amounts[part.percentOf]) : null;
  const tax = part.key === "payable" && row.amounts.tax > 0 ? row.amounts.tax : 0;
  return (
    <>
      <strong>{fromPaise(amount)}</strong>
      {percent ? <div className="audit-pct">{percent} off</div> : null}
      {tax ? <div className="flow-muted">Incl. {fromPaise(tax)} tax</div> : null}
      {part.lessRefunds ? <NetOfRefunds net={amount} refunded={row.amounts.refunded} /> : null}
    </>
  );
}

const NUM = "cghs-num";

const BILL_COLUMNS = [
  { key: "serial", header: "S.No", className: NUM, cell: (row) => row.serial },
  {
    key: "bill",
    header: "Bill number",
    cell: (row) => (
      <>
        <strong>{row.bills.map(billNoText).join(", ")}</strong>
        {row.bill_count > 1 ? <div className="flow-muted">{row.bill_count} bills</div> : null}
        <div className="flow-muted">
          {row.bill_count > 1 && row.last_bill_at && row.last_bill_at !== row.bill_at
            ? `${row.bill_at} – ${row.last_bill_at.slice(11)}`
            : row.bill_at || row.bill_date}
        </div>
        {row.document === "credit_note" ? (
          <div className="flow-muted">Credit note for {dash(row.original_bill_no)}</div>
        ) : null}
      </>
    ),
  },
  {
    key: "patient",
    header: "Patient",
    cell: (row) => (
      <>
        <strong>{row.patient.name}</strong>
        <div className="flow-muted">{dash(row.patient.file_no)}</div>
        <div className="flow-muted">
          {[ageSex(row.patient), row.patient.phone].filter(Boolean).join(" · ") || "—"}
        </div>
        {row.patient.address ? (
          <div className="flow-muted audit-address" title={row.patient.address}>
            {row.patient.address}
          </div>
        ) : null}
      </>
    ),
  },
  ...MONEY_PARTS.filter((part) => !part.totalsOnly).map((part) => ({
    key: part.key,
    header: part.label,
    className: NUM,
    cell: (row) => <MoneyCell row={row} part={part} />,
  })),
  {
    key: "status",
    header: "Status",
    cell: (row) => (
      <>
        <div className="audit-pills">
          {row.payment_state && row.payment_state !== "not_applicable" ? (
            <Pill tone={PAYMENT_TONE[row.payment_state]}>
              {labelOf(AUDIT_PAYMENT_STATES, row.payment_state)}
            </Pill>
          ) : null}
          {[...new Set(row.bills.map((bill) => bill.status))].map((status) => (
            <Pill key={status} tone={STATUS_TONE[status]}>
              {labelOf(AUDIT_STATUSES, status)}
            </Pill>
          ))}
          {row.pay_later ? <Pill tone="muted">Pay later</Pill> : null}
        </div>
        {row.payment_modes.length ? (
          <div className="flow-muted">
            {row.payment_modes.map((m) => labelOf(AUDIT_PAYMENT_MODES, m)).join(", ")}
          </div>
        ) : null}
      </>
    ),
  },
  {
    key: "type",
    header: "Type and department",
    cell: (row) => (
      <>
        {labelOf(AUDIT_BILL_KINDS, row.bill_kind)}
        <div className="flow-muted">{dash(row.departments)}</div>
      </>
    ),
  },
  {
    key: "doctor",
    header: "Doctor",
    cell: (row) => (
      <>
        {dash(row.consultant)}
        {row.referred_by ? <div className="flow-muted">Referred by {row.referred_by}</div> : null}
      </>
    ),
  },
  {
    key: "category",
    header: "Category and payer",
    cell: (row) => (
      <>
        {dash(row.category_label)}
        {row.payer_name ? <div className="flow-muted">{row.payer_name}</div> : null}
        {row.claim_status && row.claim_status !== "none" && row.amounts ? (
          <div className="flow-muted">
            {labelOf(AUDIT_CLAIM_STATUSES, row.claim_status)} · {fromPaise(row.amounts.claim)}
          </div>
        ) : null}
        {row.discount_reason ? (
          <div className="flow-muted">Discount: {row.discount_reason}</div>
        ) : null}
      </>
    ),
  },
  {
    key: "recorded",
    header: "Recorded by",
    cell: (row) =>
      row.bill_id ? (
        <>
          <div>Created: {dash(row.created_by)}</div>
          <div className="flow-muted">Finalised: {dash(row.finalised_by)}</div>
          <div className="flow-muted">Updated: {dash(row.updated_by)}</div>
          {row.cancelled_by ? (
            <div className="flow-muted">
              Cancelled: {dash(row.cancelled_by)} · {dash(row.cancelled_at)}
              {row.cancel_reason ? ` — ${row.cancel_reason}` : ""}
            </div>
          ) : null}
        </>
      ) : (
        "—"
      ),
  },
  {
    key: "actions",
    header: "Actions",
    label: "",
    pinnable: false,
    className: "bill-items__actions",
    headClassName: "bill-items__actions-head",
    cell: (row) => <BillActions row={row} />,
  },
];

const ITEM_COLUMNS = [
  {
    key: "item",
    header: "Item",
    cell: (row) => (
      <>
        <strong>{row.item}</strong>
        <div className="flow-muted">{dash(row.item_code)}</div>
      </>
    ),
  },
  {
    key: "bill",
    header: "Bill",
    cell: (row) => (
      <>
        {row.bill_no || "Draft"}
        <div className="flow-muted">{row.bill_at}</div>
      </>
    ),
  },
  {
    key: "patient",
    header: "Patient",
    cell: (row) => (
      <>
        {row.patient.name}
        <div className="flow-muted">{dash(row.patient.file_no)}</div>
      </>
    ),
  },
  {
    key: "department",
    header: "Department",
    cell: (row) => (
      <>
        {dash(row.group_name || row.group)}
        <div className="flow-muted">{dash(row.subgroup_name || row.subgroup)}</div>
      </>
    ),
  },
  {
    key: "type",
    header: "Type and source",
    cell: (row) => (
      <>
        {labelOf(AUDIT_ITEM_KINDS, row.kind)}
        <div className="flow-muted">{labelOf(AUDIT_LINE_SOURCES, row.source)}</div>
      </>
    ),
  },
  { key: "doctor", header: "Doctor", cell: (row) => dash(row.doctor) },
  { key: "qty", header: "Qty", className: NUM, cell: (row) => row.quantity },
  { key: "rate", header: "Rate", className: NUM, cell: (row) => fromPaise(row.amounts.rate) },
  { key: "gross", header: "Gross", className: NUM, cell: (row) => fromPaise(row.amounts.gross) },
  {
    key: "discount",
    header: "Discount",
    className: NUM,
    cell: (row) => {
      const percent = percentOf(row.amounts.discount, row.amounts.gross);
      return (
        <>
          {fromPaise(row.amounts.discount)}
          {percent ? <div className="audit-pct">{percent} off</div> : null}
        </>
      );
    },
  },
  { key: "tax", header: "Tax", className: NUM, cell: (row) => fromPaise(row.amounts.tax) },
  {
    key: "payable",
    header: "Payable",
    className: NUM,
    cell: (row) => <strong>{fromPaise(row.amounts.payable)}</strong>,
  },
  {
    key: "status",
    header: "Status",
    cell: (row) => (
      <div className="audit-pills">
        <Pill tone={STATUS_TONE[row.status]}>{labelOf(AUDIT_STATUSES, row.status)}</Pill>
        {row.document === "credit_note" ? <Pill tone="muted">Credit note</Pill> : null}
      </div>
    ),
  },
  {
    key: "actions",
    header: "Actions",
    label: "",
    pinnable: false,
    className: "bill-items__actions",
    headClassName: "bill-items__actions-head",
    cell: (row) => <ViewBill billId={row.bill_id} billNo={row.bill_no} />,
  },
];

function BillsTable({ rows, first }) {
  const numbered = rows.map((row, index) => ({ ...row, serial: first + index }));
  return (
    <PinnableTable
      ariaLabel="Bills"
      className="audit-table"
      columns={BILL_COLUMNS}
      rows={numbered}
      rowKey={(row) => row.row_key}
      storageKey="gini.billingAudit.pins.bills.v2"
      defaultPinned={["serial", "bill", "patient"]}
    />
  );
}

function ItemsTable({ rows }) {
  return (
    <PinnableTable
      ariaLabel="Bill items"
      className="audit-table"
      columns={ITEM_COLUMNS}
      rows={rows}
      rowKey={(row) => row.line_id}
      storageKey="gini.billingAudit.pins.items"
      defaultPinned={["item", "bill"]}
    />
  );
}

export default function AuditReportPage() {
  const [params, setParams] = useSearchParams();
  const today = todayInIndia();
  const state = useMemo(() => readState(params, today), [params, today]);
  const [q, setQ] = useState(state.q);
  const [billNo, setBillNo] = useState(state.filters.bill_no ?? "");
  const exporting = useBillingAuditExport();
  const searchId = useId();
  const billNoId = useId();

  const latest = useRef(state);
  latest.current = state;

  const update = (patch, { keepPage = false } = {}) => {
    const next = { ...latest.current, ...patch };
    if (!keepPage) next.page = 1;
    latest.current = next;
    setParams(writeState(next), { replace: true });
  };

  useEffect(() => {
    if (q.trim() === state.q) return undefined;
    const timer = setTimeout(() => update({ q: q.trim() }), 300);
    return () => clearTimeout(timer);
  }, [q, state.q]);

  useEffect(() => {
    if (state.view !== "bills" || billNo.trim() === (state.filters.bill_no ?? "")) return undefined;
    const timer = setTimeout(
      () => update({ filters: { ...state.filters, bill_no: billNo.trim() } }),
      300,
    );
    return () => clearTimeout(timer);
  }, [billNo, state.filters.bill_no, state.view]);

  const problem = auditRangeProblem(state) || amountProblem(state.filters);
  const asked = {
    q: state.q,
    from: state.from,
    to: state.to,
    from_time: state.from_time,
    to_time: state.to_time,
    ...state.filters,
  };
  const report = useBillingAudit(
    state.view,
    { ...asked, page: state.page, page_size: state.page_size },
    !problem,
  );
  const data = report.data;
  const rows = data?.rows ?? [];
  const total = state.view === "bills" ? data?.totals?.bills : data?.totals?.items;

  const clearAll = () => {
    setQ("");
    setBillNo("");
    setParams(writeState({ ...readState(new URLSearchParams(), today), view: state.view }), {
      replace: true,
    });
  };

  const pristine =
    !q &&
    !billNo &&
    writeState(state).toString() ===
      writeState({ ...readState(new URLSearchParams(), today), view: state.view }).toString();

  const changeView = (view) => {
    setQ("");
    setBillNo("");
    setParams(
      writeState({
        ...readState(new URLSearchParams({ view }), today),
        from: state.from,
        to: state.to,
        from_time: state.from_time,
        to_time: state.to_time,
      }),
      {
        replace: true,
      },
    );
  };

  const download = async () => {
    try {
      saveBlob(await exporting.mutateAsync({ view: state.view, filters: asked }));
      toast("Excel file downloaded", "success");
    } catch (err) {
      toast(requestErrorOf(err, "Could not export the report"), "error", 6000);
    }
  };

  return (
    <div className="flow-root fset bill-ui cghs-page reg-compact audit-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead reg-head audit-head">
          <h1 className="flow-sec-title">Billing audit</h1>
          <div className="cghs-tabs reg-tabs" role="tablist" aria-label="Report">
            {AUDIT_VIEWS.map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={state.view === view}
                className={`cghs-tab${state.view === view ? " cghs-tab--on" : ""}`}
                onClick={() => state.view !== view && changeView(view)}
              >
                {VIEW_LABEL[view]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="flow-btn flow-btn-primary flow-btn-mini reg-export"
            disabled={!!problem || exporting.isPending || !total}
            onClick={download}
          >
            <Download size={13} aria-hidden="true" />
            {exporting.isPending ? "Preparing…" : "Export Excel"}
          </button>
        </div>

        <div className="audit-filters" role="search" aria-label="Billing audit filters">
          <RangeBar state={state} today={today} onRange={(patch) => update(patch)} />
          <div className="reg-bar audit-searchbar">
            <label className="cghs-sr" htmlFor={searchId}>
              Search
            </label>
            <input
              id={searchId}
              type="search"
              className="jb-assign dues-search"
              value={q}
              maxLength={AUDIT_SEARCH_MAX}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search patient name, UHID, Health ID, phone or bill no"
            />
            {state.view === "bills" ? (
              <>
                <label className="cghs-sr" htmlFor={billNoId}>
                  Bill number
                </label>
                <input
                  id={billNoId}
                  type="search"
                  className="jb-assign audit-billno"
                  value={billNo}
                  maxLength={60}
                  onChange={(e) => setBillNo(e.target.value)}
                  placeholder="Bill number (e.g. GH26-001280)"
                />
              </>
            ) : null}
            <div className="audit-select audit-status">
              <Dropdown
                value={state.filters.status}
                options={[{ value: "", label: "All statuses" }, ...AUDIT_STATUSES]}
                onChange={(status) => update({ filters: { ...state.filters, status } })}
                ariaLabel="Bill status"
              />
            </div>
            <MoreFilters
              view={state.view}
              filters={state.filters}
              options={data?.options}
              onChange={(filters) => update({ filters })}
            />
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              disabled={pristine}
              onClick={clearAll}
            >
              <RotateCcw size={13} aria-hidden="true" /> Reset
            </button>
          </div>
          {problem ? (
            <p className="audit-error" role="alert">
              {problem}
            </p>
          ) : null}
        </div>

        {problem ? null : report.isLoading ? (
          <Shimmer type="table" count={6} />
        ) : report.isError ? (
          <div className="audit-state" role="alert">
            <p>{requestErrorOf(report.error, "Could not load the billing audit report")}</p>
            <button
              type="button"
              className="flow-btn flow-btn-ghost flow-btn-mini"
              onClick={() => report.refetch()}
            >
              <RotateCcw size={13} aria-hidden="true" /> Try again
            </button>
          </div>
        ) : (
          <>
            <Totals view={state.view} totals={data.totals} />
            <ModeCollections view={state.view} modes={data.totals.modes ?? []} />
            {state.view === "items" ? (
              <GroupTotals groups={data.totals.groups ?? []} totals={data.totals} />
            ) : null}
            {state.view === "bills" ? (
              <RefundsByMode
                modes={data.totals.modes ?? []}
                creditNotes={data.totals.credit_notes}
              />
            ) : null}
            {!rows.length ? (
              <div className="audit-state">
                <p>
                  <strong>
                    No {state.view === "bills" ? "bills" : "bill items"} match these filters
                  </strong>
                </p>
                <p className="flow-muted">Try a wider date range or clear the filters.</p>
                <button
                  type="button"
                  className="flow-btn flow-btn-ghost flow-btn-mini"
                  onClick={clearAll}
                >
                  Clear filters
                </button>
              </div>
            ) : (
              <>
                <div
                  className="fset__scroll fset__scroll--wide audit-scroll"
                  aria-busy={report.isFetching}
                >
                  {state.view === "bills" ? (
                    <BillsTable rows={rows} first={(state.page - 1) * state.page_size + 1} />
                  ) : (
                    <ItemsTable rows={rows} />
                  )}
                </div>
                <Pagination
                  page={data.page}
                  pageSize={data.page_size}
                  total={total}
                  onChange={(page) => update({ page }, { keepPage: true })}
                  onPageSizeChange={(page_size) => update({ page_size })}
                  pageSizeOptions={AUDIT_PAGE_SIZES}
                  disabled={report.isFetching}
                  unit={state.view === "bills" ? "bills" : "items"}
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
