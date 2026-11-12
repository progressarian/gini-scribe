import { useId, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import {
  useBillingReport,
  useBillingReportCatalog,
  useBillingReportExport,
} from "../../queries/hooks/useBillingReports";
import { errorOf, fromPaise } from "../../components/billing/format";
import { receptionBillHref } from "../../components/billing/counter/billHref";
import { saveBlob } from "../../components/billing/importText";
import { toast } from "../../stores/uiStore";
import Shimmer from "../../components/Shimmer";
import { DEFAULT_RANGE, RANGES } from "../../components/billing/reportRanges";
import FilterPopover from "../../components/billing/FilterPopover";
import { rangeLabel } from "../../components/billing/dashboard/dashboardText";
import { Choice, DateField } from "../../components/billing/ReportFields";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
});

const CELL = {
  money: (value) => fromPaise(value),
  count: (value) => Number(value ?? 0).toLocaleString("en-IN"),
  quantity: (value) => Number(value ?? 0).toLocaleString("en-IN"),
  limit: (value) => (value === null || value === undefined ? "—" : value.toLocaleString("en-IN")),
  days: (value) => (value === null || value === undefined ? "—" : value),
  percent: (value) => (value === null || value === undefined ? "—" : `${value}%`),
  instant: (value) => (value ? IST_TIME.format(new Date(value)) : ""),
  flag: (value) => (value ? <span className="brep-over">Over</span> : ""),
  date: (value) => value ?? "",
  text: (value) => value ?? "",
  patient: (value) =>
    value ? (
      <Link className="brep-open" to={receptionBillHref({ patient: value })}>
        Open at counter
      </Link>
    ) : (
      ""
    ),
};

const NUMERIC = new Set(["money", "count", "quantity", "limit", "days", "percent"]);
const TOTALLED = new Set(["money", "count", "quantity"]);

function ReportSection({ part, onClear, cleared }) {
  const deepest = Math.max(0, ...part.rows.map((row) => row.depth ?? 0));
  const labelKey = part.columns.find((column) => column.kind === "text")?.key;
  const shown = part.columns.filter((column) => column.key !== "level");
  return (
    <section className="flow-card bill-stack brep-section" aria-label={part.title}>
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">{part.title}</h2>
        <span className="fset__count">{part.row_count}</span>
        {part.note ? (
          <span className="brep-info" title={part.note} role="img" aria-label={part.note}>
            ⓘ
          </span>
        ) : null}
      </div>
      {part.truncated ? (
        <div className="fset__cardsub">
          Showing {part.rows.length} of {part.row_count} rows — download Excel for all.
        </div>
      ) : null}
      {part.rows.length ? (
        <div className="fset__scroll fset__scroll--wide">
          <table className="flow-table brep-table" aria-label={part.title}>
            <thead>
              <tr>
                {shown.map((column) => (
                  <th key={column.key} className={NUMERIC.has(column.kind) ? "brep-num" : ""}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {part.rows.map((row, index) => (
                <tr
                  key={index}
                  className={row.depth && row.depth < deepest ? "brep-subtotal" : undefined}
                >
                  {shown.map((column) => (
                    <td
                      key={column.key}
                      data-label={column.label}
                      className={NUMERIC.has(column.kind) ? "brep-num" : undefined}
                      style={
                        column.key === labelKey && row.depth > 1
                          ? { paddingLeft: `${(row.depth - 1) * 18 + 8}px` }
                          : undefined
                      }
                    >
                      {CELL[column.kind](row[column.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {part.total ? (
              <tfoot>
                <tr className="brep-total">
                  {shown.map((column, index) => (
                    <td
                      key={column.key}
                      data-label={column.label}
                      className={NUMERIC.has(column.kind) ? "brep-num" : undefined}
                    >
                      {index === 0
                        ? "Total"
                        : TOTALLED.has(column.kind)
                          ? CELL[column.kind](part.total[column.key])
                          : ""}
                    </td>
                  ))}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      ) : (
        <div className="bill-allclear">
          Nothing for these filters.{" "}
          {cleared ? null : (
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-ghost"
              onClick={onClear}
            >
              Clear filters
            </button>
          )}
        </div>
      )}
    </section>
  );
}

const PERIOD_LABELS = { none: "Whole range", day: "Day", week: "Week", month: "Month" };

function FilterBar({ catalog, report, filters, setFilter, rangeKey, pickRange, onClear, cleared }) {
  const labels = catalog.filter_labels;
  const allowed = new Set(report.filters);
  const options = catalog.options;
  const parents = options.categories.filter((c) => !c.parent_code);
  const subs = options.categories.filter(
    (c) => c.parent_code && (!filters.category || c.parent_code === filters.category),
  );
  const subgroups = options.subgroups.filter(
    (s) => !filters.group || s.group_code.toLowerCase() === filters.group.toLowerCase(),
  );
  const ranges = RANGES.filter((r) => !r.openOnly || report.open_start);
  const rangeId = useId();
  const active = report.filters.filter((key) => filters[key]).length;
  return (
    <div className="brep-bar" role="search" aria-label="Report filters">
      <label className="sr-only" htmlFor={rangeId}>
        Dates
      </label>
      <select
        id={rangeId}
        className="jb-assign brep-range"
        value={rangeKey}
        onChange={(e) => pickRange(e.target.value)}
      >
        {ranges.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
      <span className="brep-dates">
        {filters.from && filters.to
          ? rangeLabel(filters.from, filters.to)
          : filters.to
            ? `Up to ${rangeLabel(filters.to, filters.to)}`
            : ""}
      </span>
      <FilterPopover active={active} cleared={cleared} onClear={onClear}>
        <DateField
          label={labels.from}
          value={filters.from}
          onChange={(v) => setFilter("from", v, true)}
        />
        <DateField
          label={labels.to}
          value={filters.to}
          onChange={(v) => setFilter("to", v, true)}
        />
        {allowed.has("period") ? (
          <Choice
            label={labels.period}
            value={filters.period === report.period ? "" : filters.period}
            onChange={(v) => setFilter("period", v)}
            anyLabel={PERIOD_LABELS[report.period]}
            options={catalog.periods
              .filter((p) => p !== report.period)
              .map((p) => ({ value: p, label: PERIOD_LABELS[p] ?? p }))}
          />
        ) : null}
        {allowed.has("category") ? (
          <Choice
            label={labels.category}
            value={filters.category}
            onChange={(v) => {
              setFilter("category", v);
              setFilter("sub_category", "");
            }}
            anyLabel="All categories"
            options={parents.map((c) => ({ value: c.code, label: c.label }))}
          />
        ) : null}
        {allowed.has("sub_category") ? (
          <Choice
            label={labels.sub_category}
            value={filters.sub_category}
            onChange={(v) => setFilter("sub_category", v)}
            anyLabel="All sub-categories"
            options={subs.map((c) => ({ value: c.code, label: c.label }))}
          />
        ) : null}
        {allowed.has("group") ? (
          <Choice
            label={labels.group}
            value={filters.group}
            onChange={(v) => {
              setFilter("group", v);
              setFilter("subgroup", "");
            }}
            anyLabel="All groups"
            options={options.groups.map((g) => ({ value: g.code, label: g.name }))}
          />
        ) : null}
        {allowed.has("subgroup") ? (
          <Choice
            label={labels.subgroup}
            value={filters.subgroup}
            onChange={(v) => setFilter("subgroup", v)}
            anyLabel="All subgroups"
            options={subgroups.map((s) => ({ value: s.code, label: s.name }))}
          />
        ) : null}
        {allowed.has("consultant") ? (
          <Choice
            label={labels.consultant}
            value={filters.consultant}
            onChange={(v) => setFilter("consultant", v)}
            anyLabel="All consultants"
            options={options.consultants.map((d) => ({ value: String(d.id), label: d.name }))}
          />
        ) : null}
        {allowed.has("user") ? (
          <Choice
            label={labels.user}
            value={filters.user}
            onChange={(v) => setFilter("user", v)}
            anyLabel="Everyone"
            options={options.users.map((u) => ({ value: String(u.id), label: u.name }))}
          />
        ) : null}
      </FilterPopover>
    </div>
  );
}

const EMPTY = {
  from: "",
  to: "",
  period: "",
  category: "",
  sub_category: "",
  group: "",
  subgroup: "",
  consultant: "",
  user: "",
};

const FILTER_KEYS = Object.keys(EMPTY);
const LINK_KEYS = ["range", ...FILTER_KEYS];

function filtersFrom(params, today, report) {
  const asked = params.get("range");
  const dated = params.has("from") || params.has("to");
  let preset = RANGES.find((r) => r.key === (asked || (dated ? "custom" : DEFAULT_RANGE.key)));
  if (!preset || (preset.openOnly && report && !report.open_start)) preset = DEFAULT_RANGE;
  const filters = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ?? ""]));
  if (!today) return { rangeKey: preset.key, filters };
  if (preset.range)
    return { rangeKey: preset.key, filters: { ...filters, ...preset.range(today) } };
  const fallback = DEFAULT_RANGE.range(today);
  return {
    rangeKey: preset.key,
    filters: {
      ...filters,
      to: filters.to || today,
      from: filters.from || (report?.open_start ? "" : fallback.from),
    },
  };
}

const sentFor = (report, filters) => {
  if (!report) return {};
  const keys = ["from", "to", ...report.filters];
  return Object.fromEntries(keys.map((key) => [key, filters[key] ?? ""]));
};

export default function BillingReportsPage() {
  const catalog = useBillingReportCatalog();
  const [params, setParams] = useSearchParams();
  const download = useBillingReportExport();
  const tabsId = useId();

  const reports = catalog.data?.reports ?? [];
  const asked = params.get("report");
  const report = reports.find((r) => r.key === asked) ?? reports[0] ?? null;
  const today = catalog.data?.today;
  const { rangeKey, filters } = useMemo(
    () => filtersFrom(params, today, report),
    [params, today, report],
  );

  const sent = useMemo(() => sentFor(report, filters), [report, filters]);
  const ready = Boolean(report && filters.to);
  const result = useBillingReport(report?.key, sent, { enabled: ready });

  const update = (patch) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, value);
          else next.delete(key);
        }
        return next;
      },
      { replace: true },
    );

  const setFilter = (key, value, dated = false) =>
    update(
      dated
        ? { range: "custom", from: filters.from, to: filters.to, [key]: value }
        : { [key]: value },
    );

  const cleared = !LINK_KEYS.some((key) => params.get(key));
  const clearFilters = () =>
    setParams((current) => {
      const next = new URLSearchParams();
      if (current.get("report")) next.set("report", current.get("report"));
      return next;
    });

  const pickRange = (key) =>
    update(
      key === "custom"
        ? { range: key, from: filters.from, to: filters.to }
        : { range: key, from: "", to: "" },
    );

  const choose = (key) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set("report", key);
      return next;
    });
  };

  const exportFile = () =>
    download.mutate(
      { key: report.key, filters: sent },
      {
        onSuccess: (file) => {
          saveBlob(file);
          toast(`Downloaded ${file.fileName}`, "success");
        },
        onError: (e) => toast(errorOf(e, "Could not download the report"), "error"),
      },
    );

  if (catalog.isLoading) {
    return (
      <div className="flow-root fset bill-ui brep-page">
        <Shimmer type="table" count={6} />
      </div>
    );
  }
  if (catalog.isError) {
    return (
      <div className="flow-root fset bill-ui brep-page">
        <div className="flow-card brep-error" role="alert">
          {errorOf(catalog.error, "Could not load the reports")}{" "}
          <button
            type="button"
            className="flow-btn flow-btn-mini"
            onClick={() => catalog.refetch()}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-root fset bill-ui brep-page">
      <div className="flow-card brep-head">
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">Billing reports</h1>
          {report ? (
            <FilterBar
              catalog={catalog.data}
              report={report}
              filters={filters}
              setFilter={setFilter}
              rangeKey={rangeKey}
              pickRange={pickRange}
              onClear={clearFilters}
              cleared={cleared}
            />
          ) : null}
          <button
            type="button"
            className="flow-btn flow-btn-mini flow-btn-primary brep-export"
            onClick={exportFile}
            disabled={!ready || download.isPending}
          >
            <Download size={13} aria-hidden="true" />
            {download.isPending ? "Preparing…" : "Excel"}
          </button>
        </div>
        <div className="set__tabs brep-tabs" role="tablist" aria-label="Billing reports">
          {reports.map((r) => (
            <button
              key={r.key}
              type="button"
              role="tab"
              id={`${tabsId}-${r.key}`}
              aria-selected={r.key === report?.key}
              aria-controls={`${tabsId}-panel`}
              className={`set__tab brep-tab${r.key === report?.key ? " set__tab--on" : ""}`}
              onClick={() => choose(r.key)}
            >
              {r.title}
            </button>
          ))}
        </div>
      </div>
      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={report ? `${tabsId}-${report.key}` : undefined}
        className="brep-panel"
      >
        {result.isError ? (
          <div className="flow-card brep-error" role="alert">
            {errorOf(result.error, "Could not load this report")}{" "}
            <button
              type="button"
              className="flow-btn flow-btn-mini"
              onClick={() => result.refetch()}
            >
              Try again
            </button>
          </div>
        ) : !result.data ? (
          <Shimmer type="table" count={6} />
        ) : (
          result.data.sections.map((part) => (
            <ReportSection key={part.key} part={part} onClear={clearFilters} cleared={cleared} />
          ))
        )}
      </div>
    </div>
  );
}
