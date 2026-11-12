import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { Download } from "lucide-react";
import { DUE_AGES, DUE_SORTS } from "../../../shared/billingVocab";
import { useDuesExport, useDuesRegister } from "../../queries/hooks/useBillingDues";
import { toast } from "../../stores/uiStore";
import { fromPaise, requestErrorOf } from "../../components/billing/format";
import { saveBlob } from "../../components/billing/importText";
import { dueAgeText } from "../../components/billing/counter/lineText";
import { receptionBillHref } from "../../components/billing/counter/billHref";
import FilterPopover from "../../components/billing/FilterPopover";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";
import "./cghsRegister.css";

const NO_FILTERS = {
  q: "",
  from: "",
  to: "",
  age: "",
  category: "",
  sub_category: "",
  min: "",
  max: "",
  pay_later: "",
  sort: "oldest",
};

const billsText = (count) => (count === 1 ? "1 bill" : `${count} bills`);

const counterHref = (row) =>
  receptionBillHref({ ...(row.visit_id ? { visit: row.visit_id } : {}), bill: row.bill_id });

function Filters({ filters, options, onChange }) {
  const id = useId();
  const set = (key) => (e) => {
    const next = { ...filters, [key]: e.target.value };
    if (key === "category") next.sub_category = "";
    onChange(next);
  };
  const subs = (options?.sub_categories ?? []).filter(
    (s) => !filters.category || s.parent === filters.category,
  );
  const field = (key, label, control) => (
    <div className="fset__field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      {control(`${id}-${key}`)}
    </div>
  );
  const select = (key, label, choices, blankLabel = "All") =>
    field(key, label, (htmlId) => (
      <select id={htmlId} className="jb-assign" value={filters[key]} onChange={set(key)}>
        {blankLabel ? <option value="">{blankLabel}</option> : null}
        {choices.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    ));
  const input = (key, label, type, extra = {}) =>
    field(key, label, (htmlId) => (
      <input
        id={htmlId}
        type={type}
        className="jb-assign"
        value={filters[key]}
        onChange={set(key)}
        {...extra}
      />
    ));
  const active = Object.keys(NO_FILTERS).filter(
    (key) => key !== "q" && key !== "sort" && filters[key],
  ).length;
  const cleared = !active && !filters.q && filters.sort === NO_FILTERS.sort;
  return (
    <div className="reg-bar" role="search" aria-label="Dues filters">
      <label className="cghs-sr" htmlFor={`${id}-q`}>
        Search
      </label>
      <input
        id={`${id}-q`}
        type="search"
        className="jb-assign dues-search"
        value={filters.q}
        onChange={set("q")}
        placeholder="Search name, file no, phone or bill no"
        maxLength={100}
      />
      <FilterPopover active={active} cleared={cleared} onClear={() => onChange(NO_FILTERS)}>
        {input("from", "Bill date from", "date")}
        {input("to", "Bill date to", "date")}
        {select(
          "age",
          "Age",
          DUE_AGES.map((a) => ({ value: a.key, label: a.label })),
        )}
        {select("pay_later", "Pay later", [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ])}
        {select("category", "Category", options?.categories ?? [])}
        {select("sub_category", "Sub-category", subs)}
        {input("min", "Due at least (₹)", "number", { min: 0, step: "0.01", inputMode: "decimal" })}
        {input("max", "Due at most (₹)", "number", { min: 0, step: "0.01", inputMode: "decimal" })}
        {select(
          "sort",
          "Sort",
          DUE_SORTS.map((s) => ({ value: s.key, label: s.label })),
          null,
        )}
      </FilterPopover>
    </div>
  );
}

function DuesTable({ rows }) {
  return (
    <table className="flow-table" aria-label="Dues">
      <thead>
        <tr>
          <th>Bill</th>
          <th>Patient</th>
          <th>Category</th>
          <th className="cghs-num">Waiting</th>
          <th className="cghs-num">Patient pays</th>
          <th className="cghs-num">Paid</th>
          <th className="cghs-num">Due</th>
          <th className="bill-items__actions-head">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.bill_id}>
            <td data-label="Bill">
              <strong>{row.bill_no}</strong>
              <div className="flow-muted">
                {row.bill_date}
                {row.pay_later ? " · Pay later" : ""}
              </div>
            </td>
            <td data-label="Patient">
              <strong>{row.patient.name}</strong>
              <div className="flow-muted">
                {row.patient.file_no || "—"}
                {row.patient.phone ? ` · ${row.patient.phone}` : ""}
              </div>
            </td>
            <td data-label="Category">{row.category_label || "—"}</td>
            <td data-label="Waiting" className="cghs-num">
              {dueAgeText(row.days)}
            </td>
            <td data-label="Patient pays" className="cghs-num">
              {fromPaise(Math.max(0, row.payable - row.credited))}
              {row.credited > 0 ? (
                <div className="flow-muted">{fromPaise(row.credited)} credited</div>
              ) : null}
            </td>
            <td data-label="Paid" className="cghs-num">
              {fromPaise(row.paid - row.refunded)}
            </td>
            <td data-label="Due" className="cghs-num">
              <strong>{fromPaise(row.outstanding)}</strong>
            </td>
            <td data-label="" className="bill-items__actions">
              <Link
                className="flow-btn flow-btn-primary flow-btn-mini"
                to={counterHref(row)}
                state={{ duePatient: { name: row.patient.name, fileNo: row.patient.file_no } }}
                aria-label={`Take payment on bill ${row.bill_no}`}
              >
                Take payment
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Pager({ data, onPage }) {
  const first = (data.page - 1) * data.page_size + 1;
  const last = first + data.rows.length - 1;
  return (
    <nav className="bill-import__pager" aria-label="Dues pages">
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        disabled={data.page <= 1}
        onClick={() => onPage(data.page - 1)}
      >
        Previous
      </button>
      <span className="flow-muted">
        Page {data.page} of {data.pages} · bills {data.rows.length ? first : 0}–
        {data.rows.length ? last : 0} of {data.totals.bills}
      </span>
      <button
        type="button"
        className="flow-btn flow-btn-ghost flow-btn-mini"
        disabled={data.page >= data.pages}
        onClick={() => onPage(data.page + 1)}
      >
        Next
      </button>
    </nav>
  );
}

export default function DuesRegisterPage() {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const exporting = useDuesExport();

  useEffect(() => {
    const timer = setTimeout(() => setSearch(filters.q.trim()), 250);
    return () => clearTimeout(timer);
  }, [filters.q]);

  const asked = { ...filters, q: search };
  const register = useDuesRegister({ ...asked, page });
  const data = register.data;
  const rows = data?.rows ?? [];
  const totals = data?.totals ?? { bills: 0, outstanding: 0 };

  const changeFilters = (next) => {
    setFilters(next);
    setPage(1);
  };
  const download = async () => {
    try {
      saveBlob(await exporting.mutateAsync(asked));
    } catch (err) {
      toast(requestErrorOf(err, "Could not export the dues"), "error", 6000);
    }
  };

  return (
    <div className="flow-root fset bill-ui cghs-page reg-compact">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead reg-head">
          <h1 className="flow-sec-title">Dues</h1>
          <Filters filters={filters} options={data?.options} onChange={changeFilters} />
          <p className="cghs-totals reg-total" aria-live="polite" data-testid="dues-total">
            <strong>{billsText(totals.bills)}</strong> ·{" "}
            <strong>{fromPaise(totals.outstanding)}</strong> due
          </p>
          <button
            type="button"
            className="flow-btn flow-btn-primary flow-btn-mini reg-export"
            disabled={exporting.isPending || !totals.bills}
            onClick={download}
          >
            <Download size={13} aria-hidden="true" />
            {exporting.isPending ? "Preparing…" : "Excel"}
          </button>
        </div>
        {register.isLoading ? (
          <div className="fset__cardsub">Loading…</div>
        ) : register.isError ? (
          <div className="fset__cardsub" role="alert">
            {requestErrorOf(register.error, "Could not load the dues")}
          </div>
        ) : !rows.length ? (
          <div className="bill-allclear">No dues match.</div>
        ) : (
          <>
            <div className="fset__scroll fset__scroll--wide">
              <DuesTable rows={rows} />
            </div>
            <Pager data={data} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
