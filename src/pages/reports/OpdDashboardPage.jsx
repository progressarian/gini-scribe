import { useMemo } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { RefreshCw, X } from "lucide-react";
import Shimmer from "../../components/Shimmer";
import { errorOf } from "../../components/billing/format";
import { Choice, DateField } from "../../components/billing/ReportFields";
import { rangeLabel } from "../../components/billing/dashboard/dashboardText";
import { istToday } from "../../components/crm/progress/progressText";
import OpdTiles from "../../components/reports/opd/OpdTiles";
import VisitTrend from "../../components/reports/opd/VisitTrend";
import TypeMix from "../../components/reports/opd/TypeMix";
import ConsultantBars from "../../components/reports/opd/ConsultantBars";
import StatusFunnel from "../../components/reports/opd/StatusFunnel";
import ConsultantPicker from "../../components/reports/opd/ConsultantPicker";
import {
  apiParams,
  OPD_PRESETS,
  rangeProblem,
  readFilters,
} from "../../components/reports/opd/opdFilters";
import TimeOnFloor from "../../components/reports/opd/TimeOnFloor";
import BookedHeatmap from "../../components/reports/opd/BookedHeatmap";
import {
  useOpdDashboard,
  useOpdDoctorOptions,
  useOpdTimes,
} from "../../queries/hooks/useOpdSummary";
import { useReceptionHealthray } from "../../queries/hooks/useGiniflowReception";
import useAuthStore from "../../stores/authStore";
import { CAPABILITIES, hasAnyCapability } from "../../../shared/permissions";
import { OPD_DEFINITIONS } from "../../../shared/opdMetrics.js";
import { OPD_TYPE_OPTIONS } from "../../../shared/opdSummary.js";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "../billing/billingReports.css";
import "../billing/billingDashboard.css";
import "./opdDashboard.css";

const GROUPS = [
  { value: "", label: "Auto" },
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});

function Freshness({ enabled }) {
  const sync = useReceptionHealthray({ enabled });
  const at = sync.data?.lastSyncedAt;
  if (!enabled || !at) return null;
  return <span className="bdash-asof">HealthRay synced {IST_TIME.format(new Date(at))}</span>;
}

export default function OpdDashboardPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const today = istToday();
  const filters = useMemo(() => readFilters(params, today), [params, today]);
  const problem = rangeProblem(filters, today);
  const currentDoctor = useAuthStore((state) => state.currentDoctor);
  const sent = useMemo(() => apiParams(filters), [filters]);
  const result = useOpdDashboard(sent, { enabled: !problem, live: filters.to === today });
  const times = useOpdTimes(sent, { enabled: !problem, live: filters.to === today });
  const doctorOptions = useOpdDoctorOptions(filters, { enabled: !problem });
  const data = problem ? null : result.data;

  const update = (patch) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          next.delete(key);
          for (const item of [value].flat()) if (item) next.append(key, item);
        }
        return next;
      },
      { replace: true },
    );
  const pick = (preset) =>
    update(
      preset.range
        ? { range: preset.key, from: "", to: "" }
        : { range: preset.key, from: filters.from, to: filters.to },
    );
  const isFiltered = filters.doctors.length > 0 || filters.type !== "opd";
  const isChanged = ["range", "from", "to", "group", "doctor", "type"].some((key) =>
    params.has(key),
  );
  const clearFilters = () => update({ doctor: [], type: "" });
  const typeLabel = OPD_TYPE_OPTIONS.find((o) => o.value === filters.type)?.label;
  const back = location.search;
  const refreshing = result.isFetching || times.isFetching;
  const updatedAt = result.isFetching ? null : result.dataUpdatedAt;

  return (
    <div className="flow-root fset bill-ui bdash-page opd-dash">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">OPD dashboard</h1>
          <div className="bdash-actions">
            <Freshness
              enabled={hasAnyCapability(currentDoctor, CAPABILITIES.GINIFLOW_STATION_RECEPTION)}
            />
            {hasAnyCapability(currentDoctor, CAPABILITIES.RECEPTION_OPS) ? (
              <Link className="flow-btn flow-btn-mini flow-btn-ghost" to="/opd?tab=dashboard">
                Today&apos;s clinical view
              </Link>
            ) : null}
            <button
              type="button"
              className="flow-btn flow-btn-mini flow-btn-ghost"
              onClick={() => {
                result.refresh();
                times.refresh();
              }}
              disabled={refreshing || Boolean(problem)}
            >
              <RefreshCw size={13} aria-hidden="true" /> {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <div className="fset__cardsub">{OPD_DEFINITIONS.page}</div>
        <div className="bill-form brep-filters" role="search" aria-label="OPD dashboard filters">
          <div className="bdash-field-seg">
            <span id="opd-dates">Dates</span>
            <div className="bdash-seg" role="group" aria-labelledby="opd-dates">
              {OPD_PRESETS.map((preset) => (
                <button
                  key={preset.key}
                  type="button"
                  className={`flow-btn flow-btn-mini ${filters.range === preset.key ? "flow-btn-primary" : "flow-btn-ghost"}`}
                  aria-pressed={filters.range === preset.key}
                  onClick={() => pick(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
          {filters.range === "custom" ? (
            <>
              <DateField label="From" value={filters.from} onChange={(from) => update({ from })} />
              <DateField label="To" value={filters.to} onChange={(to) => update({ to })} />
            </>
          ) : null}
          <div className="bdash-field-seg">
            <span id="opd-group">Group by</span>
            <div className="bdash-seg" role="group" aria-labelledby="opd-group">
              {GROUPS.map((group) => (
                <button
                  key={group.label}
                  type="button"
                  className={`flow-btn flow-btn-mini ${filters.group === group.value ? "flow-btn-primary" : "flow-btn-ghost"}`}
                  aria-pressed={filters.group === group.value}
                  onClick={() => update({ group: group.value })}
                >
                  {group.label}
                </button>
              ))}
            </div>
          </div>
          <ConsultantPicker
            key={filters.doctors.join("|")}
            options={doctorOptions.data?.doctors ?? []}
            selected={filters.doctors}
            onChange={(doctor) => update({ doctor })}
          />
          <Choice
            label="Patient type"
            value={filters.type === "opd" ? "" : filters.type}
            onChange={(type) => update({ type })}
            anyLabel={OPD_TYPE_OPTIONS.find((o) => o.value === "opd")?.label}
            options={OPD_TYPE_OPTIONS.filter((o) => o.value !== "opd")}
          />
          {isChanged ? (
            <div className="brep-quick">
              <button
                type="button"
                className="flow-btn flow-btn-mini flow-btn-ghost"
                onClick={() => setParams(new URLSearchParams(), { replace: true })}
              >
                Reset
              </button>
            </div>
          ) : null}
        </div>
        {!problem ? (
          <p className="sd-showing" role="status">
            Showing <strong>{rangeLabel(filters.from, filters.to)}</strong>
            {updatedAt ? ` · Updated ${IST_TIME.format(new Date(updatedAt))}` : ""}
          </p>
        ) : null}
        {isFiltered ? (
          <ul className="opd-chips" aria-label="Applied filters">
            {filters.doctors.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="opd-chip"
                  aria-label={`Remove ${name}`}
                  onClick={() => update({ doctor: filters.doctors.filter((d) => d !== name) })}
                >
                  {name} <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
            {filters.type !== "opd" ? (
              <li>
                <button
                  type="button"
                  className="opd-chip"
                  aria-label={`Remove ${typeLabel}`}
                  onClick={() => update({ type: "" })}
                >
                  {typeLabel} <X size={12} aria-hidden="true" />
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        {problem ? (
          <div className="brep-error" role="alert">
            {problem}
          </div>
        ) : null}
      </div>

      {result.isError && !problem ? (
        <div className="flow-card brep-error" role="alert">
          {errorOf(result.error, "Could not load the OPD dashboard")}
          <button type="button" className="flow-btn flow-btn-mini" onClick={() => result.refetch()}>
            Try again
          </button>
        </div>
      ) : null}
      {!data && !result.isError && !problem ? <Shimmer type="stats" count={4} /> : null}

      {data && !data.totals.booked ? (
        <div className="flow-card bdash-empty">
          <p>
            {isFiltered
              ? `No appointments match these filters over ${rangeLabel(data.from, data.to)}.`
              : `No appointments for ${rangeLabel(data.from, data.to)}.`}
          </p>
          {isFiltered ? (
            <button type="button" className="flow-btn flow-btn-mini" onClick={clearFilters}>
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}
      {data && data.totals.booked ? (
        <>
          <OpdTiles data={data} times={times.data} filters={filters} back={back} />
          <VisitTrend data={data} filters={filters} back={back} />
          <div className="bdash-grid">
            <TypeMix data={data} filters={filters} back={back} />
            <StatusFunnel data={data} filters={filters} back={back} />
          </div>
          <ConsultantBars data={data} filters={filters} back={back} />
          <TimeOnFloor
            result={times}
            canOpenFlowReports={hasAnyCapability(currentDoctor, CAPABILITIES.GINIFLOW_REPORTS)}
          />
          <BookedHeatmap data={data} filters={filters} back={back} />
        </>
      ) : null}
    </div>
  );
}
