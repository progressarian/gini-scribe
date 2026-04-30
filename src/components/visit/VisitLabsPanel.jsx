import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtDate } from "./helpers";
import PdfViewerModal from "./PdfViewerModal";
import { LAB_PANELS as PANELS } from "../../config/labOrder";
import { getFallbackRange } from "../../config/labRanges";
import { getDocStatus } from "../../utils/docStatus";
import { cleanNote } from "../../utils/cleanNote";
import DocStatusPill from "../ui/DocStatusPill";
import MismatchActions from "./MismatchActions";
import usePatientStore from "../../stores/patientStore";

// Panel grouping config lives in src/config/labOrder.js — single source of
// truth shared with Outcomes, Sidebar, Assess and the dashboard. See
// labOrder.md at project root for the clinical rationale.

const SOURCE_PRIORITY = {
  lab_healthray: 1,
  opd: 2,
  report_extract: 3,
  healthray: 4,
  prescription_parsed: 5,
};

const parseExt = (raw) => {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
};

const isMismatchReview = (doc) =>
  parseExt(doc.extracted_data)?.extraction_status === "mismatch_review";

function formatTestName(name) {
  if (!name) return "—";
  return name
    .replace(/_/g, " ")
    .replace(/\s*\.\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function buildLatestRows(labLatest) {
  if (!labLatest || typeof labLatest !== "object") return [];

  // Convert labLatest object → array with canonical key
  const rows = Object.entries(labLatest).map(([canonical, v]) => ({
    canonical,
    test_name: v.test_name || canonical,
    result: v.result,
    result_text: v.result_text,
    unit: v.unit,
    flag: v.flag,
    ref_range: v.ref_range,
    test_date: v.date,
    source: v.source || "healthray",
    panel_name: v.panel_name || null,
  }));

  // Cross-source dedup: if two rows have the same numeric result + unit on same date,
  // and nearly same test_name (case/punct insensitive), keep the higher-priority source.
  // Strip "Serum", "S.", "Sr.", "Plasma", "B." prefixes so variants like
  // "S. Ferritin" and "Ferritin" collapse onto one dedup key even when the
  // server's canonical_name hasn't caught up. Match both whitespace and
  // underscore separators — legacy HealthRay ingest stored canonical names
  // as "s._ferritin", so an underscore-aware prefix strip is required.
  const PREFIX_RE = /^(serum|plasma|s\.?|sr\.?|b\.?)[\s_]+/i;
  const normalize = (s) =>
    (s || "")
      .toLowerCase()
      .replace(PREFIX_RE, "")
      .replace(/[^a-z0-9]/g, "");
  const kept = new Map();

  // Sort by source priority so best source is processed first
  rows.sort((a, b) => (SOURCE_PRIORITY[a.source] ?? 9) - (SOURCE_PRIORITY[b.source] ?? 9));

  for (const row of rows) {
    const nk = normalize(row.canonical) || normalize(row.test_name);
    if (!kept.has(nk)) {
      kept.set(nk, row);
    }
    // Already have a better/equal source — skip
  }

  return Array.from(kept.values());
}

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Find results that belong to a given order name (report or test panel)
// Tries static PANELS config first, then falls back to direct name match
function findResultsForOrder(orderName, rows, assigned) {
  const on = norm(orderName);

  // Try matching via PANELS config
  const panel = PANELS.find(
    (p) => norm(p.name) === on || on.includes(norm(p.name)) || norm(p.name).includes(on),
  );
  if (panel) {
    return rows.filter((r) => {
      if (assigned.has(r.canonical)) return false;
      const cn = (r.canonical || "").toLowerCase();
      const tn = (r.test_name || "").toLowerCase();
      return panel.keys.some((k) => cn.includes(k) || tn.includes(k));
    });
  }

  // Direct fuzzy match on test_name / canonical
  return rows.filter((r) => {
    if (assigned.has(r.canonical)) return false;
    return (
      norm(r.test_name).includes(on) ||
      norm(r.canonical).includes(on) ||
      on.includes(norm(r.test_name))
    );
  });
}

// Rank a section by its position in the canonical PANELS order so the on-screen
// order is independent of the (arbitrary) order HealthRay returns reports/tests
// in `investigation_summary`. Returns panelIndex*1000 + firstMatchingKeyIndex
// so multiple sections within the same panel preserve sub-order (e.g. HbA1c
// before FBS, both inside the Diabetes panel).
function rankSection(name) {
  const sn = norm(name);
  for (let i = 0; i < PANELS.length; i++) {
    const p = PANELS[i];
    if (norm(p.name) === sn || sn.includes(norm(p.name)) || norm(p.name).includes(sn)) {
      return i * 1000;
    }
    for (let j = 0; j < p.keys.length; j++) {
      if (sn.includes(norm(p.keys[j]))) {
        return i * 1000 + j;
      }
    }
  }
  return 999000; // unmatched → push to end (e.g., "Other")
}

// Build ordered sections from labOrders when available, fall back to PANELS config.
// Result is always sorted by canonical PANELS order regardless of source.
function buildSections(rows, labOrders) {
  const latestOrder = labOrders?.[0];
  const assigned = new Set();
  const sections = [];

  if (latestOrder && (latestOrder.reports?.length > 0 || latestOrder.tests?.length > 0)) {
    for (const reportName of latestOrder.reports || []) {
      const results = findResultsForOrder(reportName, rows, assigned);
      if (results.length > 0) {
        results.forEach((r) => assigned.add(r.canonical));
        sections.push({ type: "report", name: reportName, results });
      }
    }
    for (const testName of latestOrder.tests || []) {
      const results = findResultsForOrder(testName, rows, assigned);
      if (results.length > 0) {
        results.forEach((r) => assigned.add(r.canonical));
        sections.push({ type: "test", name: testName, results });
      }
    }
  } else {
    // No labOrders — fall back to static PANELS config
    for (const panel of PANELS) {
      const matches = rows.filter((r) => {
        if (assigned.has(r.canonical)) return false;
        const cn = (r.canonical || "").toLowerCase();
        const tn = (r.test_name || "").toLowerCase();
        return panel.keys.some((k) => cn.includes(k) || tn.includes(k));
      });
      if (matches.length > 0) {
        matches.forEach((r) => assigned.add(r.canonical));
        sections.push({ type: "report", name: panel.name, results: matches });
      }
    }
  }

  // Group remaining rows by server-provided panel_name (e.g. "Haematology",
  // "Biochemistry" from HealthRay category). Runs regardless of branch above
  // so orphan rows from `investigation_summary` still get categorised.
  const byPanel = new Map();
  for (const r of rows) {
    if (assigned.has(r.canonical)) continue;
    const key = r.panel_name && String(r.panel_name).trim();
    if (!key) continue;
    if (!byPanel.has(key)) byPanel.set(key, []);
    byPanel.get(key).push(r);
  }
  for (const [name, results] of byPanel) {
    results.forEach((r) => assigned.add(r.canonical));
    sections.push({ type: "report", name, results });
  }

  // Catch-all "Other" — shows every test the user paid for, even if it doesn't
  // match any known panel or carry a server-side category.
  const others = rows.filter((r) => !assigned.has(r.canonical));
  if (others.length > 0) sections.push({ type: "report", name: "Other", results: others });

  // Enforce canonical order regardless of which branch built the sections.
  sections.sort((a, b) => rankSection(a.name) - rankSection(b.name));
  return sections;
}

// Parse the lab range string ("4 - 6", "<200", "70-100") into [low, high].
function parseRangeBounds(range) {
  if (!range) return [null, null];
  const s = String(range).replace(/[,\s]/g, "");
  const dash = s.match(/^(-?\d+(?:\.\d+)?)[-–to]+(-?\d+(?:\.\d+)?)$/i);
  if (dash) return [Number(dash[1]), Number(dash[2])];
  const lt = s.match(/^<=?(-?\d+(?:\.\d+)?)/);
  if (lt) return [null, Number(lt[1])];
  const gt = s.match(/^>=?(-?\d+(?:\.\d+)?)/);
  if (gt) return [Number(gt[1]), null];
  return [null, null];
}

const numericResult = (v) => {
  if (v == null) return null;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const histKey = (s) =>
  (s || "")
    .toLowerCase()
    .replace(/^(serum|plasma|s\.?|sr\.?|b\.?)[\s_]+/i, "")
    .replace(/[^a-z0-9]/g, "");

// All historical numeric readings for the test in `r`, oldest → newest.
function buildHistorySeries(labResults, r) {
  if (!labResults?.length) return [];
  const target = histKey(r.canonical) || histKey(r.test_name);
  if (!target) return [];
  const points = [];
  for (const row of labResults) {
    const k = histKey(row.canonical_name) || histKey(row.test_name);
    if (k !== target) continue;
    const value = numericResult(row.result ?? row.result_text);
    if (value == null) continue;
    if (!row.test_date) continue;
    points.push({
      date: row.test_date.slice(0, 10),
      value,
      flag: row.flag,
      unit: row.unit,
      ref_range: row.ref_range,
    });
  }
  points.sort((a, b) => a.date.localeCompare(b.date));
  // Collapse same-day duplicates by keeping the worst (HIGH/LOW > normal) reading.
  const byDate = new Map();
  for (const p of points) {
    const existing = byDate.get(p.date);
    if (!existing) byDate.set(p.date, p);
    else if (!existing.flag && p.flag) byDate.set(p.date, p);
  }
  return Array.from(byDate.values());
}

// Compact biomarker card with inline sparkline — mirrors the post-visit
// brief card style. Single source of truth for the lab-row trend popout.
function LabHistoryChart({ series, displayRange, unit, currentDate, testName }) {
  const [hover, setHover] = useState(null);
  const scrollRef = useRef(null);
  const svgRef = useRef(null);
  const [wrapW, setWrapW] = useState(0);

  useLayoutEffect(() => {
    if (!scrollRef.current) return;
    const el = scrollRef.current;
    const ro = new ResizeObserver(([entry]) => {
      setWrapW(entry.contentRect.width);
    });
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Reset hover on scroll so the portal tooltip doesn't drift away from the dot.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const close = () => setHover(null);
    el.addEventListener("scroll", close, { passive: true });
    return () => el.removeEventListener("scroll", close);
  }, []);

  if (!series || series.length === 0) {
    return (
      <div style={{ padding: "16px 14px", fontSize: 12, color: "var(--t3)" }}>
        No numeric history available for this test.
      </div>
    );
  }

  const [lo, hi] = parseRangeBounds(displayRange);
  const values = series.map((p) => p.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const yMin = lo != null ? Math.min(dataMin, lo) : dataMin;
  const yMax = hi != null ? Math.max(dataMax, hi) : dataMax;
  const span = yMax - yMin || Math.abs(yMax) || 1;
  const pad = span * 0.15;
  const domainLo = yMin - pad;
  const domainHi = yMax + pad;
  const domainSpan = domainHi - domainLo || 1;

  const H = 52;
  const n = series.length;
  // Always fill the container; only grow beyond it (and trigger scroll) when
  // labels would otherwise crowd. ~44px per point keeps value labels readable.
  const PER_POINT = 44;
  const measured = wrapW > 0 ? wrapW : 260;
  const minByPoints = n * PER_POINT;
  const W = Math.max(measured, minByPoints);
  const overflows = minByPoints > measured;
  const xAt = (i) => (n === 1 ? W / 2 : (i / (n - 1)) * W);
  const yAt = (v) => H - ((v - domainLo) / domainSpan) * H;

  const points = series.map((p, i) => ({ ...p, cx: xAt(i), cy: yAt(p.value) }));

  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const lastOut = (lo != null && last.value < lo) || (hi != null && last.value > hi);
  const accent = lastOut ? "#dc2626" : "#059669";
  const accentMuted = lastOut ? "#fee2e2" : "#05966915";

  let arrow = "";
  let deltaText = "";
  if (prev) {
    const delta = last.value - prev.value;
    if (Math.abs(delta) >= 0.01) {
      const towardGoal =
        (hi != null && delta < 0 && last.value <= hi + Math.abs(hi) * 0.05) ||
        (lo != null && delta > 0 && last.value >= lo - Math.abs(lo) * 0.05);
      arrow = delta < 0 ? "↓" : "↑";
      const fmtNum = (x) => {
        const a = Math.abs(x);
        return a < 1 ? a.toFixed(2) : a < 10 ? a.toFixed(1) : Math.round(a).toString();
      };
      deltaText = `${delta < 0 ? "▼" : "▲"} ${fmtNum(delta)}${unit ? " " + unit : ""} from ${fmtDate(prev.date)}`;
      if (!towardGoal && (lo != null || hi != null)) {
        // fall through; colour stays accent
      }
    }
  }

  const polyline = points.map((p) => `${p.cx},${p.cy}`).join(" ");
  const polygon = `0,${H} ${polyline} ${W},${H}`;

  // Goal text from range
  let goalText = displayRange || "—";
  if (displayRange && /^\s*\d/.test(displayRange) && lo != null && hi != null) {
    goalText = `${lo}–${hi}${unit ? " " + unit : ""}`;
  }

  const fmtVal = (v) => {
    const a = Math.abs(v);
    return a < 1 ? v.toFixed(2) : a < 10 ? v.toFixed(1) : String(Math.round(v * 10) / 10);
  };

  return (
    <div style={{ padding: "10px 14px 14px", background: "#f8fafc" }}>
      <div
        style={{
          background: "white",
          borderRadius: 12,
          border: "1px solid #f1f5f9",
          boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          width: "100%",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            padding: "10px 14px 6px",
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: "#475569" }}>
            {formatTestName(testName)}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 3 }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: accent, lineHeight: 1 }}>
              {fmtVal(last.value)}
            </span>
            {unit && (
              <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 500 }}>{unit}</span>
            )}
            {arrow && <span style={{ fontSize: 12, fontWeight: 700, color: accent }}>{arrow}</span>}
          </div>
        </div>

        <div
          ref={scrollRef}
          className="slim-scroll-x"
          style={{
            padding: "0 14px",
            position: "relative",
            overflowX: overflows ? "auto" : "hidden",
            overflowY: "visible",
          }}
        >
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            width={W}
            height={H}
            style={{
              display: "block",
              overflow: "visible",
            }}
            onMouseLeave={() => setHover(null)}
          >
            {/* Goal line — show upper bound when present */}
            {hi != null && yAt(hi) >= 0 && yAt(hi) <= H && (
              <>
                <line
                  x1={0}
                  y1={yAt(hi)}
                  x2={W}
                  y2={yAt(hi)}
                  stroke="#10b981"
                  strokeDasharray="3,3"
                  strokeWidth={0.8}
                  opacity={0.5}
                />
                <text
                  x={W - 2}
                  y={yAt(hi) - 3}
                  fill="#10b981"
                  fontSize={6.5}
                  textAnchor="end"
                  opacity={0.7}
                >
                  target {hi}
                </text>
              </>
            )}
            {/* Goal line — lower bound */}
            {lo != null && yAt(lo) >= 0 && yAt(lo) <= H && (
              <line
                x1={0}
                y1={yAt(lo)}
                x2={W}
                y2={yAt(lo)}
                stroke="#10b981"
                strokeDasharray="3,3"
                strokeWidth={0.8}
                opacity={0.5}
              />
            )}
            {n > 1 && <polygon points={polygon} fill={accentMuted} />}
            {n > 1 && (
              <polyline
                points={polyline}
                fill="none"
                stroke={accent}
                strokeWidth={2}
                strokeLinejoin="round"
              />
            )}
            {points.map((p, i) => {
              const isFirst = i === 0;
              const isLast = i === points.length - 1;
              const isCurrent = currentDate && p.date === String(currentDate).slice(0, 10);
              const isHover = hover?.i === i;
              const labelY = p.cy - 6 < 8 ? p.cy + 12 : p.cy - 6;
              const anchor = isFirst ? "start" : isLast ? "end" : "middle";
              const textX = isFirst ? p.cx + 1 : isLast ? p.cx - 1 : p.cx;
              return (
                <g
                  key={i}
                  style={{ cursor: "crosshair" }}
                  onMouseEnter={() => setHover({ i, p })}
                  onMouseMove={() => setHover({ i, p })}
                >
                  <circle
                    cx={p.cx}
                    cy={p.cy}
                    r={isHover || isCurrent ? 4 : 3}
                    fill={isHover ? accent : "white"}
                    stroke={accent}
                    strokeWidth={isCurrent ? 2.4 : 1.8}
                  />
                  <text
                    x={textX}
                    y={labelY}
                    fill={accent}
                    fontSize={8.5}
                    fontWeight={700}
                    textAnchor={anchor}
                    fontFamily="DM Sans,sans-serif"
                    style={{ paintOrder: "stroke", stroke: "white", strokeWidth: 2.5 }}
                  >
                    {fmtVal(p.value)}
                  </text>
                  <circle cx={p.cx} cy={p.cy} r={14} fill="transparent" />
                </g>
              );
            })}
          </svg>
        </div>
        {hover &&
          svgRef.current &&
          (() => {
            const rect = svgRef.current.getBoundingClientRect();
            // SVG renders at width=W pixels with preserveAspectRatio=none, so
            // viewBox cx maps 1:1 to screen px from the left edge of the SVG.
            const screenX = rect.left + hover.p.cx;
            const screenY = rect.top + hover.p.cy;
            return createPortal(
              <div
                style={{
                  position: "fixed",
                  left: screenX,
                  top: screenY - 10,
                  transform: "translate(-50%, -100%)",
                  background: "#0f172a",
                  color: "white",
                  fontSize: 10.5,
                  fontWeight: 600,
                  padding: "5px 8px",
                  borderRadius: 6,
                  whiteSpace: "nowrap",
                  pointerEvents: "none",
                  boxShadow: "0 4px 12px rgba(15,23,42,0.25)",
                  zIndex: 9999,
                }}
              >
                <div style={{ color: "#94a3b8", fontWeight: 500, fontSize: 9.5 }}>
                  {fmtDate(hover.p.date)}
                </div>
                <div>
                  {fmtVal(hover.p.value)}
                  {unit ? ` ${unit}` : ""}
                  {hover.p.flag ? (
                    <span
                      style={{
                        marginLeft: 6,
                        fontSize: 8.5,
                        padding: "1px 4px",
                        borderRadius: 3,
                        background: hover.p.flag === "HIGH" ? "#dc2626" : "#0284c7",
                      }}
                    >
                      {hover.p.flag}
                    </span>
                  ) : null}
                </div>
              </div>,
              document.body,
            );
          })()}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "3px 14px 6px",
            fontSize: 8,
            color: "#94a3b8",
          }}
        >
          <span>{fmtDate(series[0].date)}</span>
          <span style={{ color: "#cbd5e1" }}>
            {n} reading{n === 1 ? "" : "s"}
          </span>
          <span>{fmtDate(series[n - 1].date)}</span>
        </div>

        {deltaText && (
          <div
            style={{
              padding: "4px 14px 6px",
              fontSize: 10,
              fontWeight: 600,
              color: accent,
              borderTop: "1px solid #f8fafc",
            }}
          >
            {deltaText}
          </div>
        )}

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "5px 14px 8px",
            borderTop: "1px solid #f8fafc",
            fontSize: 10,
          }}
        >
          <span style={{ color: "#94a3b8", fontWeight: 600 }}>Goal</span>
          <span style={{ fontWeight: 700, color: accent }}>{goalText}</span>
        </div>
      </div>
    </div>
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────
function ResultRow({ r, labResults }) {
  const [expanded, setExpanded] = useState(false);
  const isAbnormal = r.flag === "HIGH" || r.flag === "LOW";
  const fallbackRange = r.ref_range ? null : getFallbackRange(r.canonical, r.test_name);
  const displayRange = r.ref_range || fallbackRange || "";
  const series = useMemo(
    () => (expanded ? buildHistorySeries(labResults, r) : []),
    [expanded, labResults, r],
  );
  const hasNumeric = numericResult(r.result ?? r.result_text) != null;

  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <div
        className="visit-lab-row"
        onClick={() => hasNumeric && setExpanded((v) => !v)}
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr 1fr",
          padding: "7px 14px",
          gap: 6,
          fontSize: 12,
          background: expanded
            ? "rgba(59,91,219,0.05)"
            : isAbnormal
              ? "rgba(220,53,69,0.04)"
              : undefined,
          cursor: hasNumeric ? "pointer" : "default",
        }}
        title={hasNumeric ? "Click to view trend" : undefined}
      >
        <span
          style={{
            fontWeight: 500,
            color: "var(--text)",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          {hasNumeric && (
            <span
              style={{
                fontSize: 9,
                color: "var(--t3)",
                transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
                transition: "transform 0.15s",
                display: "inline-block",
                width: 10,
              }}
            >
              ▶
            </span>
          )}
          {formatTestName(r.test_name)}
        </span>
        <span style={{ fontWeight: 700, color: isAbnormal ? "var(--red)" : "var(--text)" }}>
          {r.result ?? r.result_text ?? "—"}
          {r.flag && <span style={{ fontSize: 9, marginLeft: 3 }}>({r.flag})</span>}
        </span>
        <span style={{ color: "var(--t3)" }}>{r.unit || ""}</span>
        <span
          style={{
            color: fallbackRange ? "var(--t5, #9aa0a6)" : "var(--t4)",
            fontSize: 11,
            fontStyle: fallbackRange ? "italic" : "normal",
          }}
          title={fallbackRange ? "Typical reference range (lab did not provide one)" : undefined}
        >
          {displayRange}
        </span>
      </div>
      {expanded && (
        <LabHistoryChart
          series={series}
          displayRange={displayRange}
          unit={r.unit}
          currentDate={r.test_date}
          testName={r.test_name}
        />
      )}
    </div>
  );
}

// ── Panel block ───────────────────────────────────────────────────────────────
function PanelBlock({ name, results, type, labResults }) {
  const date = results[0]?.test_date;
  const isTest = type === "test";
  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--rs)",
        overflow: "hidden",
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "7px 14px",
          background: isTest ? "var(--bg2, #f8f9fa)" : "var(--pri-lt, #f0f4ff)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {type && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 5px",
                borderRadius: 3,
                letterSpacing: 0.5,
                background: isTest ? "var(--bg3, #e9ecef)" : "var(--pri-lt2, #dbe4ff)",
                color: isTest ? "var(--t2, #555)" : "var(--pri, #3b5bdb)",
                textTransform: "uppercase",
              }}
            >
              {isTest ? "Test" : "Report"}
            </span>
          )}
          <span
            style={{
              fontWeight: 600,
              fontSize: 12,
              color: isTest ? "var(--text)" : "var(--pri, #3b5bdb)",
            }}
          >
            {name}
          </span>
        </div>
        {date && <span style={{ fontSize: 11, color: "var(--t3)" }}>{fmtDate(date)}</span>}
      </div>
      <div
        className="visit-lab-row visit-lab-head"
        style={{
          display: "grid",
          gridTemplateColumns: "2fr 1fr 1fr 1fr",
          padding: "5px 14px",
          background: "var(--bg)",
          gap: 6,
        }}
      >
        <span className="mthl">Test</span>
        <span className="mthl">Result</span>
        <span className="mthl">Unit</span>
        <span className="mthl">Range</span>
      </div>
      {results.map((r, i) => (
        // Key on the row's lab_results.id — canonical alone collapses React
        // renders when multiple reports on the same day carry the same test.
        <ResultRow key={r.id ?? `${r.canonical}-${i}`} r={r} labResults={labResults} />
      ))}
    </div>
  );
}

// Build rows from labResults for a specific date (same shape as buildLatestRows).
// No canonical-name dedup: if the user uploaded multiple reports on the same
// day that each contain the same test, every reading is shown so the user
// can compare values / spot data-entry errors across reports.
function buildHistoricalRows(labResults, dateStr) {
  if (!labResults?.length || !dateStr) return [];
  const dayResults = labResults.filter((r) => r.test_date && r.test_date.slice(0, 10) === dateStr);
  return dayResults.map((r) => ({
    id: r.id,
    canonical: r.canonical_name || r.test_name,
    test_name: r.test_name,
    result: r.result,
    result_text: r.result_text,
    unit: r.unit,
    flag: r.flag,
    ref_range: r.ref_range,
    test_date: r.test_date,
    source: r.source || "healthray",
    panel_name: r.panel_name || null,
  }));
}

// Find the labOrder whose case_date matches a given date
function findLabOrderForDate(labOrders, dateStr) {
  if (!labOrders?.length || !dateStr) return null;
  return labOrders.find((o) => o.date && o.date.slice(0, 10) === dateStr) || null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const VisitLabsPanel = memo(function VisitLabsPanel({
  documents,
  patientId,
  labResults,
  labLatest,
  labOrders,
  onUploadReport,
}) {
  const [viewingDoc, setViewingDoc] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null); // null = "Latest"
  const patient = usePatientStore((s) => s.patient);

  // On the Labs tab we want every uploaded document to be visible except
  // prescriptions (those belong to the Rx / visit history, not the lab view).
  // Radiology sub-categories get their own section; everything else — including
  // lab_report, all lab sub-categories, "other", and any unexpected values —
  // falls under "Blood Reports" so nothing silently disappears from the UI.
  const RADIOLOGY_DOC_TYPES = new Set([
    "imaging",
    "radiology",
    "xray",
    "usg",
    "mri",
    "dexa",
    "ecg",
    "ncs",
    "eye",
  ]);
  const labDocs = documents.filter(
    (d) => d.doc_type !== "prescription" && !RADIOLOGY_DOC_TYPES.has(d.doc_type),
  );
  const radiologyDocs = documents.filter((d) => RADIOLOGY_DOC_TYPES.has(d.doc_type));

  const openDoc = useCallback((doc) => {
    setViewingDoc(doc);
  }, []);

  // Extract unique lab dates from all results, newest first
  const availableDates = useMemo(() => {
    if (!labResults?.length) return [];
    const dateSet = new Set();
    for (const r of labResults) {
      if (r.test_date) dateSet.add(r.test_date.slice(0, 10));
    }
    return Array.from(dateSet).sort((a, b) => b.localeCompare(a));
  }, [labResults]);

  const { displayRows, sections, displayDate } = useMemo(() => {
    if (selectedDate === null) {
      // "Latest" mode — derive every reading on the most-recent test date
      // straight from labResults. This keeps multiple readings visible when
      // the user uploaded several reports on the same day (previously,
      // labLatest collapsed these to a single entry per canonical name).
      if (!labResults?.length) {
        return { displayRows: [], sections: [], displayDate: "" };
      }
      const latestTestDate = labResults.reduce(
        (max, r) => (r.test_date && r.test_date > max ? r.test_date : max),
        "",
      );
      const rows = latestTestDate
        ? buildHistoricalRows(labResults, latestTestDate.slice(0, 10))
        : [];
      const matchingOrder = latestTestDate
        ? findLabOrderForDate(labOrders, latestTestDate.slice(0, 10))
        : null;
      const secs = buildSections(rows, matchingOrder ? [matchingOrder] : labOrders);
      return { displayRows: rows, sections: secs, displayDate: latestTestDate };
    }
    // Historical mode
    const rows = buildHistoricalRows(labResults, selectedDate);
    const matchingOrder = findLabOrderForDate(labOrders, selectedDate);
    const secs = buildSections(rows, matchingOrder ? [matchingOrder] : []);
    return { displayRows: rows, sections: secs, displayDate: selectedDate };
  }, [selectedDate, labResults, labOrders]);

  const hasResults = displayRows.length > 0;

  return (
    <>
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
      <div className="panel-body">
        {/* Blood Reports */}
        <div className="sc">
          <div className="sch">
            <div className="sct">
              <div className="sci ic-b">🩸</div>Blood Reports
            </div>
            <button className="bx bx-p" onClick={onUploadReport}>
              + Upload Report
            </button>
          </div>
          <div className="scb">
            {labDocs.length > 0 ? (
              labDocs.map((doc, i) => {
                const status = getDocStatus(doc);
                const needsReview = status.kind === "mismatch";
                const isPending = status.kind === "pending";
                return (
                  <div
                    key={doc.id || i}
                    className="report-card"
                    style={{
                      cursor: "pointer",
                      border: needsReview
                        ? "1px solid #fecaca"
                        : isPending
                          ? "1px solid #c4b5fd"
                          : undefined,
                      background: needsReview ? "#fef2f2" : isPending ? "#f5f3ff" : undefined,
                    }}
                    onClick={() => openDoc(doc)}
                  >
                    <div className="report-icon ri-b">{needsReview ? "⚠️" : "🧪"}</div>
                    <div style={{ flex: 1 }}>
                      <div className="report-nm">{doc.title || doc.file_name || "Lab Report"}</div>
                      <div className="report-dt">
                        {fmtDate(doc.doc_date)}
                        {doc.source ? ` · ${doc.source}` : ""}
                        {doc.created_at &&
                        (doc.created_at || "").slice(0, 10) !== (doc.doc_date || "").slice(0, 10)
                          ? ` · Uploaded ${fmtDate(doc.created_at)}`
                          : ""}
                        {cleanNote(doc.notes) ? ` · ${cleanNote(doc.notes)}` : ""}
                      </div>
                      {needsReview && (
                        <>
                          <div
                            style={{
                              fontSize: 11,
                              color: "#b91c1c",
                              fontWeight: 600,
                              marginTop: 3,
                            }}
                            title="Extraction not applied — patient name on doc doesn't match."
                          >
                            ⚠️ Name mismatch — extraction not applied
                          </div>
                          <MismatchActions
                            doc={{ ...doc, patient_id: doc.patient_id || patientId }}
                            patient={patient}
                            compact
                          />
                        </>
                      )}
                    </div>
                    {status.label ? (
                      <DocStatusPill doc={doc} patientId={patientId} size="sm" />
                    ) : (
                      <span
                        className={`report-status ${i === 0 ? "rs-new" : doc.has_abnormal ? "rs-ab" : "rs-ok"}`}
                      >
                        {i === 0 ? "Latest" : doc.has_abnormal ? "Abnormal" : "Normal"}
                      </span>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
                No lab reports uploaded yet
              </div>
            )}
          </div>
        </div>

        {/* Radiology Reports */}
        <div className="sc">
          <div className="sch">
            <div className="sct">
              <div className="sci ic-t">🩻</div>Radiology Reports
            </div>
            <button className="bx bx-p" onClick={onUploadReport}>
              + Upload
            </button>
          </div>
          <div className="scb">
            {radiologyDocs.length > 0 ? (
              radiologyDocs.map((doc, i) => {
                const status = getDocStatus(doc);
                const needsReview = status.kind === "mismatch";
                const isPending = status.kind === "pending";
                return (
                  <div
                    key={doc.id || i}
                    className="report-card"
                    style={{
                      cursor: "pointer",
                      border: needsReview
                        ? "1px solid #fecaca"
                        : isPending
                          ? "1px solid #c4b5fd"
                          : undefined,
                      background: needsReview ? "#fef2f2" : isPending ? "#f5f3ff" : undefined,
                    }}
                    onClick={() => openDoc(doc)}
                  >
                    <div className="report-icon ri-r" style={{ background: "#fff0f5" }}>
                      {needsReview ? "⚠️" : doc.title?.toLowerCase().includes("echo") ? "🫀" : "🫁"}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div className="report-nm">
                        {doc.title || doc.file_name || "Radiology Report"}
                      </div>
                      <div className="report-dt">
                        {fmtDate(doc.doc_date)}
                        {doc.source ? ` · ${doc.source}` : ""}
                        {cleanNote(doc.notes) ? ` · ${cleanNote(doc.notes)}` : ""}
                      </div>
                      {needsReview && (
                        <>
                          <div
                            style={{
                              fontSize: 11,
                              color: "#b91c1c",
                              fontWeight: 600,
                              marginTop: 3,
                            }}
                            title="Extraction not applied — patient name on doc doesn't match."
                          >
                            ⚠️ Name mismatch — extraction not applied
                          </div>
                          <MismatchActions
                            doc={{ ...doc, patient_id: doc.patient_id || patientId }}
                            patient={patient}
                            compact
                          />
                        </>
                      )}
                    </div>
                    {status.label ? (
                      <DocStatusPill doc={doc} patientId={patientId} size="sm" />
                    ) : (
                      <span className="report-status rs-ab">Review</span>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
                No radiology reports
              </div>
            )}
            {/* <div className="addr">
              <span style={{ fontSize: 14, color: "var(--t3)" }}>+</span>
              <span className="addr-lbl">Upload new radiology report</span>
            </div> */}
          </div>
        </div>

        {/* Test Results — latest by default, historical via date pills */}
        {(hasResults || availableDates.length > 0) && (
          <div className="sc">
            <div
              className="sch"
              style={{ flexDirection: "column", alignItems: "stretch", gap: 8, overflow: "hidden" }}
            >
              <div style={{ display: "flex", alignItems: "center" }}>
                <div className="sct">
                  <div className="sci ic-b">📋</div>
                  Test Results
                  {displayDate && (
                    <span
                      style={{ fontSize: 11, color: "var(--t3)", fontWeight: 400, marginLeft: 8 }}
                    >
                      {selectedDate === null ? "Latest — " : ""}
                      {fmtDate(displayDate)}
                    </span>
                  )}
                </div>
              </div>
              {availableDates.length > 1 && (
                <div
                  className="slim-scroll-x"
                  style={{
                    display: "flex",
                    borderRadius: 8,
                    border: "1px solid #e2e8f0",
                    overflowX: "auto",
                    overflowY: "hidden",
                    WebkitOverflowScrolling: "touch",
                    maxWidth: "100%",
                    minWidth: 0,
                  }}
                >
                  {availableDates.map((d, i) => {
                    const isLatest = i === 0;
                    const isActive = isLatest
                      ? selectedDate === null || selectedDate === d
                      : selectedDate === d;
                    return (
                      <button
                        key={d}
                        onClick={() =>
                          setSelectedDate(isLatest && isActive ? null : isActive ? null : d)
                        }
                        style={{
                          padding: "4px 10px",
                          fontSize: 11,
                          fontWeight: 700,
                          border: "none",
                          borderRight: "1px solid #e2e8f0",
                          cursor: "pointer",
                          whiteSpace: "nowrap",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          flexShrink: 0,
                          background: isActive ? "#0f172a" : "white",
                          color: isActive ? "white" : "#64748b",
                          transition: "all 0.15s",
                        }}
                      >
                        {fmtDate(d)}
                        {isLatest && (
                          <span
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: isActive ? "rgba(255,255,255,0.2)" : "#e0f2fe",
                              color: isActive ? "white" : "#0284c7",
                              textTransform: "uppercase",
                              letterSpacing: 0.3,
                            }}
                          >
                            Latest
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="scb">
              {sections.length > 0 ? (
                sections.map((sec, i) => (
                  <PanelBlock
                    key={`${sec.name}-${i}`}
                    name={sec.name}
                    results={sec.results}
                    type={sec.type}
                    labResults={labResults}
                  />
                ))
              ) : (
                <div style={{ fontSize: 13, color: "var(--t3)", padding: 20, textAlign: "center" }}>
                  No results for this date
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
});

export default VisitLabsPanel;
