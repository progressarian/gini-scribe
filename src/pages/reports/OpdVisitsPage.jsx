import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import Shimmer from "../../components/Shimmer";
import Pagination from "../../components/ui/Pagination";
import { errorOf } from "../../components/billing/format";
import {
  dayLabel,
  fullDayLabel,
  rangeLabel,
} from "../../components/billing/dashboard/dashboardText";
import { istToday } from "../../components/crm/progress/progressText";
import {
  knownState,
  OPD_DASHBOARD_PATH,
  rangeProblem,
  stateLabel,
} from "../../components/reports/opd/opdFilters";
import { pickedLabel } from "../../components/reports/opd/ConsultantPicker";
import { useOpdVisits } from "../../queries/hooks/useOpdSummary";
import { OPD_DEFINITIONS, OPD_GROUPS } from "../../../shared/opdMetrics.js";
import { OPD_PAGE_SIZES, OPD_TYPE_OPTIONS, OPD_TYPE_SETS } from "../../../shared/opdSummary.js";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "../billing/billingReports.css";
import "../billing/billingDashboard.css";
import "./opdDashboard.css";

const SEARCH_WAIT_MS = 350;
const WEEKDAYS = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STATE_WORDS = {
  attended: "Completed",
  no_show: "No-show",
  cancelled: "Cancelled",
  booked: "Pending",
  not_updated: "Not updated",
};

const minutes = (value) => (value === null || value === undefined ? "—" : `${value} min`);

const positive = (text, fallback) => {
  const value = Number(text);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};
const within = (text, min, max) => {
  if (text === null || !/^\d{1,2}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
};

function readVisitFilters(params) {
  const group = params.get("group");
  const type = params.get("type");
  const start = params.get("bucket_start");
  return {
    from: params.get("from") || "",
    to: params.get("to") || "",
    state: knownState(params.get("state")),
    type: OPD_TYPE_SETS[type] ? type : "opd",
    doctors: params.getAll("doctor").filter(Boolean),
    group: OPD_GROUPS.includes(group) && start ? group : "",
    bucket_start: OPD_GROUPS.includes(group) && start ? start : "",
    weekday: within(params.get("weekday"), 1, 7),
    hour: within(params.get("hour"), 0, 23),
    q: params.get("q") || "",
    page: positive(params.get("page"), 1),
    limit: OPD_PAGE_SIZES.includes(Number(params.get("limit"))) ? Number(params.get("limit")) : 25,
  };
}

function titleOf(filters, today) {
  const parts = [stateLabel(filters.state)];
  if (filters.group && filters.bucket_start) {
    parts.push(
      filters.group === "day"
        ? dayLabel(filters.bucket_start)
        : `${filters.group} of ${dayLabel(filters.bucket_start)}`,
    );
  } else if (
    filters.from &&
    filters.to &&
    !rangeProblem({ from: filters.from, to: filters.to }, today)
  ) {
    parts.push(rangeLabel(filters.from, filters.to));
  }
  if (filters.weekday) parts.push(WEEKDAYS[filters.weekday]);
  if (filters.hour !== undefined) parts.push(`${String(filters.hour).padStart(2, "0")}:00`);
  if (filters.doctors.length) parts.push(pickedLabel(filters.doctors));
  return parts.join(" · ");
}

const statusOf = (visit, today) =>
  visit.state === "not_closed"
    ? visit.day === today
      ? "In progress"
      : "Not closed in HealthRay"
    : (STATE_WORDS[visit.state] ?? visit.status ?? "—");

export default function OpdVisitsPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const today = istToday();
  const filters = useMemo(() => readVisitFilters(params), [params]);
  const problem = rangeProblem({ from: filters.from, to: filters.to }, today);
  const [term, setTerm] = useState(filters.q);
  const backTo = `${OPD_DASHBOARD_PATH}${location.state?.back ?? ""}`;

  const setParam = (patch) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(patch)) {
          if (value) next.set(key, String(value));
          else next.delete(key);
        }
        return next;
      },
      { replace: true, state: location.state },
    );

  useEffect(() => {
    if (term.trim() === filters.q) return undefined;
    const wait = setTimeout(() => setParam({ q: term.trim(), page: "" }), SEARCH_WAIT_MS);
    return () => clearTimeout(wait);
  }, [term]);

  const sent = useMemo(
    () => ({
      from: filters.from,
      to: filters.to,
      state: filters.state,
      type: filters.type,
      ...(filters.doctors.length ? { doctor: filters.doctors } : {}),
      ...(filters.group ? { group: filters.group, bucket_start: filters.bucket_start } : {}),
      ...(filters.weekday ? { weekday: filters.weekday } : {}),
      ...(filters.hour !== undefined ? { hour: filters.hour } : {}),
      q: filters.q,
      page: filters.page,
      limit: filters.limit,
    }),
    [filters],
  );
  const result = useOpdVisits(sent, { enabled: !problem });
  const data = problem ? null : result.data;

  useEffect(() => {
    if (data && data.total && filters.page > data.totalPages) setParam({ page: data.totalPages });
  }, [data, filters.page]);

  const typeLabel = OPD_TYPE_OPTIONS.find((o) => o.value === filters.type)?.label;
  return (
    <div className="flow-root fset bill-ui bdash-page opd-dash">
      <div className="flow-card bill-stack">
        <Link className="opd-back" to={backTo}>
          <ArrowLeft size={14} aria-hidden="true" /> Back to OPD dashboard
        </Link>
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">{titleOf(filters, today)}</h1>
        </div>
        <div className="fset__cardsub">{typeLabel}</div>
        <div className="fset__field brep-field opd-search">
          <label htmlFor="opd-visit-search">Search</label>
          <input
            id="opd-visit-search"
            type="search"
            className="jb-assign"
            placeholder="Search by patient name, UHID, Health ID or phone"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </div>
        {problem ? (
          <div className="brep-error" role="alert">
            {problem}
          </div>
        ) : null}
        {result.isError && !problem ? (
          <div className="brep-error" role="alert">
            {errorOf(result.error, "Could not load these visits")}
            <button
              type="button"
              className="flow-btn flow-btn-mini"
              onClick={() => result.refetch()}
            >
              Try again
            </button>
          </div>
        ) : null}
        {!data && !result.isError && !problem ? <Shimmer type="table" count={6} /> : null}
        {data && !data.total ? (
          <div className="bdash-empty">
            {filters.q
              ? `No visits match “${filters.q}” in this list.`
              : "No visits match this figure for these dates."}
          </div>
        ) : null}
        {data && data.total ? (
          <>
            <div className="fset__scroll opd-visits">
              <table className="flow-table brep-table" aria-label="Visits">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Slot</th>
                    <th scope="col">Patient</th>
                    <th scope="col">Consultant</th>
                    <th scope="col">Type</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="brep-num" title={OPD_DEFINITIONS.waiting}>
                      Waited
                    </th>
                    <th scope="col" className="brep-num" title={OPD_DEFINITIONS.visit_length}>
                      Visit length
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.data.map((visit) => (
                    <tr key={visit.id}>
                      <td data-label="Date">{fullDayLabel(visit.day)}</td>
                      <td data-label="Slot">{visit.timeSlot || "—"}</td>
                      <td data-label="Patient">
                        {visit.patientId ? (
                          <a
                            href={`/visit?patient=${encodeURIComponent(visit.patientId)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title="Opens this patient in a new tab"
                          >
                            {visit.patientName || "—"}
                          </a>
                        ) : (
                          visit.patientName || "—"
                        )}
                        <div className="bdash-muted">
                          {[visit.healthId, visit.fileNo].filter(Boolean).join(" · ") || "No ID"}
                        </div>
                      </td>
                      <td data-label="Consultant">{visit.doctor}</td>
                      <td data-label="Type">{visit.bucketLabel}</td>
                      <td data-label="Status">{statusOf(visit, today)}</td>
                      <td data-label="Waited" className="brep-num">
                        {minutes(visit.waitingMin)}
                      </td>
                      <td data-label="Visit length" className="brep-num">
                        {minutes(visit.visitMin)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={Math.min(filters.page, data.totalPages)}
              pageSize={filters.limit}
              total={data.total}
              unit="visits"
              pageSizeOptions={OPD_PAGE_SIZES}
              disabled={result.isFetching}
              onChange={(page) => setParam({ page: page > 1 ? page : "" })}
              onPageSizeChange={(limit) => setParam({ limit, page: "" })}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
