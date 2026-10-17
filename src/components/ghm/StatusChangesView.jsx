import { Fragment, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronRight, Download, History } from "lucide-react";
import DatePicker from "../DatePicker.jsx";
import Dropdown from "../ui/Dropdown.jsx";
import SearchBox from "../ui/SearchBox.jsx";
import Pagination, { DEFAULT_PAGE_SIZES } from "../ui/Pagination";
import { useExportStatusChanges, useGhmStatusChanges } from "../../queries/hooks/useGhm";
import { exportStatusChangesWorkbook } from "../../lib/ghmWatiExport";
import { STATUS_CHANGE_KINDS, changeKindLabel } from "../../../shared/statusChanges.js";
import { toast } from "../../stores/uiStore";

const MAX_DAYS = 90;
const COLS = 9;

const istToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
const shiftDay = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const prettyDate = (s) =>
  s
    ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";
const changedAt = (ts) =>
  new Date(ts).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });

const kindMeta = (v) => STATUS_CHANGE_KINDS.find((k) => k.value === v) || {};

const QUICK_RANGES = [
  { id: "today", label: "Today", range: (t) => ({ from: t, to: t }) },
  {
    id: "yesterday",
    label: "Yesterday",
    range: (t) => ({ from: shiftDay(t, -1), to: shiftDay(t, -1) }),
  },
  { id: "week", label: "Last 7 days", range: (t) => ({ from: shiftDay(t, -6), to: t }) },
];

export default function StatusChangesView({ doctors = [], renderHistory }) {
  const today = istToday();
  const [searchParams, setSearchParams] = useSearchParams();
  const [from, setFrom] = useState(searchParams.get("cfrom") || today);
  const [to, setTo] = useState(searchParams.get("cto") || today);
  const [kind, setKind] = useState(searchParams.get("ckind") || "");
  const [doctor, setDoctor] = useState(searchParams.get("cdoctor") || "");
  const [by, setBy] = useState(searchParams.get("cby") || "");
  const [search, setSearch] = useState(searchParams.get("cq") || "");
  const [q, setQ] = useState(search.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZES[2]);
  const [open, setOpen] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => setPage(1), [from, to, kind, doctor, by, q, pageSize]);

  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const put = (k, v, def = "") => (v && v !== def ? next.set(k, v) : next.delete(k));
        put("cfrom", from, today);
        put("cto", to, today);
        put("ckind", kind);
        put("cdoctor", doctor);
        put("cby", by);
        put("cq", q);
        return next;
      },
      { replace: true },
    );
  }, [from, to, kind, doctor, by, q, today, setSearchParams]);

  const filters = { from, to, q, doctor, by };
  const listQuery = useGhmStatusChanges({ ...filters, kind, page, limit: pageSize });
  const exportMutation = useExportStatusChanges();
  const data = listQuery.data;
  const rows = data?.data || [];
  const total = data?.total || 0;
  const summary = data?.summary || {};
  const actors = data?.actors || [];
  const range = data?.range || { from, to };

  const runExport = async () => {
    try {
      const out = await exportMutation.mutateAsync({ ...filters, kind });
      const kinds = kind ? STATUS_CHANGE_KINDS.filter((k) => k.value === kind) : undefined;
      const counts = await exportStatusChangesWorkbook(out?.data || [], out?.range || range, kinds);
      if (!counts.total) toast("No patients with a phone number to export.", "warn");
    } catch (e) {
      console.error("[GHM status changes export] failed", e);
      toast(`Export failed: ${e?.response?.data?.error || e?.message || e}`, "error");
    }
  };

  const rangeLabel =
    range.from === range.to
      ? prettyDate(range.from)
      : `${prettyDate(range.from)} – ${prettyDate(range.to)}`;
  const filtered = !!(q || doctor || by || kind);
  const clearFilters = () => {
    setSearch("");
    setQ("");
    setDoctor("");
    setBy("");
    setKind("");
  };

  return (
    <div className="chg-view">
      <div className="miss-range" role="group" aria-label="Status changes filters">
        <div className="miss-range__fld">
          <span>Changed from</span>
          <DatePicker
            value={from}
            onChange={(v) => setFrom(v || today)}
            minDate={shiftDay(to, -(MAX_DAYS - 1))}
            maxDate={to}
            clearable={false}
          />
        </div>
        <div className="miss-range__fld">
          <span>to</span>
          <DatePicker
            value={to}
            onChange={(v) => setTo(v || today)}
            minDate={from}
            maxDate={today}
            clearable={false}
          />
        </div>
        <div className="miss-range__quick">
          {QUICK_RANGES.map((r) => {
            const target = r.range(today);
            const on = from === target.from && to === target.to;
            return (
              <button
                key={r.id}
                type="button"
                className={`btn btn--ghost ${on ? "btn--on" : ""}`}
                aria-pressed={on}
                onClick={() => {
                  setFrom(target.from);
                  setTo(target.to);
                }}
              >
                {r.label}
              </button>
            );
          })}
        </div>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search by patient name, UHID or phone"
        />
        <Dropdown
          value={doctor}
          options={[
            { value: "", label: "All doctors" },
            ...doctors.map((d) => ({ value: d, label: d })),
          ]}
          onChange={setDoctor}
          ariaLabel="Doctor"
        />
        <Dropdown
          value={by}
          options={[
            { value: "", label: "Changed by anyone" },
            ...[...new Set([...actors, by].filter(Boolean))].map((a) => ({ value: a, label: a })),
          ]}
          onChange={setBy}
          ariaLabel="Changed by"
        />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={runExport}
          disabled={exportMutation.isPending || total === 0}
          title={
            total === 0
              ? "Nothing to export for these filters"
              : kind
                ? `Download the ${changeKindLabel(kind)} changes as Excel`
                : "Download all changes as Excel — one sheet per kind"
          }
        >
          <Download size={14} aria-hidden="true" />
          <span className="ghm__btn-label">
            {exportMutation.isPending ? "Exporting…" : "Export Excel"}
          </span>
        </button>
        <span className="miss-range__hint">
          Booking changes made by the team on these days, up to {MAX_DAYS} days back.
        </span>
      </div>

      <div className="summary">
        <div className="summary__group">
          <div className="summary__label">Changes</div>
          <div className="summary__pills">
            {[{ value: "", label: "All", color: "", key: "all" }, ...STATUS_CHANGE_KINDS].map(
              (k) => {
                const active = kind === k.value;
                return (
                  <button
                    key={k.value || "all"}
                    type="button"
                    className={`spill${k.color ? ` spill--${k.color}` : ""} spill--btn${active ? " is-on" : ""}`}
                    aria-pressed={active}
                    onClick={() => setKind(active ? "" : k.value)}
                  >
                    {summary[k.key || k.value] || 0} {k.label}
                  </button>
                );
              },
            )}
          </div>
        </div>
      </div>

      {listQuery.isPending ? (
        <div className="ghm__loading">
          <div className="spinner" />
          Loading…
        </div>
      ) : listQuery.isError ? (
        <div className="ghm__empty">
          <div className="ghm__empty-title">Could not load the changes</div>
          <div className="ghm__empty-sub">
            Please try again. If it keeps failing, contact an administrator.
          </div>
          <button type="button" className="btn btn--ghost" onClick={() => listQuery.refetch()}>
            Try again
          </button>
        </div>
      ) : total === 0 ? (
        <div className="ghm__empty">
          <div className="ghm__empty-icon">
            <History size={34} aria-hidden="true" />
          </div>
          <div className="ghm__empty-title">No booking changes on {rangeLabel}</div>
          <div className="ghm__empty-sub">
            {filtered
              ? "No changes match these filters."
              : "Nobody was booked, cancelled, rescheduled or marked Not Connected."}
          </div>
          {filtered && (
            <button type="button" className="btn btn--ghost" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl chg-tbl">
            <thead>
              <tr>
                <th style={{ width: 96 }}>History</th>
                <th className="tc" style={{ width: 44 }}>
                  #
                </th>
                <th style={{ width: 130 }}>Changed at</th>
                <th className="tl chg-tbl__pt" style={{ minWidth: 200 }}>
                  Patient
                </th>
                <th style={{ width: 170 }}>Change</th>
                <th style={{ width: 190 }}>Booked for</th>
                <th style={{ width: 120 }}>Was</th>
                <th style={{ width: 190 }}>Doctor</th>
                <th style={{ width: 130 }}>Changed by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const meta = kindMeta(r.kind);
                const isOpen = open === `${r.id}:${r.change_day}`;
                return (
                  <Fragment key={`${r.id}:${r.change_day}`}>
                    <tr className={`tbl__row${isOpen ? " tbl__row--open" : ""}`}>
                      <td className="tc">
                        <button
                          type="button"
                          className={`chev ${isOpen ? "chev--open" : ""}`}
                          aria-expanded={isOpen}
                          aria-label={isOpen ? "Hide change history" : "Show change history"}
                          title={isOpen ? "Hide change history" : "Show change history"}
                          onClick={() => setOpen(isOpen ? null : `${r.id}:${r.change_day}`)}
                        >
                          <ChevronRight size={16} aria-hidden="true" />
                          <span className="chev__txt">History</span>
                        </button>
                      </td>
                      <td className="tc">
                        <span className="rnum">{(page - 1) * pageSize + i + 1}</span>
                      </td>
                      <td>{changedAt(r.changed_at)}</td>
                      <td className="chg-tbl__pt">
                        <div className="pcell">
                          <span className="pcell__name">{r.patient_name || "—"}</span>
                          {r.phone && (
                            <a className="pcell__ph" href={`tel:${r.phone}`}>
                              {r.phone}
                            </a>
                          )}
                          <span className="pcell__file">{r.file_no || "—"}</span>
                        </div>
                      </td>
                      <td>
                        <span className={`badge badge--${meta.color || "gray"}`}>{meta.label}</span>
                        {r.changes > 1 && (
                          <small
                            className="chg-tbl__note"
                            title="Changes made to this patient on this day — the latest is shown"
                          >
                            {r.changes} changes this day
                          </small>
                        )}
                        {r.since_kind && (
                          <small className="chg-tbl__note chg-tbl__note--since">
                            Since {changeKindLabel(r.since_kind).toLowerCase()} on{" "}
                            {prettyDate(r.since_day)}
                          </small>
                        )}
                      </td>
                      <td>
                        {r.plan_date ? prettyDate(r.plan_date) : "—"}
                        {r.plan_time && <small className="chg-tbl__note">{r.plan_time}</small>}
                      </td>
                      <td>{r.was_date ? prettyDate(r.was_date) : "—"}</td>
                      <td>{r.plan_doctor || r.doctor_name || "—"}</td>
                      <td>{r.changed_by || "—"}</td>
                    </tr>
                    {isOpen && renderHistory?.(r, COLS)}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        onChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={listQuery.isFetching}
        unit="changes"
      />
    </div>
  );
}
