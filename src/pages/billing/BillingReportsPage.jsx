import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download } from "lucide-react";
import {
  useBillingReport,
  useBillingReportCatalog,
  useBillingReportExport,
} from "../../queries/hooks/useBillingReports";
import { errorOf, fromPaise } from "../../components/billing/format";
import { saveBlob } from "../../components/billing/importText";
import { toast } from "../../stores/uiStore";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";

const DAY_MS = 86400000;
const dayText = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (text) => Date.parse(`${text}T00:00:00Z`);

const RANGES = [
  {
    key: "month",
    label: "This month",
    range: (today) => ({ from: `${today.slice(0, 8)}01`, to: today }),
  },
  {
    key: "last_month",
    label: "Last month",
    range: (today) => {
      const end = dayMs(`${today.slice(0, 8)}01`) - DAY_MS;
      return { from: `${dayText(end).slice(0, 8)}01`, to: dayText(end) };
    },
  },
  {
    key: "last_30",
    label: "Last 30 days",
    range: (today) => ({ from: dayText(dayMs(today) - 29 * DAY_MS), to: today }),
  },
  {
    key: "fy",
    label: "This financial year",
    range: (today) => {
      const year = Number(today.slice(0, 4));
      const start = Number(today.slice(5, 7)) >= 4 ? year : year - 1;
      return { from: `${start}-04-01`, to: today };
    },
  },
  { key: "all", label: "All dates", openOnly: true, range: (today) => ({ from: "", to: today }) },
  { key: "custom", label: "Custom range", range: null },
];

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
};

const NUMERIC = new Set(["money", "count", "quantity", "limit", "days", "percent"]);
const TOTALLED = new Set(["money", "count", "quantity"]);

function ReportSection({ part }) {
  const deepest = Math.max(0, ...part.rows.map((row) => row.depth ?? 0));
  const labelKey = part.columns.find((column) => column.kind === "text")?.key;
  const shown = part.columns.filter((column) => column.key !== "level");
  return (
    <section className="flow-card bill-stack brep-section" aria-label={part.title}>
      <div className="fset__cardhead">
        <h2 className="flow-sec-title">{part.title}</h2>
        <span className="fset__count">{part.row_count}</span>
      </div>
      {part.note ? <div className="fset__cardsub">{part.note}</div> : null}
      {part.truncated ? (
        <div className="fset__cardsub">
          Showing the first {part.rows.length} of {part.row_count} rows — the total covers them all.
          Narrow the filters, or download the Excel file for every row.
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
        <div className="bill-allclear">Nothing for these filters.</div>
      )}
    </section>
  );
}

function Choice({ label, value, onChange, options, anyLabel }) {
  const id = useId();
  return (
    <div className="fset__field brep-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        className="jb-assign"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function DateField({ label, value, onChange }) {
  const id = useId();
  return (
    <div className="fset__field brep-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        className="jb-assign"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

const PERIOD_LABELS = { none: "Whole range", day: "Day", week: "Week", month: "Month" };

function FilterBar({ catalog, report, filters, setFilter, rangeKey, pickRange }) {
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
  return (
    <div className="bill-form brep-filters">
      <div className="fset__field brep-field">
        <label htmlFor={rangeId}>Dates</label>
        <select
          id={rangeId}
          className="jb-assign"
          value={rangeKey}
          onChange={(e) => pickRange(e.target.value)}
        >
          {ranges.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <DateField
        label={labels.from}
        value={filters.from}
        onChange={(v) => setFilter("from", v, true)}
      />
      <DateField label={labels.to} value={filters.to} onChange={(v) => setFilter("to", v, true)} />
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

const sentFor = (report, filters) => {
  if (!report) return {};
  const keys = ["from", "to", ...report.filters];
  return Object.fromEntries(keys.map((key) => [key, filters[key] ?? ""]));
};

export default function BillingReportsPage() {
  const catalog = useBillingReportCatalog();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState(EMPTY);
  const [rangeKey, setRangeKey] = useState("month");
  const download = useBillingReportExport();
  const tabsId = useId();

  const reports = catalog.data?.reports ?? [];
  const asked = params.get("report");
  const report = reports.find((r) => r.key === asked) ?? reports[0] ?? null;
  const today = catalog.data?.today;

  useEffect(() => {
    if (!today) return;
    setFilters((f) => (f.to ? f : { ...f, ...RANGES[0].range(today) }));
  }, [today]);

  useEffect(() => {
    if (!report || !today || report.open_start || filters.from) return;
    setRangeKey("month");
    setFilters((f) => ({ ...f, ...RANGES[0].range(today) }));
  }, [report, today, filters.from]);

  const sent = useMemo(() => sentFor(report, filters), [report, filters]);
  const ready = Boolean(report && filters.to);
  const result = useBillingReport(report?.key, sent, { enabled: ready });

  const setFilter = (key, value, dated = false) => {
    if (dated) setRangeKey("custom");
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const pickRange = (key) => {
    setRangeKey(key);
    const range = RANGES.find((r) => r.key === key)?.range;
    if (range && today) setFilters((f) => ({ ...f, ...range(today) }));
  };

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
    return <div className="flow-root fset bill-ui brep-page">Loading…</div>;
  }
  if (catalog.isError) {
    return (
      <div className="flow-root fset bill-ui brep-page">
        <div className="flow-card">{errorOf(catalog.error, "Could not load the reports")}</div>
      </div>
    );
  }

  return (
    <div className="flow-root fset bill-ui brep-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">Billing reports</h1>
          <button
            type="button"
            className="flow-btn flow-btn-primary brep-export"
            onClick={exportFile}
            disabled={!ready || download.isPending}
          >
            <Download size={14} aria-hidden="true" />
            {download.isPending ? "Preparing…" : "Download Excel"}
          </button>
        </div>
        <div className="fset__cardsub">
          Final bills only; credit notes and refunds are taken off. Days are India dates.
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
        {report ? (
          <FilterBar
            catalog={catalog.data}
            report={report}
            filters={filters}
            setFilter={setFilter}
            rangeKey={rangeKey}
            pickRange={pickRange}
          />
        ) : null}
      </div>
      <div
        id={`${tabsId}-panel`}
        role="tabpanel"
        aria-labelledby={report ? `${tabsId}-${report.key}` : undefined}
        className="brep-panel"
      >
        {result.isError ? (
          <div className="flow-card brep-error" role="alert">
            {errorOf(result.error, "Could not load this report")}
          </div>
        ) : !result.data ? (
          <div className="flow-card">Loading…</div>
        ) : (
          result.data.sections.map((part) => <ReportSection key={part.key} part={part} />)
        )}
      </div>
    </div>
  );
}
