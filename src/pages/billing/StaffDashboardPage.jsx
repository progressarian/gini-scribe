import { useMemo } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { Download, RefreshCw } from "lucide-react";
import Shimmer from "../../components/Shimmer";
import { useBillingReportCatalog } from "../../queries/hooks/useBillingReports";
import { useStaffDashboard, useStaffDashboardExport } from "../../queries/hooks/useStaffDashboard";
import { saveBlob } from "../../components/billing/importText";
import { toast } from "../../stores/uiStore";
import { errorOf } from "../../components/billing/format";
import { dayMs, DAY_MS, RANGES } from "../../components/billing/reportRanges";
import { Choice, DateField } from "../../components/billing/ReportFields";
import StaffTiles from "../../components/billing/staff/StaffTiles";
import StaffTable from "../../components/billing/staff/StaffTable";
import ShiftsTable from "../../components/billing/staff/ShiftsTable";
import StaffExceptions from "../../components/billing/staff/StaffExceptions";
import HoursChart from "../../components/billing/staff/HoursChart";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "./billing.css";
import "./billingUi.css";
import "./billingReports.css";
import "./billingDashboard.css";

const RANGE_DAYS_MAX = 366;
const weekStart = (day) =>
  new Date(dayMs(day) - ((new Date(dayMs(day)).getUTCDay() + 6) % 7) * DAY_MS)
    .toISOString()
    .slice(0, 10);
const byKey = (key) => RANGES.find((r) => r.key === key);
const PRESETS = [
  byKey("today"),
  byKey("yesterday"),
  { key: "week", label: "This week", range: (today) => ({ from: weekStart(today), to: today }) },
  byKey("month"),
  byKey("last_month"),
  { key: "custom", label: "Custom", range: null },
];

const SHOWN_DAY = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const shownDay = (day) => SHOWN_DAY.format(new Date(`${day}T00:00:00Z`));
const shownRange = ({ from, to }) =>
  from === to ? shownDay(from) : `${shownDay(from)} – ${shownDay(to)}`;
const DEFAULT_PRESET = "today";

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});

function readFilters(params, today) {
  const preset = params.get("range") || (params.get("from") ? "custom" : DEFAULT_PRESET);
  const chosen = PRESETS.find((p) => p.key === preset);
  const dates = chosen?.range && today ? chosen.range(today) : {};
  return {
    range: chosen ? preset : "custom",
    from: params.get("from") || dates.from || "",
    to: params.get("to") || dates.to || "",
    staff: params.get("staff") || "",
  };
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
  if (filters.from > filters.to) return "The start date is after the end date.";
  if (filters.to > today) return "The end date can't be after today.";
  const days = Math.round((dayMs(filters.to) - dayMs(filters.from)) / DAY_MS) + 1;
  if (days > RANGE_DAYS_MAX) return `Choose at most ${RANGE_DAYS_MAX} days at a time.`;
  return null;
}

export default function StaffDashboardPage() {
  const catalog = useBillingReportCatalog();
  const [params, setParams] = useSearchParams();
  const today = catalog.data?.today;
  const filters = useMemo(() => readFilters(params, today), [params, today]);
  const problem = today ? rangeProblem(filters, today) : null;
  const sent = useMemo(
    () => ({ from: filters.from, to: filters.to, staff: filters.staff }),
    [filters],
  );
  const result = useStaffDashboard(sent, { enabled: Boolean(today) && !problem });
  const location = useLocation();
  const oldShiftLink = params.get("shift");
  const download = useStaffDashboardExport();
  const downloadNow = () =>
    download.mutate(sent, {
      onSuccess: (file) => {
        saveBlob(file);
        toast(`Downloaded ${file.fileName}`, "success");
      },
      onError: (e) => toast(errorOf(e, "Could not download the staff report"), "error"),
    });

  const setParam = (patch) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });

  const update = (patch) => {
    const merged = { ...filters, ...patch };
    setParam({ range: merged.range, from: merged.from, to: merged.to, staff: merged.staff });
  };

  if (oldShiftLink) return <Navigate to={`/billing/staff/shifts/${oldShiftLink}`} replace />;

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
          {errorOf(catalog.error, "Could not load the staff dashboard")}
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

  const users = catalog.data.options.users ?? [];
  const data = result.data;
  const cleared = !["range", "from", "to", "staff"].some((key) => params.get(key));
  const staffName = filters.staff
    ? (users.find((u) => String(u.id) === filters.staff)?.name ?? "one person")
    : null;
  return (
    <div className="flow-root fset bill-ui bdash-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">Staff &amp; shifts</h1>
          <div className="bdash-actions">
            {data ? (
              <span className="bdash-asof" role="status">
                {result.isFetching ? "Updating…" : `As of ${IST_TIME.format(new Date())}`}
              </span>
            ) : null}
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-ghost"
              onClick={() => result.refetch()}
              disabled={!data || result.isFetching || Boolean(problem)}
            >
              <RefreshCw size={13} aria-hidden="true" /> Refresh
            </button>
            <button
              type="button"
              className="flow-btn flow-btn-primary brep-export"
              onClick={downloadNow}
              disabled={!data || download.isPending || Boolean(problem)}
            >
              <Download size={14} aria-hidden="true" />
              {download.isPending ? "Preparing…" : "Download Excel"}
            </button>
          </div>
        </div>
        <div className="fset__cardsub">
          What each person at the billing counter collected, by payment mode, and every shift&apos;s
          cash handover. Money counts on the day it was taken.
        </div>
        <div className="bill-form brep-filters" role="search" aria-label="Staff dashboard filters">
          <div className="bdash-field-seg">
            <span id="sd-dates">Dates</span>
            <div className="bdash-seg" role="group" aria-labelledby="sd-dates">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`flow-btn flow-btn-mini ${filters.range === p.key ? "flow-btn-primary" : "flow-btn-ghost"}`}
                  aria-pressed={filters.range === p.key}
                  onClick={() => update({ range: p.key, ...(p.range ? p.range(today) : {}) })}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {filters.range === "custom" ? (
            <>
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
            </>
          ) : null}
          <Choice
            label="Staff"
            value={filters.staff}
            onChange={(staff) => update({ staff })}
            anyLabel="All staff"
            options={users.map((u) => ({ value: String(u.id), label: u.name }))}
          />
          {!cleared ? (
            <div className="brep-quick">
              <button
                type="button"
                className="flow-btn flow-btn-mini flow-btn-ghost"
                onClick={() => setParams(new URLSearchParams())}
              >
                Reset to today
              </button>
            </div>
          ) : null}
        </div>
        {data && !problem ? (
          <p className="sd-showing" role="status">
            Showing <strong>{shownRange(data.filters)}</strong> ·{" "}
            <strong>{staffName ?? "all staff"}</strong>
          </p>
        ) : null}
        {problem ? (
          <div className="brep-error" role="alert">
            {problem}
          </div>
        ) : null}
      </div>

      {result.isError ? (
        <div className="flow-card brep-error" role="alert">
          {errorOf(result.error, "Could not load the staff dashboard")}
          <button type="button" className="flow-btn flow-btn-mini" onClick={() => result.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {!data && !result.isError && !problem ? <Shimmer type="stats" count={4} /> : null}

      {data ? (
        <>
          <StaffTiles data={data} />
          <StaffTable
            data={data}
            picked={filters.staff ? Number(filters.staff) : null}
            onPick={(id) => update({ staff: String(id) })}
          />
          <ShiftsTable data={data} back={location.search} />
          <StaffExceptions data={data} back={location.search} />
          <HoursChart hours={data.hours} />
        </>
      ) : null}
    </div>
  );
}
