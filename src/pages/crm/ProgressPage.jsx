import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "../../services/api.js";
import { downloadFile } from "../../lib/downloadBlob.js";
import { errorText } from "../../components/crm/import/importText.js";
import ProgressFilters from "../../components/crm/progress/ProgressFilters.jsx";
import ProgressCards from "../../components/crm/progress/ProgressCards.jsx";
import ProgressTrend from "../../components/crm/progress/ProgressTrend.jsx";
import StaffTable from "../../components/crm/progress/StaffTable.jsx";
import Breakdowns from "../../components/crm/progress/Breakdowns.jsx";
import ProgressDoctors from "../../components/crm/progress/ProgressDoctors.jsx";
import { SERIES, rangeText } from "../../components/crm/progress/progressText.js";

const KEYS = ["period", "from", "to", "group", "rep", "territory"];

export default function ProgressPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(
    () => Object.fromEntries(KEYS.map((k) => [k, params.get(k) || ""])),
    [params],
  );
  const query = useMemo(
    () => Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    [filters],
  );
  const key = JSON.stringify(query);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportErr, setExportErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api
      .get("/api/crm/progress", { params: query })
      .then(({ data: body }) => !cancelled && setData(body))
      .catch((e) => !cancelled && setErr(errorText(e, "Unable to load progress.")))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [key, retry]);

  const update = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (next.get("period") !== "custom") {
      next.delete("from");
      next.delete("to");
    }
    setParams(next, { replace: true });
  };

  const colorOf = useMemo(() => {
    const order = (data?.staff_options?.length ? data.staff_options : data?.trend?.reps || []).map(
      (s) => s.id,
    );
    return (id) => SERIES[Math.max(0, order.indexOf(id)) % SERIES.length];
  }, [data]);

  const reportFilters = data?.filters;
  const scope = reportFilters
    ? {
        from: reportFilters.from,
        to: reportFilters.to,
        rep: reportFilters.rep,
        territory: reportFilters.territory || undefined,
      }
    : null;
  const who = !data
    ? ""
    : !data.can_pick_staff
      ? data.viewer.full_name
      : reportFilters.rep === "all"
        ? "All staff"
        : data.staff_options.find((s) => s.id === reportFilters.rep)?.full_name || "";

  const exportReport = async () => {
    setExporting(true);
    setExportErr(null);
    try {
      const qs = new URLSearchParams(query).toString();
      await downloadFile(
        `/api/crm/progress/export.xlsx${qs ? `?${qs}` : ""}`,
        `crm-progress-${reportFilters.from}-to-${reportFilters.to}.xlsx`,
      );
    } catch (e) {
      setExportErr(errorText(e, "Unable to download the report."));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="rep rep--wide prg">
      <header className="prg__head">
        <div className="prg__title">
          <Link to="/crm/home" className="rep__back" aria-label="Back to CRM home">
            ←
          </Link>
          <div>
            <h1 className="rep__title">Progress</h1>
            {data && (
              <p className="rep__hint" aria-live="polite">
                {who} · {rangeText(reportFilters.from, reportFilters.to)} · compared with{" "}
                {rangeText(reportFilters.previous.from, reportFilters.previous.to)}
              </p>
            )}
          </div>
        </div>
        <button
          type="button"
          className="rep__perf-action"
          onClick={exportReport}
          disabled={!data || exporting}
        >
          {exporting ? "Preparing…" : "Download report"}
        </button>
      </header>

      {exportErr && (
        <div className="rep__err" role="alert">
          {exportErr}
        </div>
      )}

      <ProgressFilters
        filters={filters}
        data={data}
        onChange={update}
        onReset={() => setParams(new URLSearchParams(), { replace: true })}
        busy={loading && !data}
      />

      {err && (
        <div className="rep__err" role="alert">
          {err}{" "}
          <button type="button" className="asg__link" onClick={() => setRetry((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      {!data && loading && (
        <div className="prg__cards" aria-busy="true">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="prg__card asg__skeleton" />
          ))}
        </div>
      )}

      {data && !err && (
        <div className={loading ? "prg__body prg__body--loading" : "prg__body"} aria-busy={loading}>
          <ProgressCards cards={data.cards} previous={data.previous_cards} />
          <ProgressTrend trend={data.trend} colorOf={colorOf} />
          {data.staff.length > 0 && (
            <StaffTable
              staff={data.staff}
              cards={data.cards}
              colorOf={colorOf}
              onPick={(id) => update({ rep: id })}
            />
          )}
          <Breakdowns breakdowns={data.breakdowns} />
          <ProgressDoctors params={scope} showRep={reportFilters.rep === "all"} />
          <p className="rep__hint">
            India time; weeks start Monday. “As of now” numbers show today’s state, whatever the
            period. Coverage counts each doctor under their current owner.
          </p>
        </div>
      )}
    </div>
  );
}
