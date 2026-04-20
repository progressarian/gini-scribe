import { memo, useCallback, useMemo, useState } from "react";
import { fmtDate } from "./helpers";
import PdfViewerModal from "./PdfViewerModal";
import { LAB_PANELS as PANELS } from "../../config/labOrder";
import { getFallbackRange } from "../../config/labRanges";

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

// ── Row ───────────────────────────────────────────────────────────────────────
function ResultRow({ r }) {
  const isAbnormal = r.flag === "HIGH" || r.flag === "LOW";
  const fallbackRange = r.ref_range ? null : getFallbackRange(r.canonical, r.test_name);
  const displayRange = r.ref_range || fallbackRange || "";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "2fr 1fr 1fr 1fr",
        padding: "7px 14px",
        borderTop: "1px solid var(--border)",
        gap: 6,
        fontSize: 12,
        background: isAbnormal ? "rgba(220,53,69,0.04)" : undefined,
      }}
    >
      <span style={{ fontWeight: 500, color: "var(--text)" }}>{formatTestName(r.test_name)}</span>
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
  );
}

// ── Panel block ───────────────────────────────────────────────────────────────
function PanelBlock({ name, results, type }) {
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
        <ResultRow key={r.id ?? `${r.canonical}-${i}`} r={r} />
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
  labResults,
  labLatest,
  labOrders,
  onUploadReport,
}) {
  const [viewingDoc, setViewingDoc] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null); // null = "Latest"

  const labDocs = documents.filter(
    (d) => d.doc_type === "lab_report" || d.doc_type === "blood_test",
  );
  const radiologyDocs = documents.filter(
    (d) => d.doc_type === "imaging" || d.doc_type === "radiology",
  );

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
      const rows = latestTestDate ? buildHistoricalRows(labResults, latestTestDate.slice(0, 10)) : [];
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
              labDocs.map((doc, i) => (
                <div
                  key={doc.id || i}
                  className="report-card"
                  style={{ cursor: "pointer" }}
                  onClick={() => openDoc(doc)}
                >
                  <div className="report-icon ri-b">🧪</div>
                  <div style={{ flex: 1 }}>
                    <div className="report-nm">{doc.title || doc.file_name || "Lab Report"}</div>
                    <div className="report-dt">
                      {fmtDate(doc.doc_date)}
                      {doc.source ? ` · ${doc.source}` : ""}
                      {doc.created_at &&
                      (doc.created_at || "").slice(0, 10) !== (doc.doc_date || "").slice(0, 10)
                        ? ` · Uploaded ${fmtDate(doc.created_at)}`
                        : ""}
                      {doc.notes ? ` · ${doc.notes}` : ""}
                    </div>
                  </div>
                  <span
                    className={`report-status ${i === 0 ? "rs-new" : doc.has_abnormal ? "rs-ab" : "rs-ok"}`}
                  >
                    {i === 0 ? "Latest" : doc.has_abnormal ? "Abnormal" : "Normal"}
                  </span>
                </div>
              ))
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
              radiologyDocs.map((doc, i) => (
                <div
                  key={doc.id || i}
                  className="report-card"
                  style={{ cursor: "pointer" }}
                  onClick={() => openDoc(doc)}
                >
                  <div className="report-icon ri-r" style={{ background: "#fff0f5" }}>
                    {doc.title?.toLowerCase().includes("echo") ? "🫀" : "🫁"}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="report-nm">
                      {doc.title || doc.file_name || "Radiology Report"}
                    </div>
                    <div className="report-dt">
                      {fmtDate(doc.doc_date)}
                      {doc.source ? ` · ${doc.source}` : ""}
                      {doc.notes ? ` · ${doc.notes}` : ""}
                    </div>
                  </div>
                  <span className="report-status rs-ab">Review</span>
                </div>
              ))
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
