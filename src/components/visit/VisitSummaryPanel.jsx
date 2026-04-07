import { memo, useState, useEffect, useRef } from "react";
import { fmtDate } from "./helpers";
import api from "../../services/api";
import "./VisitSummaryPanel.css";

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

const VisitSummaryPanel = memo(function VisitSummaryPanel({
  patientId,
  appointmentId,
  forceCollapsed = false,
}) {
  const [dismissed, setDismissed] = useState(false);
  const [manualExpand, setManualExpand] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rules, setRules] = useState(null); // { red, amber, green }
  const [ai, setAi] = useState(null); // { red, amber, green } | null
  const [generatedAt, setGeneratedAt] = useState(null);
  const [fromCache, setFromCache] = useState(false);
  const hasFiredRef = useRef(false);

  useEffect(() => {
    if (!patientId || hasFiredRef.current) return;
    hasFiredRef.current = true;

    const url = appointmentId
      ? `/api/patients/${patientId}/summary?appointmentId=${appointmentId}`
      : `/api/patients/${patientId}/summary`;

    api
      .get(url)
      .then(({ data }) => {
        setRules(data.rules || { red: [], amber: [], green: [] });
        setAi(data.ai || null);
        setGeneratedAt(data.generatedAt || null);
        setFromCache(data.cached ?? false);
      })
      .catch(() => {
        // Silent fail — panel stays hidden (rules = null means nothing to show)
      })
      .finally(() => setLoading(false));
  }, [patientId, appointmentId]);

  if (loading || dismissed || !rules) return null;

  const display = ai ?? rules;
  const hasRed = display.red.length > 0;
  const hasAmber = display.amber.length > 0;
  const hasGreen = display.green.length > 0;
  const totalUrgent = rules.red.length + rules.amber.length;

  if (!hasRed && !hasAmber && !hasGreen) return null;

  const autoExpand = !forceCollapsed && (rules.red.length > 0 || rules.amber.length > 0);
  const isExpanded = autoExpand || manualExpand;
  const topZone = rules.red.length > 0 ? "red" : rules.amber.length > 0 ? "amber" : "green";

  let footerText = generatedAt
    ? `Generated ${fmtDate(generatedAt)} from latest data`
    : "Generated from latest data";
  if (fromCache) footerText += " · cached";
  if (ai) footerText += " · ✦ AI";

  // ── Collapsed state ──
  if (!isExpanded) {
    return (
      <div className="sp-panel-collapsed">
        <span className="sp-routine-text">✅ All parameters on track — routine visit</span>
        <div className="sp-collapsed-actions">
          {hasGreen && (
            <button className="bx bx-n" onClick={() => setManualExpand(true)}>
              Details ▾
            </button>
          )}
          <button className="sp-close-btn" title="Dismiss" onClick={() => setDismissed(true)}>
            ✕
          </button>
        </div>
      </div>
    );
  }

  const renderZone = (zone, items) =>
    items.map((item, i) =>
      ai ? (
        <AiRow key={i} zone={zone} text={item} />
      ) : (
        <AlertRow key={item.id} zone={zone} alert={item} />
      ),
    );

  return (
    <div className={`sp-panel zone-${topZone}`}>
      <div className="sp-head">
        <div className="sp-title">
          {topZone === "red" && "🔴 Before you start"}
          {topZone === "amber" && "🟡 Consider this visit"}
          {topZone === "green" && "✅ All parameters on track"}
          {totalUrgent > 0 && <span className={`sp-badge ${topZone}`}>{totalUrgent}</span>}
        </div>
        <div className="sp-actions">
          {!autoExpand && manualExpand && (
            <button className="bx bx-n" onClick={() => setManualExpand(false)}>
              Collapse ▴
            </button>
          )}
          <button className="sp-close-btn" title="Dismiss" onClick={() => setDismissed(true)}>
            ✕
          </button>
        </div>
      </div>

      <div className="sp-body">
        {hasRed && renderZone("red", display.red)}

        {hasAmber && (
          <>
            {hasRed && <div className="sp-divider" />}
            {renderZone("amber", display.amber)}
          </>
        )}

        {hasGreen && (
          <>
            {(hasRed || hasAmber) && <div className="sp-divider" />}
            {renderZone("green", display.green)}
          </>
        )}
      </div>

      <div className="sp-footer">{footerText}</div>
    </div>
  );
});

export default VisitSummaryPanel;
