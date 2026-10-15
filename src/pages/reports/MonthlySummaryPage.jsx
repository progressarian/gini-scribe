import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import Shimmer from "../../components/Shimmer.jsx";
import Pagination from "../../components/ui/Pagination.jsx";
import { errorOf } from "../../components/billing/format";
import { saveBlob } from "../../components/billing/importText";
import { toast } from "../../stores/uiStore";
import {
  useOpdFilters,
  useOpdSummary,
  useOpdSummaryExport,
  useOpdVisits,
} from "../../queries/hooks/useOpdSummary";
import {
  OPD_PAGE_SIZES,
  OPD_STATES,
  OPD_STATUS_OPTIONS,
  OPD_TYPE_OPTIONS,
  typeIncludes,
} from "../../../shared/opdSummary.js";
import "../../styles/flow.css";
import "../flow/FlowSettings.css";
import "../SettingsLayout.css";
import "../billing/billing.css";
import "../billing/billingUi.css";
import "../billing/billingReports.css";
import "./MonthlySummaryPage.css";

const IST_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
});
const thisMonth = () => IST_MONTH.format(new Date()).slice(0, 7);

const shiftMonth = (month, by) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

const monthLabel = (month) =>
  new Date(`${month}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

const dayLabel = (ymd, options = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(`${ymd}T00:00:00`).toLocaleDateString("en-IN", options);

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

const DOCTOR_BUCKETS = [
  ["new", "new", "New"],
  ["follow_up", "followUp", "Follow-up"],
  ["other", "other", "Other OPD"],
];

const MONTH_CHOICES = 24;
const VISITS_ID = "ms-visits";
const SEARCH_DELAY_MS = 300;
const DEFAULTS = { type: "opd", status: "came", sort: "date_desc", page: "1", limit: "25" };
const FILTER_KEYS = ["doctor", "type", "status", "day", "q", "sort"];

function useUrlFilters() {
  const [params, setParams] = useSearchParams();
  const pending = useRef(null);
  useEffect(() => {
    pending.current = null;
  }, [params]);
  const read = (key) => params.get(key) || DEFAULTS[key] || "";
  const update = useCallback(
    (patch) => {
      const next = new URLSearchParams(pending.current ?? params);
      for (const [key, value] of Object.entries(patch)) {
        if (value === "" || value == null || value === DEFAULTS[key]) next.delete(key);
        else next.set(key, String(value));
      }
      pending.current = next;
      setParams(next, { replace: true });
    },
    [params, setParams],
  );
  return { read, update, params };
}

function Tile({ value, label, note, tone, onClick, pressed }) {
  const className = `ms-tile${tone ? ` ms-tile--${tone}` : ""}${onClick ? " ms-tile--action" : ""}`;
  const body = (
    <>
      <span className="ms-tile__val">{value}</span>
      <span className="ms-tile__lbl">{label}</span>
      {note ? <span className="ms-tile__note">{note}</span> : null}
    </>
  );
  if (!onClick) return <div className={className}>{body}</div>;
  return (
    <button type="button" className={className} aria-pressed={pressed} onClick={onClick}>
      {body}
    </button>
  );
}

function Tiles({ summary, repeatOn, onRepeat }) {
  const t = summary.totals;
  const prev = summary.previousMonth;
  const diff = t.attended - prev.attended;
  const versus = summary.isCurrentMonth
    ? `${fmt(prev.attended)} in all of ${monthLabel(prev.month)}`
    : `${diff >= 0 ? "+" : "−"}${fmt(Math.abs(diff))} vs ${monthLabel(prev.month)}`;
  return (
    <>
      <section className="ms-tiles" aria-label="Month totals">
        <Tile value={fmt(t.attended)} label="Visits attended" note={versus} tone="main" />
        <Tile
          value={fmt(t.uniquePatients)}
          label="Unique patients"
          note={`Each person counted once · ${fmt(prev.uniquePatients)} last month`}
        />
        <Tile
          value={fmt(t.repeatPatients)}
          label="Came more than once"
          note={`${fmt(t.repeatVisits)} extra visit${t.repeatVisits === 1 ? "" : "s"} · ${repeatOn ? "listed below" : "show list"}`}
          onClick={onRepeat}
          pressed={repeatOn}
        />
        {DOCTOR_BUCKETS.map(([bucket, key, label]) => (
          <Tile
            key={bucket}
            value={fmt(t[key])}
            label={label}
            note={typeIncludes(summary.type, bucket) ? undefined : "not in visits attended"}
            tone={typeIncludes(summary.type, bucket) ? undefined : "side"}
          />
        ))}
        <Tile
          value={fmt(t.tele)}
          label="Tele"
          note={typeIncludes(summary.type, "tele") ? "included above" : "not in visits attended"}
          tone={typeIncludes(summary.type, "tele") ? undefined : "side"}
        />
        <Tile
          value={fmt(t.labOnly)}
          label="Lab-only"
          note={
            typeIncludes(summary.type, "lab_only") ? "included above" : "not in visits attended"
          }
          tone={typeIncludes(summary.type, "lab_only") ? undefined : "side"}
        />
        <Tile value={fmt(t.noShow)} label="No-shows" />
      </section>
      <p className="ms-foot">
        {t.notClosed > 0
          ? `${fmt(t.notClosed)} of the visits attended are not yet marked completed in HealthRay. `
          : ""}
        Cancelled {fmt(t.cancelled)} · Not updated {fmt(t.notUpdated)}
        {summary.isCurrentMonth ? ` · Booked ahead ${fmt(t.booked)}` : ""}
      </p>
    </>
  );
}

const BREAKDOWN_COLUMNS = [
  { key: "attended", label: "Attended" },
  { key: "uniquePatients", label: "Unique" },
  { key: "new", label: "New" },
  { key: "followUp", label: "Follow-up" },
  { key: "tele", label: "Tele" },
  { key: "labOnly", label: "Lab-only" },
  { key: "noShow", label: "No-show" },
];

function Breakdown({ title, firstColumn, rows, rowKey, rowLabel, active, onPick, emptyText }) {
  const titleId = useId();
  return (
    <section className="flow-card ms-breakdown" aria-labelledby={titleId}>
      <div className="fset__cardhead">
        <h2 id={titleId} className="flow-sec-title">
          {title}
        </h2>
        <span className="fset__count">{rows.length}</span>
      </div>
      <div className="fset__cardsub">Pick a row to list its visits below.</div>
      {!rows.length ? (
        <p className="ms-empty">{emptyText}</p>
      ) : (
        <div className="fset__scroll fset__scroll--tall">
          <table className="flow-table brep-table">
            <thead>
              <tr>
                <th scope="col">{firstColumn}</th>
                {BREAKDOWN_COLUMNS.map((c) => (
                  <th key={c.key} scope="col" className="brep-num">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = active === r[rowKey];
                return (
                  <tr key={r[rowKey]} className={on ? "ms-row--on" : undefined}>
                    <th scope="row">
                      <button
                        type="button"
                        className="ms-pick"
                        aria-pressed={on}
                        onClick={() => onPick(on ? "" : r[rowKey])}
                      >
                        {rowLabel(r)}
                      </button>
                    </th>
                    {BREAKDOWN_COLUMNS.map((c) => (
                      <td key={c.key} className="brep-num">
                        {fmt(r[c.key])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const SORTABLE = [
  { key: "date", label: "Date" },
  { key: "patient", label: "Patient" },
  { key: "doctor", label: "Doctor" },
];

function SortHeader({ column, sort, onSort }) {
  const [key, dir] = sort.split("_");
  const on = key === column.key;
  const next = on && dir === "asc" ? "desc" : on ? "asc" : column.key === "date" ? "desc" : "asc";
  return (
    <th scope="col" aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="ms-sort" onClick={() => onSort(`${column.key}_${next}`)}>
        {column.label}
        <span aria-hidden="true">{on ? (dir === "asc" ? " ▲" : " ▼") : ""}</span>
      </button>
    </th>
  );
}

function VisitList({ month, read, update }) {
  const titleId = useId();
  const searchId = useId();
  const statusId = useId();
  const [text, setText] = useState(read("q"));
  const urlQ = read("q");
  useEffect(() => setText(urlQ), [urlQ]);
  useEffect(() => {
    if (text.trim() === urlQ) return undefined;
    const timer = setTimeout(() => update({ q: text.trim(), page: "" }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text, urlQ, update]);

  const filters = {
    month,
    doctor: read("doctor"),
    type: read("type"),
    status: read("status"),
    day: read("day"),
    q: urlQ,
    sort: read("sort"),
    page: read("page"),
    limit: read("limit"),
  };
  const visits = useOpdVisits(filters);
  const data = visits.data;
  const page = Number(filters.page) || 1;
  const limit = Number(filters.limit) || 25;

  return (
    <section id={VISITS_ID} className="flow-card bill-stack" aria-labelledby={titleId}>
      <div className="fset__cardhead">
        <h2 id={titleId} className="flow-sec-title">
          Visits
        </h2>
        {data ? <span className="fset__count">{fmt(data.total)}</span> : null}
        {visits.isFetching && data ? <span className="ms-muted">updating…</span> : null}
      </div>
      <div className="bill-form brep-filters ms-listbar">
        <div className="fset__field ms-search">
          <label htmlFor={searchId}>Search</label>
          <input
            id={searchId}
            type="search"
            className="jb-assign"
            value={text}
            maxLength={100}
            placeholder="Search by patient name, UHID, Health ID or phone"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <div className="fset__field brep-field">
          <label htmlFor={statusId}>Status</label>
          <select
            id={statusId}
            className="jb-assign"
            value={filters.status}
            onChange={(e) => update({ status: e.target.value, page: "" })}
          >
            {OPD_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {filters.day ? (
          <button
            type="button"
            className="flow-btn flow-btn-mini flow-btn-ghost"
            onClick={() => update({ day: "", page: "" })}
          >
            {dayLabel(filters.day)} ✕
          </button>
        ) : null}
      </div>

      {visits.isError ? (
        <div className="ms-state" role="alert">
          <p>{errorOf(visits.error, "Couldn't load the visits.")}</p>
          <button type="button" className="flow-btn" onClick={() => visits.refetch()}>
            Try again
          </button>
        </div>
      ) : !data ? (
        <Shimmer type="table" count={6} />
      ) : !data.total ? (
        <p className="ms-empty">
          No visits match these filters{urlQ ? ` and the search “${urlQ}”` : ""}.
        </p>
      ) : (
        <>
          <div className="fset__scroll fset__scroll--wide">
            <table className="flow-table brep-table ms-visits">
              <thead>
                <tr>
                  <SortHeader
                    column={SORTABLE[0]}
                    sort={filters.sort}
                    onSort={(sort) => update({ sort, page: "" })}
                  />
                  <SortHeader
                    column={SORTABLE[1]}
                    sort={filters.sort}
                    onSort={(sort) => update({ sort, page: "" })}
                  />
                  <SortHeader
                    column={SORTABLE[2]}
                    sort={filters.sort}
                    onSort={(sort) => update({ sort, page: "" })}
                  />
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.data.map((v) => (
                  <tr key={v.id}>
                    <td className="ms-nowrap" data-label="Date">
                      {dayLabel(v.day)}
                      {v.timeSlot ? <span className="ms-muted"> · {v.timeSlot}</span> : null}
                    </td>
                    <td data-label="Patient">
                      <div className="ms-patient">{v.patientName || "—"}</div>
                      <div className="ms-muted">
                        {[v.fileNo, v.healthId && `HID ${v.healthId}`]
                          .filter(Boolean)
                          .join(" · ") || "No UHID"}
                      </div>
                    </td>
                    <td data-label="Doctor">{v.doctor}</td>
                    <td data-label="Type">{v.bucketLabel}</td>
                    <td data-label="Status">
                      <span className={`ms-state-pill ms-state-pill--${v.state}`}>
                        {OPD_STATES[v.state] ?? v.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={page}
            pageSize={limit}
            total={data.total}
            onChange={(next) => update({ page: String(next) })}
            onPageSizeChange={(size) => update({ limit: String(size), page: "" })}
            pageSizeOptions={OPD_PAGE_SIZES}
            disabled={visits.isFetching}
            unit="visits"
          />
        </>
      )}
    </section>
  );
}

export default function MonthlySummaryPage() {
  const { read, update } = useUrlFilters();
  const latest = thisMonth();
  const asked = read("month");
  const month = /^\d{4}-\d{2}$/.test(asked) && asked <= latest ? asked : latest;
  const doctorId = useId();
  const typeId = useId();
  const monthId = useId();

  const summary = useOpdSummary({ month, doctor: read("doctor"), type: read("type") });
  const options = useOpdFilters(month);
  const download = useOpdSummaryExport();

  const months = useMemo(
    () => Array.from({ length: MONTH_CHOICES }, (_, i) => shiftMonth(latest, -i)),
    [latest],
  );
  const pickMonth = (next) => update({ month: next === latest ? "" : next, day: "", page: "" });
  const filtered = FILTER_KEYS.some((key) => read(key) !== (DEFAULTS[key] || ""));
  const reset = () => update(Object.fromEntries([...FILTER_KEYS, "page"].map((key) => [key, ""])));

  const exportFile = () =>
    download.mutate(
      {
        month,
        doctor: read("doctor"),
        type: read("type"),
        status: read("status"),
        day: read("day"),
        q: read("q"),
        sort: read("sort"),
      },
      {
        onSuccess: (file) => {
          saveBlob(file);
          toast(`Downloaded ${file.fileName}`, "success");
        },
        onError: (e) => toast(errorOf(e, "Could not download the summary"), "error"),
      },
    );

  const s = summary.data;
  const doctors = options.data?.doctors ?? [];
  const doctor = read("doctor");

  return (
    <div className="flow-root fset bill-ui brep-page ms-page">
      <div className="flow-card bill-stack">
        <div className="fset__cardhead">
          <h1 className="flow-sec-title">Monthly summary</h1>
          <button
            type="button"
            className="flow-btn flow-btn-primary brep-export"
            onClick={exportFile}
            disabled={!s || download.isPending}
          >
            <Download size={14} aria-hidden="true" />
            {download.isPending ? "Preparing…" : "Download Excel"}
          </button>
        </div>
        <div className="fset__cardsub">
          OPD visits from HealthRay appointments ·{" "}
          {s
            ? s.isCurrentMonth
              ? `1–${Number(s.today.slice(8))} ${monthLabel(month)} (month in progress)`
              : monthLabel(month)
            : monthLabel(month)}
          {summary.isFetching && s ? " · updating…" : ""}
        </div>
        <div className="bill-form brep-filters">
          <div className="fset__field ms-monthfield">
            <label htmlFor={monthId}>Month</label>
            <div className="ms-month">
              <button
                type="button"
                className="flow-btn flow-btn-mini flow-btn-ghost"
                aria-label="Previous month"
                onClick={() => pickMonth(shiftMonth(month, -1))}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <select
                id={monthId}
                className="jb-assign"
                value={month}
                onChange={(e) => pickMonth(e.target.value)}
              >
                {(months.includes(month) ? months : [month, ...months]).map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="flow-btn flow-btn-mini flow-btn-ghost"
                aria-label="Next month"
                disabled={month >= latest}
                onClick={() => pickMonth(shiftMonth(month, 1))}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="fset__field brep-field">
            <label htmlFor={doctorId}>Doctor</label>
            <select
              id={doctorId}
              className="jb-assign"
              value={doctor}
              onChange={(e) => update({ doctor: e.target.value, page: "" })}
            >
              <option value="">All doctors</option>
              {doctor && !doctors.some((d) => d.name === doctor) ? (
                <option value={doctor}>{doctor}</option>
              ) : null}
              {doctors.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div className="fset__field ms-type">
            <label htmlFor={typeId}>Visit type</label>
            <select
              id={typeId}
              className="jb-assign"
              value={read("type")}
              onChange={(e) => update({ type: e.target.value, page: "" })}
            >
              {OPD_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {filtered ? (
            <button type="button" className="flow-btn flow-btn-mini" onClick={reset}>
              Reset filters
            </button>
          ) : null}
        </div>
      </div>

      {summary.isError ? (
        <div className="flow-card ms-state" role="alert">
          <p>{errorOf(summary.error, "Couldn't load the summary.")}</p>
          <p className="ms-muted">
            Please try again. If the problem continues, contact an administrator.
          </p>
          <button type="button" className="flow-btn" onClick={() => summary.refetch()}>
            Try again
          </button>
        </div>
      ) : !s ? (
        <div className="flow-card">
          <Shimmer type="stats" count={4} />
        </div>
      ) : (
        <>
          <div className="flow-card bill-stack">
            <Tiles
              summary={s}
              repeatOn={read("status") === "repeat"}
              onRepeat={() => {
                const on = read("status") === "repeat";
                update({
                  status: on ? "" : "repeat",
                  sort: on ? "" : "patient_asc",
                  day: "",
                  page: "",
                });
                if (!on) document.getElementById(VISITS_ID)?.scrollIntoView({ behavior: "smooth" });
              }}
            />
            {!s.totals.attended && !s.totals.tele && !s.totals.labOnly ? (
              <div className="ms-state">
                <p>No OPD visits in {monthLabel(month)} for these filters.</p>
                {filtered ? (
                  <button type="button" className="flow-btn" onClick={reset}>
                    Reset filters
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="ms-grid">
            <Breakdown
              title="By day"
              firstColumn="Day"
              rows={s.byDay}
              rowKey="day"
              rowLabel={(r) => dayLabel(r.day)}
              active={read("day")}
              onPick={(day) => update({ day, page: "" })}
              emptyText="No visits on any day this month."
            />
            <Breakdown
              title="By doctor"
              firstColumn="Doctor"
              rows={s.byDoctor}
              rowKey="doctor"
              rowLabel={(r) => r.doctor}
              active={doctor}
              onPick={(name) => update({ doctor: name, page: "" })}
              emptyText="No doctor saw patients this month."
            />
          </div>
        </>
      )}

      <VisitList month={month} read={read} update={update} />
    </div>
  );
}
