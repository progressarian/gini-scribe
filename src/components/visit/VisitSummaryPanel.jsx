import { memo, useState, useEffect, useRef, useCallback } from "react";
import { fmtDate } from "./helpers";
import api from "../../services/api";
import "./VisitSummaryPanel.css";
import "../Shimmer.css";

// ── Alert row (rule engine mode) ──────────────────────────────────────────────

const ZONE_ICON = { red: "🔴", amber: "🟡", green: "✅" };

const AlertRow = memo(function AlertRow({ zone, alert }) {
  return (
    <div className={`sp-alert-row zone-${zone}`}>
      <span className="sp-alert-icon">{ZONE_ICON[zone]}</span>
      <div className="sp-alert-content">
        <div className="sp-alert-title">{alert.title}</div>
        {alert.detail && <div className="sp-alert-detail">{alert.detail}</div>}
        {alert.action && <div className="sp-alert-action">→ {alert.action}</div>}
      </div>
    </div>
  );
});

// ── AI sentence row ───────────────────────────────────────────────────────────

const AiRow = memo(function AiRow({ zone, text }) {
  return (
    <div className={`sp-alert-row zone-${zone}`}>
      <span className="sp-alert-icon">{ZONE_ICON[zone]}</span>
      <div className="sp-alert-content">
        <div className="sp-alert-title">{text}</div>
      </div>
    </div>
  );
});

// ── Main panel ────────────────────────────────────────────────────────────────

const VisitSummaryPanel = memo(function VisitSummaryPanel({ patientId, appointmentId }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState(null); // { red, amber, green }
  const [ai, setAi] = useState(null); // { red, amber, green } | null
  const [dataAsOf, setDataAsOf] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const [latestReport, setLatestReport] = useState(null);
  const hasFiredRef = useRef(false);

  const loadSummary = useCallback(
    ({ regenerate = false } = {}) => {
      if (!patientId) return;
      const params = new URLSearchParams();
      if (appointmentId) params.set("appointmentId", String(appointmentId));
      if (regenerate) params.set("regenerate", "true");
      const qs = params.toString();
      const url = `/api/patients/${patientId}/summary${qs ? "?" + qs : ""}`;

      setLoading(true);
      return api
        .get(url)
        .then(({ data }) => {
          setRules(data.rules || { red: [], amber: [], green: [] });
          setAi(data.ai || null);
          setDataAsOf(data.dataAsOf || null);
          setFromCache(data.cached ?? false);
          setLatestReport(data.latestReport || null);
        })
        .catch(() => {
          // Silent fail — panel stays hidden (rules = null means nothing to show)
        })
        .finally(() => setLoading(false));
    },
    [patientId, appointmentId],
  );

  useEffect(() => {
    if (!patientId || hasFiredRef.current) return;
    hasFiredRef.current = true;
    loadSummary();
  }, [patientId, loadSummary]);

  if (loading) {
    return (
      <div className="sp-panel-collapsed sp-panel-collapsed-loading">
        <div className="shimmer sp-shimmer-collapsed-text" />
        <div className="shimmer sp-shimmer-collapsed-btn" />
      </div>
    );
  }

  if (!rules) return null;

  const display = ai ?? rules;
  const hasRed = display.red.length > 0;
  const hasAmber = display.amber.length > 0;
  const hasGreen = display.green.length > 0;
  if (!hasRed && !hasAmber && !hasGreen) return null;

  const topZone = rules.red.length > 0 ? "red" : rules.amber.length > 0 ? "amber" : "green";
  const totalCount = display.red.length + display.amber.length + display.green.length;
  const summaryText =
    rules.red.length > 0
      ? `🔴 ${rules.red.length} item${rules.red.length !== 1 ? "s" : ""} need attention`
      : rules.amber.length > 0
        ? `🟡 ${rules.amber.length} item${rules.amber.length !== 1 ? "s" : ""} to consider`
        : `✅ All parameters on track — routine visit`;

  let footerText;
  if (latestReport) {
    const reportName = latestReport.title || latestReport.file_name || "Latest report";
    footerText = `Based on ${reportName} · ${fmtDate(dataAsOf)}`;
  } else {
    footerText = dataAsOf
      ? `Based on data from ${fmtDate(dataAsOf)}`
      : "Generated from latest data";
  }
  if (fromCache) footerText += " · cached";
  if (ai) footerText += " · ✦ AI";

  const renderZone = (zone, items) =>
    items.map((item, i) =>
      ai ? (
        <AiRow key={i} zone={zone} text={item} />
      ) : (
        <AlertRow key={item.id} zone={zone} alert={item} />
      ),
    );

  // Collapsed (default) — mini header bar with toggle
  if (!open) {
    return (
      <div className={`sp-panel-collapsed zone-${topZone}`}>
        <span className="sp-routine-text">{summaryText}</span>
        <button className="bx bx-n sp-toggle-btn" onClick={() => setOpen(true)}>
          Open ▾
        </button>
      </div>
    );
  }

  return (
    <div className={`sp-panel zone-${topZone}`}>
      <div className="sp-body">
        <div className={`sp-zone-hd zone-${topZone}`}>
          <span>
            {summaryText}
            {totalCount > 0 ? ` · ${totalCount} item${totalCount !== 1 ? "s" : ""}` : ""}
          </span>
          <div className="sp-actions">
            <button
              className="bx bx-n sp-toggle-btn"
              onClick={() => loadSummary({ regenerate: true })}
              disabled={loading}
              title="Regenerate summary from latest data"
            >
              {loading ? "Regenerating…" : "↻ Regenerate"}
            </button>
            <button className="bx bx-n sp-toggle-btn" onClick={() => setOpen(false)}>
              Close ▴
            </button>
          </div>
        </div>

        {hasRed && <>{renderZone("red", display.red)}</>}

        {hasAmber && (
          <>
            {hasRed && <div className="sp-divider" />}
            <div className="sp-zone-hd zone-amber">
              <span>🟡 Also consider</span>
            </div>
            {renderZone("amber", display.amber)}
          </>
        )}

        {hasGreen && (
          <>
            {(hasRed || hasAmber) && <div className="sp-divider" />}
            <div className="sp-zone-hd zone-green">
              <span>
                ✅ Working well <span className="sp-zone-hd-sub">— tell the patient</span>
              </span>
            </div>
            {renderZone("green", display.green)}
          </>
        )}
      </div>

      <div className="sp-footer">{footerText}</div>
    </div>
  );
});

export default VisitSummaryPanel;
