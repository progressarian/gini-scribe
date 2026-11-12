import { useId, useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Download, RefreshCw } from "lucide-react";
import Shimmer from "../../components/Shimmer";
import { useBillingReportCatalog } from "../../queries/hooks/useBillingReports";
import {
  useBillingDashboard,
  useBillingDashboardExport,
  useRefreshBillingDashboard,
} from "../../queries/hooks/useBillingDashboard";
import { saveBlob } from "../../components/billing/importText";
import { errorOf } from "../../components/billing/format";
import { DAY_MS, dayMs, dayText, RANGES } from "../../components/billing/reportRanges";
import { Choice, DateField } from "../../components/billing/ReportFields";
import FilterPopover from "../../components/billing/FilterPopover";
import KpiTiles from "../../components/billing/dashboard/KpiTiles";
import RevenueTrend from "../../components/billing/dashboard/RevenueTrend";
import MisTable from "../../components/billing/dashboard/MisTable";
import { PaymentModes, RevenueMix } from "../../components/billing/dashboard/MixPanel";
import DiscountPanel from "../../components/billing/dashboard/DiscountPanel";
import ChargeDetail from "../../components/billing/dashboard/ChargeDetail";
import PendingDetail from "../../components/billing/dashboard/PendingDetail";
import NotFinalPanel from "../../components/billing/dashboard/NotFinalPanel";
import RevenueBridge from "../../components/billing/dashboard/RevenueBridge";
import {
  PERIOD_LABELS,
  rangeLabel,
  reportHref,
} from "../../components/billing/dashboard/dashboardText";
import { toast } from "../../stores/uiStore";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";
import "./billingDashboard.css";

const DAY_BUCKETS_MAX = 92;
const RANGE_DAYS_MAX = 366;

const weekStart = (day) =>
  dayText(dayMs(day) - ((new Date(dayMs(day)).getUTCDay() + 6) % 7) * DAY_MS);
const back = (day, days) => dayText(dayMs(day) - days * DAY_MS);
const daysIn = (from, to) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1;
const baseRange = (key) => RANGES.find((r) => r.key === key);

const PRESETS = [
  baseRange("today"),
  baseRange("yesterday"),
  {
    key: "week",
    label: "This week",
    range: (today) => ({ from: weekStart(today), to: today }),
  },
  {
    key: "last_week",
    label: "Last week",
    range: (today) => {
      const start = back(weekStart(today), 7);
      return { from: start, to: back(weekStart(today), 1) };
    },
  },
  baseRange("month"),
  baseRange("last_month"),
  baseRange("last_30"),
  {
    key: "last_12_weeks",
    label: "Last 12 weeks",
    range: (today) => ({ from: back(weekStart(today), 77), to: today }),
  },
  {
    key: "last_12_months",
    label: "Last 12 months",
    range: (today) => {
      const year = Number(today.slice(0, 4)) - 1;
      const start = `${year}-${today.slice(5, 7)}-01`;
      const next = dayText(Date.UTC(year, Number(today.slice(5, 7)), 1));
      return { from: daysIn(start, today) > RANGE_DAYS_MAX ? next : start, to: today };
    },
  },
  baseRange("fy"),
  { key: "custom", label: "Custom range", range: null },
];

const DEFAULT_PRESET = "month";
const FILTER_KEYS = ["from", "to", "period", "category", "sub_category", "consultant"];

function readFilters(params, today) {
  const preset = params.get("range") || (params.get("from") ? "custom" : DEFAULT_PRESET);
  const chosen = PRESETS.find((p) => p.key === preset);
  const dates = chosen?.range && today ? chosen.range(today) : {};
  return {
    range: chosen ? preset : "custom",
    from: params.get("from") || dates.from || "",
    to: params.get("to") || dates.to || "",
    period: params.get("period") || "",
    category: params.get("category") || "",
    sub_category: params.get("sub_category") || "",
    consultant: params.get("consultant") || "",
  };
}

const autoPeriod = (days) => (days <= 31 ? "day" : days <= 120 ? "week" : "month");

function Filters({ catalog, filters, update, onClear, cleared }) {
  const options = catalog.options;
  const rangeId = useId();
  const days = filters.from && filters.to ? daysIn(filters.from, filters.to) : 0;
  const parents = options.categories.filter((c) => !c.parent_code);
  const subs = options.categories.filter(
    (c) => c.parent_code && (!filters.category || c.parent_code === filters.category),
  );
  const views = [
    { key: "", label: `Auto (${PERIOD_LABELS[autoPeriod(days)]})` },
    { key: "day", label: "Day", disabled: days > DAY_BUCKETS_MAX },
    { key: "week", label: "Week" },
    { key: "month", label: "Month" },
  ];
  const active = ["category", "sub_category", "consultant"].filter((k) => filters[k]).length;
  return (
    <div className="bdash-filters" role="search" aria-label="Dashboard filters">
      <label className="sr-only" htmlFor={rangeId}>
        Dates
      </label>
      <select
        id={rangeId}
        className="jb-assign bdash-range"
        value={filters.range}
        onChange={(e) => {
          const preset = PRESETS.find((p) => p.key === e.target.value);
          const dates = preset?.range ? preset.range(catalog.today) : {};
          update({ range: e.target.value, ...dates });
        }}
      >
        {PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
      </select>
      <span className="bdash-dates">
        {realDay(filters.from) && realDay(filters.to) ? rangeLabel(filters.from, filters.to) : ""}
      </span>
      <label className="sr-only" htmlFor={`${rangeId}-view`}>
        View by
      </label>
      <select
        id={`${rangeId}-view`}
        className="jb-assign bdash-view"
        value={filters.period}
        onChange={(e) => update({ period: e.target.value })}
      >
        {views.map((view) => (
          <option key={view.key || "auto"} value={view.key} disabled={view.disabled}>
            {view.key ? `By ${view.label.toLowerCase()}` : view.label}
          </option>
        ))}
      </select>
      <FilterPopover active={active} cleared={cleared} onClear={onClear}>
        <DateField
          label="From"
          value={filters.from}
          onChange={(from) => update({ range: "custom", from })}
        />
        <DateField
          label="To"
          value={filters.to}
          onChange={(to) => update({ range: "custom", to })}
        />
        <Choice
          label="Category"
          value={filters.category}
          onChange={(category) => update({ category, sub_category: "" })}
          anyLabel="All categories"
          options={parents.map((c) => ({ value: c.code, label: c.label }))}
        />
        <Choice
          label="Sub-category"
          value={filters.sub_category}
          onChange={(sub_category) => update({ sub_category })}
          anyLabel="All sub-categories"
          options={subs.map((c) => ({ value: c.code, label: c.label }))}
        />
        <Choice
          label="Consultant"
          value={filters.consultant}
          onChange={(consultant) => update({ consultant })}
          anyLabel="All consultants"
          options={options.consultants.map((d) => ({ value: String(d.id), label: d.name }))}
        />
      </FilterPopover>
    </div>
  );
}

const realDay = (text) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
};

function rangeProblem(filters, today) {
  if (!filters.from || !filters.to) return "Choose a start and an end date.";
  if (!realDay(filters.from)) return "Choose a valid start date.";
  if (!realDay(filters.to)) return "Choose a valid end date.";
  if (filters.to > today) return "The end date can't be after today.";
  if (filters.from > filters.to) return "The start date is after the end date.";
  const days = daysIn(filters.from, filters.to);
  if (days > RANGE_DAYS_MAX) return `Choose at most ${RANGE_DAYS_MAX} days at a time.`;
  if (filters.period === "day" && days > DAY_BUCKETS_MAX) {
    return `Day by day covers at most ${DAY_BUCKETS_MAX} days — view by week or month.`;
  }
  return null;
}

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});

const isEmpty = (data) =>
  data.total.bills === 0 && data.total.credit_notes === 0 && data.total.collected === 0;

export default function BillingDashboardPage() {
  const catalog = useBillingReportCatalog();
  const [params, setParams] = useSearchParams();
  const today = catalog.data?.today;
  const filters = useMemo(() => readFilters(params, today), [params, today]);
  const problem = today ? rangeProblem(filters, today) : null;
  const sent = useMemo(
    () => Object.fromEntries(FILTER_KEYS.map((key) => [key, filters[key]])),
    [filters],
  );
  const result = useBillingDashboard(sent, { enabled: Boolean(today) && !problem });
  const refresh = useRefreshBillingDashboard();
  const download = useBillingDashboardExport();

  const update = (patch) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      const merged = { ...filters, ...patch };
      for (const key of ["range", ...FILTER_KEYS]) {
        if (merged[key]) next.set(key, merged[key]);
        else next.delete(key);
      }
      return next;
    });

  const cleared = !["range", ...FILTER_KEYS].some((key) => params.get(key));
  const clear = () => setParams(new URLSearchParams());

  const pick = (row) => update({ range: "custom", from: row.start, to: row.end, period: "day" });

  const pendingOpen = params.get("pending") === "1";
  const togglePending = () =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (pendingOpen) next.delete("pending");
      else next.set("pending", "1");
      return next;
    });
  const openGroup = params.get("group") || "";
  const openSubgroup = params.get("subgroup") || "";
  const openCharges = (group, subgroup = "") =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.set("group", group);
      if (subgroup) next.set("subgroup", subgroup);
      else next.delete("subgroup");
      return next;
    });
  const closeCharges = () =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("group");
      next.delete("subgroup");
      return next;
    });

  const downloadNow = () =>
    download.mutate(
      { filters: sent, resolved: result.data.filters },
      {
        onSuccess: (file) => {
          saveBlob(file);
          toast(`Downloaded ${file.fileName}`, "success");
        },
        onError: (e) => toast(errorOf(e, "Could not download the dashboard"), "error"),
      },
    );

  const refreshNow = () =>
    refresh.mutate(sent, {
      onError: (e) => toast(errorOf(e, "Could not refresh the dashboard"), "error"),
    });

  if (catalog.isLoading) {
    return (
      <div className="flow-root fset bill-ui bdash-page">
        <Shimmer type="stats" count={4} />
      </div>
    );
  }
  if (catalog.isError) {
    return (
      <div className="flow-root fset bill-ui bdash-page">
        <div className="flow-card brep-error" role="alert">
          {errorOf(catalog.error, "Could not load the dashboard")}
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

  const data = result.data;
  return (
    <div className="flow-root fset bill-ui bdash-page">
      <div className="flow-card bdash-head">
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">Billing dashboard</h1>
          <Filters
            catalog={catalog.data}
            filters={filters}
            update={update}
            onClear={clear}
            cleared={cleared}
          />
          <div className="bdash-actions">
            {result.isFetching || refresh.isPending ? (
              <span className="bdash-asof" role="status">
                Updating…
              </span>
            ) : null}
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-ghost"
              onClick={refreshNow}
              disabled={!data || refresh.isPending || Boolean(problem)}
              aria-label="Refresh"
              title={
                data ? `Refresh — as of ${IST_TIME.format(new Date(data.generated_at))}` : "Refresh"
              }
            >
              <RefreshCw size={13} aria-hidden="true" />
            </button>
            <Link
              className="flow-btn flow-btn-mini flow-btn-ghost"
              to={data ? reportHref("revenue_categories", data.filters) : "/billing/reports"}
            >
              Detailed reports
            </Link>
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-primary"
              onClick={downloadNow}
              disabled={!data || download.isPending || Boolean(problem)}
            >
              <Download size={13} aria-hidden="true" />
              {download.isPending ? "Preparing…" : "Excel"}
            </button>
          </div>
        </div>
      </div>

      {problem ? (
        <div className="flow-card brep-error" role="alert">
          {problem}
        </div>
      ) : result.isError ? (
        <div className="flow-card brep-error" role="alert">
          {errorOf(result.error, "Could not load the dashboard")}{" "}
          <button type="button" className="flow-btn flow-btn-mini" onClick={() => result.refetch()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <>
          <Shimmer type="stats" count={4} />
          <Shimmer type="table" count={6} />
        </>
      ) : isEmpty(data) ? (
        <div className="flow-card bdash-empty">
          <strong>No final bills or payments in this range</strong>
          <span>Try a wider date range, or clear the filters.</span>
          {!cleared ? (
            <button type="button" className="flow-btn flow-btn-mini" onClick={clear}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <KpiTiles data={data} pendingOpen={pendingOpen} onTogglePending={togglePending} />
          {pendingOpen ? <PendingDetail filters={sent} onClose={togglePending} /> : null}
          <NotFinalPanel data={data} />
          <RevenueTrend data={data} onPick={pick} />
          <div className="bdash-grid">
            <RevenueBridge data={data} />
            <PaymentModes data={data} />
          </div>
          <MisTable data={data} onPick={pick} onOpenGroup={openCharges} openGroup={openGroup} />
          {openGroup ? (
            <ChargeDetail
              filters={sent}
              period={data.filters.period}
              group={openGroup}
              subgroup={openSubgroup}
              onOpen={openCharges}
              onClose={closeCharges}
            />
          ) : null}
          <RevenueMix data={data} />
          <DiscountPanel data={data} />
        </>
      )}
    </div>
  );
}
