import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
// xlsx is lazy-loaded inside the Excel-upload handler below to keep it out
// of the main bundle (~900 KB pre-gzip). Nothing else in this file touches it.
import { extractLab, extractImaging, extractRx } from "./services/extraction.js";
import usePatientStore from "./stores/patientStore.js";
import PdfViewerModal from "./components/visit/PdfViewerModal.jsx";
import LiveDashboard from "./components/opd/LiveDashboard.jsx";
import OpdRangeReport from "./components/opd/OpdRangeReport.jsx";
import TriageView from "./components/opd/TriageView.jsx";
import DocStatusPill from "./components/ui/DocStatusPill.jsx";
import ConfirmModal from "./components/ui/ConfirmModal.jsx";
import { useOpdAppointments } from "./queries/hooks/useOpdAppointments.js";
import { qk } from "./queries/keys.js";
import { useIsMobile } from "./hooks/useIsMobile.js";
import { classifyComposite } from "./utils/biomarkerClassify.js";
import { cleanNote } from "./utils/cleanNote.js";
import "./OPD.css";

// ─── Inject fonts ────────────────────────────────────────────
if (!document.getElementById("opd-fonts")) {
  const l = document.createElement("link");
  l.id = "opd-fonts";
  l.rel = "stylesheet";
  l.href =
    "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&family=DM+Mono:wght@400;500&display=swap";
  document.head.appendChild(l);
}

const API_URL = import.meta.env.VITE_API_URL || "";

// ─── Tokens ──────────────────────────────────────────────────
const T = "#009e8c",
  TL = "#e6f6f4",
  TB = "rgba(0,158,140,.22)";
const NV = "#0e2240";
const BG = "#f0f4f7",
  WH = "#fff";
const INK = "#1a2332",
  INK2 = "#3d4f63",
  INK3 = "#6b7d90";
const BD = "#dde3ea",
  BD2 = "#c4cdd8";
const RE = "#d94f4f",
  REL = "#fdf0f0",
  REB = "rgba(217,79,79,.2)";
const AM = "#d97a0a",
  AML = "#fef6e6",
  AMB = "rgba(217,122,10,.2)";
const GN = "#15803d",
  GNL = "#edfcf0",
  GNB = "rgba(21,128,61,.2)";
const SK = "#2563eb",
  SKL = "#eff6ff",
  SKB = "rgba(37,99,235,.2)";
const SH = "0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05)";

const FB = "'Inter',system-ui,sans-serif";
const FD = "'Instrument Serif',serif";
const FM = "'DM Mono',monospace";

const getToken = () => localStorage.getItem("gini_auth_token") || "";
const getDoctor = () => {
  try {
    return JSON.parse(localStorage.getItem("gini_doctor") || "null");
  } catch {
    return null;
  }
};

function apiFetch(path, opts = {}) {
  return fetch(`${API_URL}${path}`, {
    ...opts,
    headers: {
      "x-auth-token": getToken(),
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}
function apiFetchRaw(path, opts = {}) {
  return fetch(`${API_URL}${path}`, {
    ...opts,
    headers: { "x-auth-token": getToken(), ...(opts.headers || {}) },
  });
}

// ─── Shimmer skeleton ────────────────────────────────────────
if (!document.getElementById("opd-shimmer-style")) {
  const s = document.createElement("style");
  s.id = "opd-shimmer-style";
  s.textContent = `@keyframes opdShimmer { 0% { background-position: -400px 0 } 100% { background-position: 400px 0 } }`;
  document.head.appendChild(s);
}
function Shimmer({ w = "100%", h = 12, r = 6, style = {} }) {
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: r,
        background: `linear-gradient(90deg, ${BG} 0%, #e5ebf1 50%, ${BG} 100%)`,
        backgroundSize: "800px 100%",
        animation: "opdShimmer 1.2s linear infinite",
        ...style,
      }}
    />
  );
}
function TabShimmer({ rows = 4 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          boxShadow: SH,
        }}
      >
        <Shimmer w={140} h={14} style={{ marginBottom: 12 }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Shimmer key={i} w={72} h={26} r={8} />
          ))}
        </div>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "10px 0",
              borderTop: i === 0 ? "none" : `1px solid ${BD}`,
            }}
          >
            <Shimmer w={36} h={36} r={8} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <Shimmer w="55%" h={11} />
              <Shimmer w="35%" h={9} />
            </div>
            <Shimmer w={60} h={22} r={6} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────
function bioS(key, val) {
  if (!val && val !== 0) return "m";
  const R = {
    hba1c: [
      [0, 7, "g"],
      [7, 9, "a"],
      [9, 99, "r"],
    ],
    fg: [
      [0, 100, "g"],
      [100, 126, "a"],
      [126, 999, "r"],
    ],
    bpSys: [
      [0, 130, "g"],
      [130, 140, "a"],
      [140, 999, "r"],
    ],
    ldl: [
      [0, 100, "g"],
      [100, 130, "a"],
      [130, 999, "r"],
    ],
    tg: [
      [0, 150, "g"],
      [150, 200, "a"],
      [200, 999, "r"],
    ],
    uacr: [
      [0, 30, "g"],
      [30, 300, "a"],
      [300, 999, "r"],
    ],
  };
  for (const [lo, hi, c] of R[key] || [[0, 999, "m"]]) if (val >= lo && val < hi) return c;
  return "m";
}
const BC = { g: GN, a: AM, r: RE, m: INK3 };

function catLabel(c) {
  return (
    { complex: "Uncontrolled", maint: "Maintenance", ctrl: "Continuous Care", new: "New Patient" }[
      c
    ] || ""
  );
}
function catIcon(c) {
  return { complex: "⚠", maint: "↑", ctrl: "✓", new: "★" }[c] || "";
}
function catSty(c) {
  return (
    {
      complex: { background: REL, color: RE },
      maint: { background: AML, color: AM },
      ctrl: { background: GNL, color: GN },
      new: { background: "#fffbeb", color: "#b45309" },
    }[c] || { background: BG, color: INK3 }
  );
}

// AI-suggested category derived from biomarkers when the user hasn't set one.
// Mirrors the logic in CategorizeTab so the row badge and the modal agree:
//   HbA1c > 9 → complex (Uncontrolled)
//   HbA1c > 7 → maint   (Maintenance)
//   HbA1c ≤ 7 → ctrl    (Continuous Care)
//   New-Patient visit type → new
//   No HbA1c and not a new-patient visit → null (can't suggest)
function aiSuggestedCategory(a) {
  const h = parseFloat(a?.biomarkers?.hba1c);
  if (!isNaN(h)) {
    if (h > 9) return "complex";
    if (h > 7) return "maint";
    return "ctrl";
  }
  if (a?.visit_type === "New Patient") return "new";
  return null;
}

// Effective category for filtering & display: the manually-saved category
// if present, otherwise the AI suggestion. Returns null if neither exists.
function effectiveCategory(a) {
  return a?.category || aiSuggestedCategory(a);
}

function stepsDone(a) {
  const ps = a.prep_steps || {};
  return [ps.biomarkers, ps.compliance, ps.categorized, ps.assigned].filter(Boolean).length;
}
function isReady(a) {
  const ps = a.prep_steps || {};
  return !!(ps.biomarkers && ps.compliance && ps.categorized && ps.assigned);
}

function statusSty(s) {
  if (s === "seen" || s === "completed")
    return { dot: "#22c55e", label: "Seen", bg: GNL, color: GN };
  if (s === "in_visit")
    return { dot: "#8b5cf6", label: "In Visit", bg: "#f5f3ff", color: "#7c3aed" };
  if (s === "checkedin") return { dot: SK, label: "Checked In", bg: SKL, color: SK };
  if (s === "prepped") return { dot: T, label: "Ready", bg: TL, color: T };
  if (s === "no_show") return { dot: BD2, label: "No Show", bg: BG, color: INK3 };
  return { dot: BD2, label: "Pending", bg: BG, color: INK3 };
}

// ── Wait timer: minutes since check-in ──
function WaitTime({ checkedInAt }) {
  const [mins, setMins] = React.useState(0);
  React.useEffect(() => {
    if (!checkedInAt) return;
    const calc = () =>
      Math.max(0, Math.floor((Date.now() - new Date(checkedInAt).getTime()) / 60000));
    setMins(calc());
    const id = setInterval(() => setMins(calc()), 30000);
    return () => clearInterval(id);
  }, [checkedInAt]);
  if (!checkedInAt) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const label = h > 0 ? `${h}h ${m}m` : `${m}m`;
  const color = mins >= 45 ? RE : mins >= 20 ? AM : GN;
  return (
    <span style={{ fontFamily: FM, fontSize: 10, fontWeight: 600, color, marginLeft: 4 }}>
      ⏱ {label}
    </span>
  );
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function daysSince(d) {
  if (!d) return null;
  const diff = Math.round((Date.now() - new Date(d)) / 86400000);
  return diff >= 0 ? diff : null;
}

// Color based on how far through the scheduled interval the patient is.
// gap = appointment_date - last_visit_date (what the doctor intended).
// since = days elapsed since last_visit_date (how long they actually waited).
// <80% of gap → green (still within window), 80–110% → amber (due soon/just due), >110% → red (overdue).
function visitGapColor(lastVisitDate, appointmentDate) {
  if (!lastVisitDate || !appointmentDate) return INK3;
  const gap = Math.round((new Date(appointmentDate) - new Date(lastVisitDate)) / 86400000);
  const since = daysSince(lastVisitDate);
  if (since === null || gap <= 0) return INK3;
  const ratio = since / gap;
  if (ratio < 0.8) return GN;
  if (ratio <= 1.1) return AM;
  return RE;
}

function bmiColor(bmi) {
  if (!bmi) return INK3;
  if (bmi < 18.5) return SK;
  if (bmi < 25) return GN;
  if (bmi < 30) return AM;
  return RE;
}

// ─── Small UI atoms ──────────────────────────────────────────
function SLbl({ children, action }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 9 }}>
      <span
        style={{
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: ".12em",
          textTransform: "uppercase",
          color: INK3,
          whiteSpace: "nowrap",
        }}
      >
        {children}
      </span>
      <div style={{ flex: 1, height: 1, background: BD }} />
      {action}
    </div>
  );
}

function Lbl({ children }) {
  return (
    <label
      style={{
        fontSize: 10,
        fontWeight: 600,
        color: INK3,
        textTransform: "uppercase",
        letterSpacing: ".06em",
        display: "block",
        marginBottom: 5,
      }}
    >
      {children}
    </label>
  );
}

function Inp({ value, onChange, placeholder, type = "text", style = {} }) {
  return (
    <input
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      style={{
        border: `1px solid ${BD}`,
        borderRadius: 7,
        padding: "8px 11px",
        fontSize: 13,
        color: INK,
        outline: "none",
        background: WH,
        width: "100%",
        fontFamily: FB,
        ...style,
      }}
    />
  );
}

function Chip({ label, color, bg }) {
  return (
    <span
      style={{
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        padding: "2px 6px",
        borderRadius: 4,
        background: bg,
        color,
      }}
    >
      {label}
    </span>
  );
}

// ─── Visit type chip ─────────────────────────────────────────
function VisitChip({ a }) {
  if (a.is_walkin) return <Chip label="Walk-In" color={AM} bg={AML} />;
  if (a.visit_type === "New Patient") return <Chip label="New" color="#b45309" bg="#fffbeb" />;
  if (a.visit_type === "Follow-Up") return <Chip label="Follow-Up" color={SK} bg={SKL} />;
  if (a.visit_type === "Emergency") return <Chip label="Urgent" color={RE} bg={REL} />;
  if (a.visit_type === "Online") return <Chip label="Online" color="#6d28d9" bg="#f5f3ff" />;
  return <Chip label={a.visit_type || "OPD"} color={INK3} bg={BG} />;
}

// ══════════════════════════════════════════════════════════════
// APPOINTMENT ROW
// ══════════════════════════════════════════════════════════════
function ApptRow({ a, sel, onSelect }) {
  const bio = a.biomarkers || {},
    ps = a.prep_steps || {},
    ss = statusSty(a.status);
  const done = stepsDone(a),
    isSel = sel?.id === a.id;
  const ds = daysSince(a.last_visit_date);

  return (
    <div
      data-appt-id={a.id}
      onClick={() => onSelect(a)}
      style={{
        display: "flex",
        padding: "10px 14px",
        borderBottom: `1px solid rgba(0,0,0,.04)`,
        cursor: "pointer",
        alignItems: "flex-start",
        opacity:
          a.status === "seen" || a.status === "completed"
            ? 0.6
            : a.status === "in_visit"
              ? 0.85
              : 1,
        background: isSel ? TL : "transparent",
        borderLeft: isSel ? `3px solid ${T}` : "3px solid transparent",
        transition: "background .1s",
      }}
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: 11,
          color: INK3,
          width: 46,
          flexShrink: 0,
          paddingTop: 2,
        }}
      >
        {a.time_slot || "—"}
      </div>
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          flexShrink: 0,
          margin: "5px 10px 0",
          background: ss.dot,
          boxShadow: a.status && a.status !== "pending" ? `0 0 5px ${ss.dot}` : "none",
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Name */}
        <div
          style={{
            fontFamily: FD,
            fontSize: 15,
            fontWeight: 700,
            color: INK,
            lineHeight: 1.2,
            marginBottom: 2,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {a.patient_name || "—"}
        </div>

        {/* Age · Sex · File no — always shown */}
        <div style={{ fontFamily: FM, fontSize: 10, color: INK3, marginBottom: 3 }}>
          {`${a.age ? a.age + "Y" : "—"} · ${a.sex || "—"} · ${a.file_no || "—"}`}
        </div>

        {/* Visit # + chips */}
        <div
          style={{
            display: "flex",
            gap: 4,
            alignItems: "center",
            flexWrap: "wrap",
            marginBottom: 3,
          }}
        >
          {a.visit_count && (
            <span style={{ fontFamily: FM, fontSize: 9, fontWeight: 600, color: SK }}>
              Visit #{a.visit_count}
            </span>
          )}
          <VisitChip a={a} />
          {a.category ? (
            <span
              style={{
                fontSize: 8,
                padding: "2px 7px",
                borderRadius: 9,
                fontWeight: 700,
                ...catSty(a.category),
              }}
            >
              {catIcon(a.category)} {catLabel(a.category)}
            </span>
          ) : (
            (() => {
              // Show the AI suggestion as a dashed/outlined badge so it's
              // visually distinct from a confirmed category — same colour
              // family, but reads as "suggested, not assigned yet".
              const ai = aiSuggestedCategory(a);
              if (!ai) return null;
              const sty = catSty(ai);
              return (
                <span
                  title={`AI suggestion based on HbA1c ${a?.biomarkers?.hba1c ?? "—"}`}
                  style={{
                    fontSize: 8,
                    padding: "1px 6px",
                    borderRadius: 9,
                    fontWeight: 700,
                    background: "transparent",
                    color: sty.color,
                    border: `1px dashed ${sty.color}`,
                    opacity: 0.85,
                  }}
                >
                  ✨ {catIcon(ai)} {catLabel(ai)}
                </span>
              );
            })()
          )}
        </div>

        {/* Last visit */}
        {a.last_visit_date && (
          <div style={{ fontSize: 9, color: INK3, fontFamily: FB, marginBottom: 2 }}>
            📅 {fmtDate(a.last_visit_date)}
            {ds !== null ? (
              <span
                style={{
                  color: visitGapColor(a.last_visit_date, a.appointment_date),
                  fontWeight: 500,
                }}
              >
                {" "}
                · {ds} days since last visit
              </span>
            ) : null}
          </div>
        )}

        {/* Labs row */}
        <div
          style={{
            display: "flex",
            gap: 7,
            fontSize: 10,
            fontFamily: FM,
            marginTop: 1,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {bio.hba1c ? (
            <span style={{ color: BC[bioS("hba1c", bio.hba1c)] }}>HbA1c {bio.hba1c}%</span>
          ) : (
            <span style={{ color: AM, fontSize: 9 }}>⚠ No labs</span>
          )}
          {bio.fg && <span style={{ color: BC[bioS("fg", bio.fg)] }}>FG {bio.fg}</span>}
          {bio.bp && <span style={{ color: INK3 }}>BP {bio.bp}</span>}
          {/* Trajectory indicator */}
          {bio.hba1c &&
            a.prev_hba1c != null &&
            (() => {
              const curr = parseFloat(bio.hba1c);
              const prev = parseFloat(a.prev_hba1c);
              if (isNaN(prev)) return null;
              const improving = curr < prev;
              const worsening = curr > prev;
              if (improving)
                return (
                  <span style={{ color: GN, fontWeight: 700, fontSize: 9 }}>↓ from {prev}%</span>
                );
              if (worsening)
                return (
                  <span style={{ color: RE, fontWeight: 700, fontSize: 9 }}>↑ from {prev}%</span>
                );
              // Stable — but context matters
              if (curr > 9)
                return (
                  <span style={{ color: RE, fontWeight: 700, fontSize: 9 }}>
                    ⚠ stuck at {curr}%
                  </span>
                );
              if (curr > 7)
                return (
                  <span style={{ color: AM, fontWeight: 700, fontSize: 9 }}>→ not improving</span>
                );
              return <span style={{ color: GN, fontWeight: 700, fontSize: 9 }}>✓ at target</span>;
            })()}
          {/* Lab status tags */}
          {a.pending_labs > 0 && (
            <span
              style={{
                background: SKL,
                color: SK,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 5px",
                borderRadius: 4,
                border: `1px solid ${SKB}`,
              }}
            >
              🔬 Gini Lab Processing
            </span>
          )}
          {a.partial_labs > 0 && (
            <span
              style={{
                background: AML,
                color: AM,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 5px",
                borderRadius: 4,
                border: `1px solid ${AMB}`,
              }}
            >
              🟡 Gini Lab Partial
            </span>
          )}
          {a.recent_labs > 0 && (
            <span
              style={{
                background: GNL,
                color: GN,
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 5px",
                borderRadius: 4,
                border: `1px solid ${GNB}`,
              }}
            >
              ✅ Gini Lab Received
            </span>
          )}
          {a.uploaded_labs > 0 && (
            <span
              style={{
                background: "#f5f3ff",
                color: "#7c3aed",
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 5px",
                borderRadius: 4,
                border: "1px solid #ddd6fe",
              }}
            >
              📄 Lab Uploaded
              {a.uploaded_labs_date
                ? ` · ${new Date(a.uploaded_labs_date).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`
                : ""}
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-end",
          gap: 4,
          flexShrink: 0,
          marginLeft: 8,
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 4,
            background: ss.bg,
            color: ss.color,
            display: "flex",
            alignItems: "center",
            gap: 3,
          }}
        >
          {ss.label}
          {(a.status === "checkedin" || a.status === "in_visit") && (
            <WaitTime checkedInAt={a.checked_in_at} />
          )}
        </span>
        <div style={{ display: "flex", gap: 2 }}>
          {["biomarkers", "compliance", "categorized", "assigned"].map((k) => (
            <div
              key={k}
              title={k}
              style={{ width: 6, height: 6, borderRadius: "50%", background: ps[k] ? T : BD2 }}
            />
          ))}
        </div>
        <span style={{ fontSize: 8, color: INK3, fontFamily: FM }}>{done}/4</span>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// DOCTOR SECTION (collapsible)
// ══════════════════════════════════════════════════════════════
function DocSection({ docName, appts, selAppt, onSelect, filterStatus }) {
  const [open, setOpen] = useState(true);
  const seen = appts.filter((a) => a.status === "seen" || a.status === "completed").length;
  const showSeen = filterStatus === "all" || filterStatus === "seen";
  const initials =
    docName
      .replace(/^Dr\.\s*/i, "")
      .split(" ")
      .map((w) => w[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "D";
  const pct = Math.round((seen / appts.length) * 100) || 0;
  return (
    <div style={{ borderBottom: `1px solid ${BD}` }}>
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "9px 14px",
          display: "flex",
          alignItems: "center",
          gap: 9,
          cursor: "pointer",
          background: WH,
          borderBottom: `1px solid rgba(0,0,0,.04)`,
          position: "sticky",
          top: 0,
          zIndex: 5,
        }}
      >
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: "50%",
            background: SKL,
            color: SK,
            border: `2px solid ${SKB}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: INK }}>{docName}</div>
          <div
            style={{ fontSize: 9, color: INK3, textTransform: "uppercase", letterSpacing: ".07em" }}
          >
            {appts.length} patients
            {showSeen && (
              <>
                {" · "}
                <span style={{ color: GN, fontWeight: 600 }}>{seen} seen</span>
              </>
            )}
          </div>
        </div>
        <div
          style={{
            height: 3,
            background: BD,
            borderRadius: 2,
            overflow: "hidden",
            width: 48,
            marginRight: 6,
          }}
        >
          <div style={{ height: "100%", background: T, borderRadius: 2, width: `${pct}%` }} />
        </div>
        <span
          style={{
            fontSize: 9,
            color: INK3,
            display: "inline-block",
            transition: "transform .2s",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          ▶
        </span>
      </div>
      {open && appts.map((a) => <ApptRow key={a.id} a={a} sel={selAppt} onSelect={onSelect} />)}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EMPTY STATE
// ══════════════════════════════════════════════════════════════
function EmptyState({ onNew, onImport, onDashboard, stats }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 0,
        padding: 32,
      }}
    >
      <div
        style={{
          display: "grid",
          // Auto-fit lets the grid drop columns naturally at narrower widths:
          // 7-up on desktop, 4-up on tablet, 2-up on phone — no media queries
          // needed. minmax(120px, 1fr) keeps each card legible at any density.
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 9,
          width: "100%",
          maxWidth: 920,
          marginBottom: 24,
        }}
      >
        {[
          { ico: "📋", val: stats.total, l: "Total", c: INK },
          { ico: "⏳", val: stats.pending, l: "Pending", c: stats.pending ? AM : INK3 },
          { ico: "🔵", val: stats.checkedin, l: "Checked In", c: stats.checkedin ? SK : INK3 },
          { ico: "🩺", val: stats.in_visit, l: "In Visit", c: stats.in_visit ? "#7c3aed" : INK3 },
          { ico: "✅", val: stats.seen, l: "Seen", c: stats.seen ? GN : INK3 },
          { ico: "🚫", val: stats.no_show, l: "No-Show", c: stats.no_show ? RE : INK3 },
          { ico: "❌", val: stats.cancelled, l: "Cancelled", c: stats.cancelled ? INK2 : INK3 },
        ].map((s) => (
          <div
            key={s.l}
            style={{
              background: WH,
              border: `1px solid ${BD}`,
              borderRadius: 10,
              padding: "14px 16px",
              boxShadow: SH,
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 24 }}>{s.ico}</div>
            <div>
              <div
                style={{ fontFamily: FM, fontSize: 26, fontWeight: 500, color: s.c, lineHeight: 1 }}
              >
                {s.val}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: INK3,
                  fontWeight: 600,
                  marginTop: 3,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                }}
              >
                {s.l}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ textAlign: "center", color: INK3, marginBottom: 20 }}>
        <div style={{ fontSize: 13, lineHeight: 1.7, marginBottom: 4 }}>
          Select an appointment to open the pre-visit workflow
        </div>
        <div style={{ fontSize: 12, color: T, fontWeight: 600 }}>
          Labs → Compliance → Categorize → Assign → Check In → Vitals
        </div>
      </div>
      <div style={{ display: "flex", gap: 9, flexWrap: "wrap", justifyContent: "center" }}>
        <button
          onClick={onDashboard}
          style={{
            padding: "9px 20px",
            borderRadius: 8,
            background: T,
            color: "#fff",
            border: "none",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: FB,
            boxShadow: "0 2px 8px rgba(0,158,140,.3)",
          }}
        >
          📊 View Live Dashboard
        </button>
        <button
          onClick={onNew}
          style={{
            padding: "9px 20px",
            borderRadius: 8,
            background: WH,
            color: INK2,
            border: `1px solid ${BD}`,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: FB,
          }}
        >
          + New Appointment
        </button>
        <button
          onClick={onImport}
          style={{
            padding: "9px 20px",
            borderRadius: 8,
            background: WH,
            color: INK2,
            border: `1px solid ${BD}`,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: FB,
          }}
        >
          📊 Import from Excel
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// OVERVIEW TAB
// ══════════════════════════════════════════════════════════════
function OverviewTab({ appt, setTab, onCheckIn }) {
  const done = stepsDone(appt),
    pct = Math.round((done / 4) * 100),
    ready = isReady(appt);
  const ps = appt.prep_steps || {},
    bio = appt.biomarkers || {},
    comp = appt.compliance || {},
    vitals = appt.opd_vitals || {};

  // Check if this appointment has HealthRay synced data
  const hasRayData = !!appt.healthray_id;

  const VitalChip = ({ label, value }) =>
    value ? (
      <span
        style={{
          display: "inline-block",
          padding: "4px 10px",
          borderRadius: 6,
          fontSize: 11,
          fontWeight: 500,
          fontFamily: FM,
          background: "#e8f5e9",
          color: "#2e7d32",
          border: "1px solid #c8e6c9",
        }}
      >
        {label}: {value}
      </span>
    ) : null;

  // ── Shared: diagnoses chip block (shown in both hasRayData and default views) ──
  const dxChips = (() => {
    const dxList = appt.healthray_diagnoses || [];
    if (!dxList.length) return null;
    return (
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: INK3,
            letterSpacing: ".07em",
            textTransform: "uppercase",
            marginBottom: 8,
          }}
        >
          Diagnoses
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {dxList.map((dx, i) => {
            const absent = dx.status === "Absent";
            const present = dx.status === "Present";
            const sign = absent ? "-" : present ? "+" : "?";
            const label = `${dx.name}${dx.details ? `(${dx.details})` : ""}(${sign})`;
            return (
              <span
                key={i}
                style={{
                  padding: "3px 9px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  background: TL,
                  color: INK2,
                  border: `1px solid ${BD}`,
                  fontFamily: FM,
                }}
              >
                {label}
              </span>
            );
          })}
        </div>
      </div>
    );
  })();

  // ── HealthRay synced appointment view ──
  if (hasRayData) {
    return (
      <div>
        {/* Appointment info banner */}
        <div
          style={{
            borderRadius: 9,
            padding: "13px 16px",
            marginBottom: 12,
            display: "flex",
            alignItems: "center",
            gap: 13,
            background: "#e3f2fd",
            border: "1px solid #90caf9",
            boxShadow: SH,
          }}
        >
          <div style={{ fontSize: 22, flexShrink: 0 }}>📋</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1565c0", marginBottom: 2 }}>
              {bio.reason || appt.visit_type || "OPD"}{" "}
              {bio.appointmentNumber ? `· ${bio.appointmentNumber}` : ""}
            </div>
            <div style={{ fontSize: 11, color: INK3 }}>
              {appt.doctor_name} {bio.rmo ? ` | RMO: ${bio.rmo}` : ""}
            </div>
          </div>
          <span
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 11,
              fontWeight: 600,
              background: appt.status === "completed" ? GNL : AML,
              color: appt.status === "completed" ? GN : AM,
              border: `1px solid ${appt.status === "completed" ? GNB : AMB}`,
            }}
          >
            {appt.status === "completed" ? "Checkout" : appt.status}
          </span>
        </div>

        {/* Vitals */}
        {(vitals.weight || vitals.height || vitals.bpSys || vitals.pulse || vitals.waist) && (
          <div
            style={{
              background: WH,
              border: `1px solid ${BD}`,
              borderRadius: 10,
              padding: 14,
              marginBottom: 12,
              boxShadow: SH,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                marginBottom: 10,
                gap: 8,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>VITALS</div>
              {(vitals._source === "healthray" || hasRayData) && (
                <div style={{ fontSize: 10, color: INK3, fontWeight: 500 }}>
                  From HealthRay
                  {vitals._prescriptionDate ? ` · ${fmtDate(vitals._prescriptionDate)}` : ""}
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <VitalChip label="Height" value={vitals.height ? `${vitals.height} cm` : null} />
              <VitalChip label="Weight" value={vitals.weight ? `${vitals.weight} kg` : null} />
              <VitalChip label="BMI" value={vitals.bmi ? vitals.bmi.toFixed(2) : null} />
              <VitalChip
                label="BP"
                value={vitals.bpSys ? `${vitals.bpSys}/${vitals.bpDia}` : null}
              />
              <VitalChip label="SpO2" value={vitals.spo2} />
              <VitalChip label="Waist" value={vitals.waist ? `${vitals.waist} cm` : null} />
              <VitalChip label="Body Fat" value={vitals.bodyFat ? `${vitals.bodyFat}%` : null} />
              <VitalChip label="Pulse" value={vitals.pulse ? `${vitals.pulse} bpm` : null} />
              <VitalChip
                label="Muscle"
                value={vitals.muscleMass ? `${vitals.muscleMass} kg` : null}
              />
              <VitalChip
                label="BP (standing)"
                value={
                  vitals.bpStandingSys ? `${vitals.bpStandingSys}/${vitals.bpStandingDia}` : null
                }
              />
            </div>
          </div>
        )}

        {dxChips}

        {/* Follow-up */}
        {bio.followup && (
          <div
            style={{
              background: WH,
              border: `1px solid ${BD}`,
              borderRadius: 10,
              padding: 14,
              marginBottom: 12,
              boxShadow: SH,
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>FOLLOW UP:</div>
            <span
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                fontSize: 12,
                fontWeight: 600,
                background: "#fff3e0",
                color: "#e65100",
                border: "1px solid #ffcc80",
              }}
            >
              {bio.followup}
            </span>
          </div>
        )}

        {/* Notes */}
        {cleanNote(appt.notes) && (
          <div
            style={{
              background: WH,
              border: `1px solid ${BD}`,
              borderRadius: 10,
              padding: 14,
              marginBottom: 12,
              boxShadow: SH,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 6 }}>
              APPOINTMENT INFO
            </div>
            <div style={{ fontSize: 12, color: INK3, lineHeight: 1.6 }}>
              {cleanNote(appt.notes)}
            </div>
          </div>
        )}

        {/* Check In button */}
        {appt.status !== "checkedin" &&
          appt.status !== "seen" &&
          appt.status !== "completed" &&
          appt.status !== "in_visit" && (
            <button
              onClick={onCheckIn}
              style={{
                width: "100%",
                padding: "10px 14px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                background: SK,
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              ✓ Check In Patient
            </button>
          )}
      </div>
    );
  }

  // ── Default prep workflow (non-synced appointments) ──
  const steps = [
    {
      k: "biomarkers",
      ico: "🧪",
      t: "Biomarkers & Reports",
      d: bio.hba1c
        ? `HbA1c ${bio.hba1c}% · FG ${bio.fg || "—"} · BP ${bio.bp || "—"}`
        : "No lab values yet",
      tab: "biomarkers",
    },
    {
      k: "compliance",
      ico: "💊",
      t: "Compliance & Lifestyle",
      d:
        comp.medPct != null
          ? `${comp.medPct}% medication · ${comp.exercise || "—"}`
          : "Not filled in yet",
      tab: "compliance",
    },
    {
      k: "categorized",
      ico: "🏷",
      t: "Patient Category",
      d: appt.category ? `${catIcon(appt.category)} ${catLabel(appt.category)}` : "Not categorized",
      tab: "categorize",
    },
    {
      k: "assigned",
      ico: "👨‍⚕️",
      t: "Doctor Assignment",
      d: appt.doctor_name || "Not assigned",
      tab: "categorize",
    },
  ];
  return (
    <div>
      {dxChips}
      {/* Readiness banner */}
      <div
        style={{
          borderRadius: 9,
          padding: "13px 16px",
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          gap: 13,
          background: ready ? GNL : done > 0 ? AML : BG,
          border: `1px solid ${ready ? GNB : done > 0 ? AMB : BD}`,
          boxShadow: SH,
        }}
      >
        <div style={{ fontSize: 26, flexShrink: 0 }}>{ready ? "✅" : done > 0 ? "📋" : "⏳"}</div>
        <div style={{ flex: 1 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 2,
              color: ready ? GN : done > 0 ? AM : INK3,
            }}
          >
            {ready
              ? "Patient ready for visit"
              : done > 0
                ? `${done} of 4 prep steps complete`
                : "Preparation not started"}
          </div>
          <div style={{ fontSize: 11, color: INK3, lineHeight: 1.5 }}>
            {ready
              ? "All prep done — check in when patient arrives."
              : "Complete remaining steps before the visit."}
          </div>
        </div>
        {ready &&
          appt.status !== "checkedin" &&
          appt.status !== "in_visit" &&
          appt.status !== "seen" &&
          appt.status !== "completed" && (
            <button
              onClick={onCheckIn}
              style={{
                padding: "8px 14px",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 600,
                background: SK,
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontFamily: FB,
                flexShrink: 0,
              }}
            >
              ✓ Check In
            </button>
          )}
      </div>

      {/* Prep checklist */}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 9,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>Pre-Visit Preparation</div>
          <div style={{ fontSize: 11, color: INK3, fontFamily: FM }}>
            {done}/4 · {pct}%
          </div>
        </div>
        <div
          style={{
            height: 5,
            background: BG,
            borderRadius: 3,
            overflow: "hidden",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              height: "100%",
              background: T,
              borderRadius: 3,
              width: `${pct}%`,
              transition: "width .4s",
            }}
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {steps.map((s) => (
            <div
              key={s.k}
              onClick={() => setTab(s.tab)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                cursor: "pointer",
                background: ps[s.k] ? GNL : BG,
                border: `1px solid ${ps[s.k] ? GNB : BD}`,
                borderRadius: 8,
                transition: "all .15s",
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: `2px solid ${ps[s.k] ? GN : BD2}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  flexShrink: 0,
                  background: ps[s.k] ? GN : WH,
                  color: ps[s.k] ? "#fff" : INK3,
                }}
              >
                {ps[s.k] ? "✓" : ""}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: ps[s.k] ? GN : INK }}>
                  {s.ico} {s.t}
                </div>
                <div style={{ fontSize: 10, color: INK3, marginTop: 1 }}>{s.d}</div>
              </div>
              {!ps[s.k] ? (
                <span style={{ fontSize: 10, fontWeight: 600, color: T }}>Fill →</span>
              ) : (
                <span style={{ fontSize: 10, color: GN }}>Done</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {bio.hba1c && (
        <div
          style={{
            background: WH,
            border: `1px solid ${BD}`,
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
            boxShadow: SH,
          }}
        >
          <SLbl>Key Biomarkers</SLbl>
          <div
            className="opd-biomarker-grid"
            style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}
          >
            {[
              ["HbA1c", bio.hba1c, "%", "hba1c"],
              ["FG", bio.fg, "mg/dL", "fg"],
              ["BP", bio.bp, "", ""],
              ["LDL", bio.ldl, "mg/dL", "ldl"],
            ].map(([l, v, u, k]) => (
              <div key={l} style={{ background: BG, borderRadius: 7, padding: "9px 10px" }}>
                <div
                  style={{
                    fontSize: 9,
                    color: INK3,
                    marginBottom: 3,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                  }}
                >
                  {l}
                </div>
                <div
                  style={{
                    fontFamily: FM,
                    fontSize: 17,
                    fontWeight: 500,
                    color: v && k ? BC[bioS(k, parseFloat(v))] : INK3,
                  }}
                >
                  {v || "—"}
                  {v && u ? (
                    <span style={{ fontSize: 9, color: INK3, marginLeft: 2 }}>{u}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {comp.medPct != null && (
        <div
          style={{
            background: WH,
            border: `1px solid ${BD}`,
            borderRadius: 10,
            padding: 14,
            boxShadow: SH,
          }}
        >
          <SLbl>Compliance</SLbl>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
            {[
              [
                "Medication",
                `${comp.medPct}%`,
                comp.medPct >= 90 ? GN : comp.medPct >= 70 ? AM : RE,
              ],
              ["Exercise", comp.exercise || "—", INK],
              ["Diet", comp.diet || "—", INK],
            ].map(([l, v, c]) => (
              <div key={l} style={{ background: BG, borderRadius: 7, padding: "9px 10px" }}>
                <div
                  style={{
                    fontSize: 9,
                    color: INK3,
                    marginBottom: 3,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: ".06em",
                  }}
                >
                  {l}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: c }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// BIOMARKERS TAB
// ══════════════════════════════════════════════════════════════
// ─── Report types for Labs tab ────────────────────────────────
const REPORT_TYPES = [
  { id: "blood", label: "Blood Test", icon: "🩸", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "abi", label: "ABI", icon: "🫀", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "vpt", label: "VPT", icon: "⚡", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "xray", label: "X-Ray", icon: "🦴", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "ultrasound", label: "Ultrasound", icon: "🔊", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "mri", label: "MRI", icon: "🧲", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "ecg", label: "ECG", icon: "📈", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "echo", label: "Echo", icon: "❤️", accept: ".pdf,.jpg,.jpeg,.png" },
  { id: "other", label: "Other", icon: "📄", accept: ".pdf,.jpg,.jpeg,.png" },
];

function BiomarkersTab({ appt, onSave, onContinue, showToast }) {
  const ex = appt.biomarkers || {};
  const [vals, setVals] = useState({
    hba1c: "",
    fg: "",
    bpSys: "",
    bpDia: "",
    ldl: "",
    tg: "",
    uacr: "",
    weight: "",
    waist: "",
    creatinine: "",
    tsh: "",
    hb: "",
    ...Object.fromEntries(
      Object.entries(ex)
        .filter(([k, v]) => !k.startsWith("_") && typeof v !== "object")
        .map(([k, v]) => [k, v != null ? String(v) : ""]),
    ),
  });
  const [labDates, setLabDates] = useState(ex._lab_dates || {});
  // reports: { [typeId]: [{name, date, uploading, docId?, storagePath?}] }
  const [reports, setReports] = useState({});
  const [activeType, setActiveType] = useState("blood");
  const [expandedReports, setExpandedReports] = useState({});
  const [loadingDocs, setLoadingDocs] = useState(false);
  // null | { typeId, name, docId, extractedData } — shows ConfirmModal
  // so we don't silently delete a doc + its synced lab values on a stray
  // × click. User has to explicitly confirm.
  const [reportToDelete, setReportToDelete] = useState(null);
  const fileRefs = useRef({});

  // Load previously uploaded docs from DB
  useEffect(() => {
    if (!appt.patient_id) return;
    setLoadingDocs(true);
    apiFetch(`/api/opd/patient-docs/${appt.patient_id}`)
      .then((r) => r.json())
      .then((docs) => {
        const grouped = {};
        const typeIds = REPORT_TYPES.map((t) => t.id);
        for (const doc of docs) {
          if (doc.doc_type === "prescription") continue; // handled by ComplianceTab
          const typeId = typeIds.includes(doc.doc_type)
            ? doc.doc_type
            : doc.doc_type === "lab_report"
              ? "blood"
              : "other";
          if (!grouped[typeId]) grouped[typeId] = [];
          grouped[typeId].push({
            id: doc.id,
            name: doc.file_name || doc.title,
            date: doc.doc_date
              ? new Date(doc.doc_date).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                })
              : new Date(doc.created_at).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                }),
            uploading: false,
            extracting: false,
            extractedData: doc.extracted_data || null,
            extractError: null,
            docId: doc.id,
            storagePath: doc.storage_path,
          });
        }
        setReports((prev) => {
          const merged = { ...grouped };
          // Keep any currently-uploading or extracting entries from local state
          for (const [k, entries] of Object.entries(prev)) {
            const active = entries.filter((e) => e.uploading || e.extracting);
            if (active.length) merged[k] = [...(merged[k] || []), ...active];
          }
          return merged;
        });
      })
      .catch(() => {})
      .finally(() => setLoadingDocs(false));
  }, [appt.patient_id]);

  const fields = [
    { k: "hba1c", l: "HbA1c", u: "%", ref: "< 7%", type: "hba1c" },
    { k: "fg", l: "Fasting Glucose", u: "mg/dL", ref: "< 100", type: "fg" },
    { k: "bpSys", l: "BP Systolic", u: "mmHg", ref: "< 130", type: "bpSys" },
    { k: "bpDia", l: "BP Diastolic", u: "mmHg", ref: "< 80" },
    { k: "ldl", l: "LDL", u: "mg/dL", ref: "< 100", type: "ldl" },
    { k: "tg", l: "Triglycerides", u: "mg/dL", ref: "< 150", type: "tg" },
    { k: "uacr", l: "UACR", u: "mg/g", ref: "< 30", type: "uacr" },
    { k: "weight", l: "Weight", u: "kg", ref: "BMI guide" },
    { k: "waist", l: "Waist", u: "cm", ref: "M<90/F<80" },
    { k: "creatinine", l: "Creatinine", u: "mg/dL", ref: "< 1.2" },
    { k: "tsh", l: "TSH", u: "mIU/L", ref: "0.5–4.5" },
    { k: "hb", l: "Haemoglobin", u: "g/dL", ref: "M>13/F>12" },
  ];

  const cBg = (k, v) => {
    if (!v) return BG;
    const s = bioS(k, parseFloat(v));
    return { g: GNL, a: AML, r: REL, m: WH }[s] || WH;
  };
  const cBd = (k, v) => {
    if (!v) return BD;
    const s = bioS(k, parseFloat(v));
    return { g: GNB, a: AMB, r: REB, m: BD }[s] || BD;
  };
  const cTx = (k, v) => {
    if (!v) return INK;
    return BC[bioS(k, parseFloat(v))] || INK;
  };

  const handleSave = () => {
    const bp = vals.bpSys && vals.bpDia ? `${vals.bpSys}/${vals.bpDia}` : vals.bpSys || "";
    const p = { ...vals, bp };
    Object.keys(p).forEach((k) => {
      if (p[k] === "" || p[k] == null) {
        delete p[k];
        return;
      }
      const n = parseFloat(p[k]);
      if (!isNaN(n)) p[k] = n;
    });
    const cleanDates = {};
    for (const [k, d] of Object.entries(labDates)) {
      if (p[k] != null && d) cleanDates[k] = d;
    }
    if (Object.keys(cleanDates).length) p._lab_dates = cleanDates;
    onSave(p);
  };

  const handleFileUpload = async (typeId, file) => {
    if (!file) return;
    const patientId = appt.patient_id;
    const entryId = Date.now() + Math.random();

    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const mediaType = file.type || "application/octet-stream";

    const entry = {
      id: entryId,
      name: file.name,
      date: new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      uploading: true,
      extracting: false,
      extractedData: null,
      extractError: null,
    };
    setReports((prev) => ({ ...prev, [typeId]: [...(prev[typeId] || []), entry] }));

    try {
      let uploadedDocId = null;

      if (patientId) {
        const docResp = await apiFetch(`/api/patients/${patientId}/documents`, {
          method: "POST",
          body: JSON.stringify({
            doc_type: typeId === "blood" ? "lab_report" : typeId,
            title: `${typeId} - ${file.name}`,
            file_name: file.name,
            source: "opd_upload",
            // Flip to pending up front so a page refresh during extraction
            // still shows the "Extracting…" pill + Retry button instead of
            // a blank row.
            extracted_data: { extraction_status: "pending" },
          }),
        });
        const doc = await docResp.json();
        if (doc.id) {
          await apiFetch(`/api/documents/${doc.id}/upload-file`, {
            method: "POST",
            body: JSON.stringify({ base64, mediaType, fileName: file.name }),
          });
          uploadedDocId = doc.id;
        }
      }

      // Mark upload done, start extraction
      setReports((prev) => ({
        ...prev,
        [typeId]: (prev[typeId] || []).map((r) =>
          r.id === entryId ? { ...r, uploading: false, docId: uploadedDocId, extracting: true } : r,
        ),
      }));
      showToast(`✓ ${file.name} uploaded — extracting data…`);

      // Run AI extraction
      const isLab = typeId === "blood" || typeId === "other";
      const extractFn = isLab ? extractLab : extractImaging;
      const { data: extractedData, error: extractError } = await extractFn(base64, mediaType);

      setReports((prev) => ({
        ...prev,
        [typeId]: (prev[typeId] || []).map((r) =>
          r.id === entryId ? { ...r, extracting: false, extractedData, extractError } : r,
        ),
      }));

      if (extractedData) {
        // Save extracted_data to document record
        if (uploadedDocId) {
          apiFetch(`/api/documents/${uploadedDocId}`, {
            method: "PATCH",
            body: JSON.stringify({ extracted_data: extractedData }),
          }).catch(() => {});
        }

        // Auto-populate lab values from extraction (only for lab reports)
        if (isLab && extractedData.panels) {
          const labMap = {};
          for (const panel of extractedData.panels) {
            for (const test of panel.tests) {
              const tn = (test.test_name || "").toLowerCase().trim();
              const val = test.result;
              if (val == null || val === "") continue;
              if (/hba1c|glycated|a1c/.test(tn)) labMap.hba1c = val;
              else if (/^fbs$|fasting.*(glucose|blood|sugar|plasma)|^fpg$|^fbg$/.test(tn))
                labMap.fg = val;
              else if (/^ldl/.test(tn)) labMap.ldl = val;
              else if (/triglyceride|^tg$/.test(tn)) labMap.tg = val;
              else if (/uacr|microalbumin/.test(tn)) labMap.uacr = val;
              else if (/creatinine/.test(tn) && !/clearance/.test(tn)) labMap.creatinine = val;
              else if (/^tsh/.test(tn)) labMap.tsh = val;
              else if (/^(hemoglobin|haemoglobin|hb)$/.test(tn)) labMap.hb = val;
            }
          }
          // Only fill empty fields
          setVals((prev) => {
            const updated = { ...prev };
            for (const [k, v] of Object.entries(labMap)) {
              if (!updated[k] || updated[k] === "") updated[k] = String(v);
            }
            return updated;
          });
          const filled = Object.keys(labMap).length;
          if (filled > 0)
            showToast(`✓ Auto-filled ${filled} lab value${filled > 1 ? "s" : ""} from report`);
        }

        // For imaging, show summary
        if (!isLab && extractedData.impression) {
          showToast(`✓ Extracted: ${extractedData.report_type || "Imaging"} report`);
        } else if (isLab) {
          const testCount = (extractedData.panels || []).reduce((a, p) => a + p.tests.length, 0);
          if (testCount > 0)
            showToast(`✓ Extracted ${testCount} test${testCount > 1 ? "s" : ""} from report`);
        }
      } else if (extractError) {
        // Persist failed state to DB so the Retry pill survives a page reload
        // and shows on every surface (Visit/OPD/Docs/Dashboard/Companion).
        if (uploadedDocId) {
          const failedPayload = {
            extraction_status: "failed",
            error_message: extractError,
            retry_count: 3,
            failed_at: new Date().toISOString(),
          };
          apiFetch(`/api/documents/${uploadedDocId}`, {
            method: "PATCH",
            body: JSON.stringify({ extracted_data: failedPayload }),
          }).catch(() => {});
          setReports((prev) => ({
            ...prev,
            [typeId]: (prev[typeId] || []).map((r) =>
              r.id === entryId ? { ...r, extractedData: failedPayload } : r,
            ),
          }));
        }
        showToast(`Extraction failed: ${extractError} — tap Retry`, "err");
      }
    } catch (err) {
      setReports((prev) => ({
        ...prev,
        [typeId]: (prev[typeId] || []).filter((r) => r.id !== entryId),
      }));
      showToast(`Upload failed: ${err.message}`, "err");
    }
  };

  const removeReport = (typeId, name, docId, extractedData) => {
    setReports((prev) => ({
      ...prev,
      [typeId]: (prev[typeId] || []).filter((r) => r.name !== name),
    }));

    // Clear lab values that were auto-filled from this report
    if (extractedData?.panels) {
      const keysToRemove = new Set();
      for (const panel of extractedData.panels) {
        for (const test of panel.tests) {
          const tn = (test.test_name || "").toLowerCase().trim();
          const val = test.result;
          if (val == null || val === "") continue;
          if (/hba1c|glycated|a1c/.test(tn)) keysToRemove.add("hba1c");
          else if (/^fbs$|fasting.*(glucose|blood|sugar|plasma)|^fpg$|^fbg$/.test(tn))
            keysToRemove.add("fg");
          else if (/^ldl/.test(tn)) keysToRemove.add("ldl");
          else if (/triglyceride|^tg$/.test(tn)) keysToRemove.add("tg");
          else if (/uacr|microalbumin/.test(tn)) keysToRemove.add("uacr");
          else if (/creatinine/.test(tn) && !/clearance/.test(tn)) keysToRemove.add("creatinine");
          else if (/^tsh/.test(tn)) keysToRemove.add("tsh");
          else if (/^(hemoglobin|haemoglobin|hb)$/.test(tn)) keysToRemove.add("hb");
        }
      }
      if (keysToRemove.size > 0) {
        // Only clear values that match what this report filled (compare current val to extracted val)
        setVals((prev) => {
          const updated = { ...prev };
          for (const panel of extractedData.panels) {
            for (const test of panel.tests) {
              const tn = (test.test_name || "").toLowerCase().trim();
              const val = test.result;
              if (val == null || val === "") continue;
              let key = null;
              if (/hba1c|glycated|a1c/.test(tn)) key = "hba1c";
              else if (/^fbs$|fasting.*(glucose|blood|sugar|plasma)|^fpg$|^fbg$/.test(tn))
                key = "fg";
              else if (/^ldl/.test(tn)) key = "ldl";
              else if (/triglyceride|^tg$/.test(tn)) key = "tg";
              else if (/uacr|microalbumin/.test(tn)) key = "uacr";
              else if (/creatinine/.test(tn) && !/clearance/.test(tn)) key = "creatinine";
              else if (/^tsh/.test(tn)) key = "tsh";
              else if (/^(hemoglobin|haemoglobin|hb)$/.test(tn)) key = "hb";
              if (key && updated[key] === String(val)) updated[key] = "";
            }
          }
          return updated;
        });
        showToast(
          `Cleared ${keysToRemove.size} lab value${keysToRemove.size > 1 ? "s" : ""} from removed report`,
        );
      }
    }

    if (docId) {
      apiFetch(`/api/documents/${docId}`, { method: "DELETE" }).catch(() => {});
    }
  };

  const totalReports = Object.values(reports)
    .flat()
    .filter((r) => !r.uploading).length;

  const [viewingDoc, setViewingDoc] = useState(null);

  if (loadingDocs) {
    return <TabShimmer rows={4} />;
  }

  return (
    <div>
      <ConfirmModal
        open={!!reportToDelete}
        title="Delete this report?"
        message={
          reportToDelete
            ? `"${reportToDelete.name}" will be removed. ${(reportToDelete.extractedData?.panels?.reduce((a, p) => a + (p.tests?.length || 0), 0) || 0) > 0 ? "Any lab values auto-filled from this report will also be cleared." : "This can't be undone."}`
            : ""
        }
        confirmLabel="Delete report"
        onCancel={() => setReportToDelete(null)}
        onConfirm={() => {
          const r = reportToDelete;
          setReportToDelete(null);
          if (!r) return;
          removeReport(r.typeId, r.name, r.docId, r.extractedData);
        }}
      />
      {/* ── Report uploads ── */}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 11,
          }}
        >
          <SLbl>{null}</SLbl>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: INK3,
              }}
            >
              Reports
            </span>
            {totalReports > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 8px",
                  borderRadius: 9,
                  background: TL,
                  color: T,
                }}
              >
                {totalReports} uploaded
              </span>
            )}
          </div>
        </div>

        {/* Type selector row */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
          {REPORT_TYPES.map((rt) => {
            const count = (reports[rt.id] || []).filter((r) => !r.uploading).length;
            const isActive = activeType === rt.id;
            return (
              <button
                key={rt.id}
                onClick={() => setActiveType(isActive ? null : rt.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "6px 12px",
                  borderRadius: 7,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: FB,
                  transition: "all .15s",
                  background: isActive ? NV : count > 0 ? TL : BG,
                  color: isActive ? "#fff" : count > 0 ? T : INK2,
                  border: `1px solid ${isActive ? NV : count > 0 ? T : BD}`,
                }}
              >
                <span>{rt.icon}</span>
                {rt.label}
                {count > 0 && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: 8,
                      background: isActive ? "rgba(255,255,255,.25)" : T,
                      color: isActive ? "#fff" : "#fff",
                      marginLeft: 2,
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Upload panel for selected type */}
        {activeType &&
          (() => {
            const rt = REPORT_TYPES.find((r) => r.id === activeType);
            const rpts = reports[activeType] || [];
            return (
              <div
                style={{
                  background: BG,
                  border: `1px solid ${BD}`,
                  borderRadius: 9,
                  padding: 12,
                  marginBottom: 4,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <span style={{ fontSize: 16 }}>{rt.icon}</span>
                  <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>
                    {rt.label} Reports
                  </span>
                  <button
                    onClick={() => {
                      if (!fileRefs.current[activeType]) {
                        fileRefs.current[activeType] = document.createElement("input");
                        fileRefs.current[activeType].type = "file";
                        fileRefs.current[activeType].accept = rt.accept;
                        fileRefs.current[activeType].multiple = true;
                        fileRefs.current[activeType].onchange = (e) =>
                          [...e.target.files].forEach((f) => handleFileUpload(activeType, f));
                      }
                      fileRefs.current[activeType].click();
                    }}
                    style={{
                      marginLeft: "auto",
                      padding: "5px 12px",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 600,
                      background: T,
                      color: "#fff",
                      border: "none",
                      cursor: "pointer",
                      fontFamily: FB,
                    }}
                  >
                    + Add Report
                  </button>
                </div>
                {rpts.length === 0 ? (
                  <div
                    style={{ textAlign: "center", padding: "14px 0", color: INK3, fontSize: 12 }}
                  >
                    No {rt.label} reports yet — click Add Report
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {rpts.map((r, i) => {
                      const edParsed =
                        typeof r.extractedData === "string"
                          ? (() => {
                              try {
                                return JSON.parse(r.extractedData);
                              } catch {
                                return null;
                              }
                            })()
                          : r.extractedData;
                      const needsReview = edParsed?.extraction_status === "mismatch_review";
                      return (
                        <div key={r.id || i}>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 9,
                              background: needsReview
                                ? "#fef2f2"
                                : r.uploading || r.extracting
                                  ? BG
                                  : WH,
                              border: `1px solid ${
                                needsReview
                                  ? "#fecaca"
                                  : r.uploading || r.extracting
                                    ? BD
                                    : r.extractedData
                                      ? SKB
                                      : GNB
                              }`,
                              borderRadius: r.extractedData ? "7px 7px 0 0" : 7,
                              padding: "8px 11px",
                            }}
                          >
                            <span style={{ fontSize: 14 }}>
                              {r.uploading
                                ? "⏳"
                                : r.extracting
                                  ? "🔬"
                                  : needsReview
                                    ? "⚠️"
                                    : r.extractedData
                                      ? "✅"
                                      : "📋"}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  color: needsReview ? "#b91c1c" : INK,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {r.name}
                              </div>
                              <div
                                style={{
                                  fontSize: 9,
                                  color: needsReview ? "#b91c1c" : INK3,
                                  fontWeight: needsReview ? 600 : 400,
                                }}
                              >
                                {r.uploading
                                  ? "Uploading…"
                                  : r.extracting
                                    ? "AI extracting data…"
                                    : r.extractError
                                      ? `Extraction failed: ${r.extractError}`
                                      : needsReview
                                        ? `${r.date} · Needs review in Companion — extraction not applied`
                                        : r.extractedData
                                          ? (() => {
                                              const d = r.extractedData;
                                              if (d.panels) {
                                                const tc = d.panels.reduce(
                                                  (a, p) => a + p.tests.length,
                                                  0,
                                                );
                                                return `${r.date} · AI extracted ${tc} test${tc !== 1 ? "s" : ""}`;
                                              }
                                              if (d.report_type)
                                                return `${r.date} · ${d.report_type}`;
                                              return r.date;
                                            })()
                                          : r.date}
                              </div>
                            </div>
                            {needsReview && (
                              <span
                                style={{
                                  fontSize: 9,
                                  padding: "3px 7px",
                                  borderRadius: 10,
                                  background: "#fee2e2",
                                  color: "#b91c1c",
                                  border: "1px solid #fecaca",
                                  fontWeight: 700,
                                  whiteSpace: "nowrap",
                                }}
                                title="Extraction not applied — patient name on doc doesn't match. Review in the Companion app."
                              >
                                Needs Review
                              </span>
                            )}
                            {r.extracting && (
                              <span
                                style={{
                                  fontSize: 10,
                                  color: SK,
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                }}
                              >
                                Extracting…
                              </span>
                            )}
                            {!r.uploading && !r.extracting && r.docId && r.extractedData && (
                              <DocStatusPill
                                doc={{ id: r.docId, extracted_data: r.extractedData }}
                                patientId={appt.patient_id}
                                size="sm"
                              />
                            )}
                            {!r.uploading && !r.extracting && r.docId && (
                              <button
                                onClick={() =>
                                  setViewingDoc({
                                    id: r.docId,
                                    title: r.name || "Lab Report",
                                    file_name: r.name,
                                    doc_type: "lab_report",
                                    doc_date: r.date,
                                    source: "opd_upload",
                                    reviewed: true,
                                  })
                                }
                                style={{
                                  fontSize: 11,
                                  color: T,
                                  background: TL,
                                  border: `1px solid ${TB}`,
                                  cursor: "pointer",
                                  padding: "3px 8px",
                                  borderRadius: 5,
                                  fontWeight: 600,
                                  fontFamily: FB,
                                }}
                              >
                                View
                              </button>
                            )}
                            {!r.uploading && !r.extracting && (
                              <button
                                onClick={() =>
                                  setReportToDelete({
                                    typeId: activeType,
                                    name: r.name,
                                    docId: r.docId,
                                    extractedData: r.extractedData,
                                  })
                                }
                                style={{
                                  fontSize: 12,
                                  color: INK3,
                                  background: "none",
                                  border: "none",
                                  cursor: "pointer",
                                  padding: "2px 6px",
                                  borderRadius: 4,
                                }}
                              >
                                ✕
                              </button>
                            )}
                          </div>
                          {/* Extracted data preview */}
                          {r.extractedData &&
                            (() => {
                              const d = r.extractedData;
                              // Lab report: show key test results
                              if (d.panels && d.panels.length > 0) {
                                const tests = d.panels
                                  .flatMap((p) => p.tests)
                                  .filter((t) => t.result != null);
                                if (!tests.length) return null;
                                return (
                                  <div
                                    style={{
                                      background: SKL,
                                      border: `1px solid ${SKB}`,
                                      borderTop: "none",
                                      borderRadius: "0 0 7px 7px",
                                      padding: "8px 11px",
                                    }}
                                  >
                                    <div
                                      style={{
                                        fontSize: 9,
                                        fontWeight: 700,
                                        color: SK,
                                        textTransform: "uppercase",
                                        letterSpacing: ".08em",
                                        marginBottom: 5,
                                      }}
                                    >
                                      AI Extracted Results{d.lab_name ? ` — ${d.lab_name}` : ""}
                                      {d.report_date ? ` · ${d.report_date}` : ""}
                                    </div>
                                    {(() => {
                                      const rKey = r.id || r.name;
                                      const isExpanded = expandedReports[rKey];
                                      const shown = isExpanded ? tests : tests.slice(0, 25);
                                      return (
                                        <>
                                          <div
                                            style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
                                          >
                                            {shown.map((t, ti) => (
                                              <span
                                                key={ti}
                                                style={{
                                                  fontSize: 10,
                                                  padding: "2px 7px",
                                                  borderRadius: 5,
                                                  fontWeight: 600,
                                                  fontFamily: FM,
                                                  background:
                                                    t.flag === "H"
                                                      ? REL
                                                      : t.flag === "L"
                                                        ? AML
                                                        : GNL,
                                                  color:
                                                    t.flag === "H" ? RE : t.flag === "L" ? AM : GN,
                                                  border: `1px solid ${t.flag === "H" ? REB : t.flag === "L" ? AMB : GNB}`,
                                                }}
                                              >
                                                {t.test_name}: {t.result}
                                                {t.unit ? ` ${t.unit}` : ""}
                                                {t.flag === "H" ? " ↑" : t.flag === "L" ? " ↓" : ""}
                                              </span>
                                            ))}
                                          </div>
                                          {tests.length > 25 && (
                                            <button
                                              onClick={() =>
                                                setExpandedReports((p) => ({
                                                  ...p,
                                                  [rKey]: !isExpanded,
                                                }))
                                              }
                                              style={{
                                                fontSize: 10,
                                                fontWeight: 600,
                                                color: SK,
                                                background: "none",
                                                border: "none",
                                                cursor: "pointer",
                                                padding: "4px 0 0",
                                                fontFamily: FB,
                                              }}
                                            >
                                              {isExpanded
                                                ? "Show less ↑"
                                                : `+${tests.length - 25} more — Show all ↓`}
                                            </button>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                );
                              }
                              // Imaging report: show findings
                              if (d.report_type || d.findings) {
                                return (
                                  <div
                                    style={{
                                      background: SKL,
                                      border: `1px solid ${SKB}`,
                                      borderTop: "none",
                                      borderRadius: "0 0 7px 7px",
                                      padding: "8px 11px",
                                    }}
                                  >
                                    <div
                                      style={{
                                        fontSize: 9,
                                        fontWeight: 700,
                                        color: SK,
                                        textTransform: "uppercase",
                                        letterSpacing: ".08em",
                                        marginBottom: 5,
                                      }}
                                    >
                                      AI Extracted — {d.report_type || "Imaging"}
                                      {d.date ? ` · ${d.date}` : ""}
                                    </div>
                                    {d.findings && d.findings.length > 0 && (
                                      <div
                                        style={{
                                          display: "flex",
                                          flexWrap: "wrap",
                                          gap: 4,
                                          marginBottom: d.impression ? 4 : 0,
                                        }}
                                      >
                                        {d.findings.slice(0, 8).map((f, fi) => (
                                          <span
                                            key={fi}
                                            style={{
                                              fontSize: 10,
                                              padding: "2px 7px",
                                              borderRadius: 5,
                                              fontWeight: 500,
                                              background:
                                                f.interpretation === "Abnormal"
                                                  ? REL
                                                  : f.interpretation === "Borderline"
                                                    ? AML
                                                    : GNL,
                                              color:
                                                f.interpretation === "Abnormal"
                                                  ? RE
                                                  : f.interpretation === "Borderline"
                                                    ? AM
                                                    : GN,
                                              border: `1px solid ${f.interpretation === "Abnormal" ? REB : f.interpretation === "Borderline" ? AMB : GNB}`,
                                            }}
                                          >
                                            {f.parameter}: {f.value}
                                            {f.unit ? ` ${f.unit}` : ""}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                    {d.impression && (
                                      <div
                                        style={{ fontSize: 10, color: INK2, fontStyle: "italic" }}
                                      >
                                        {d.impression.length > 120
                                          ? d.impression.slice(0, 120) + "…"
                                          : d.impression}
                                      </div>
                                    )}
                                  </div>
                                );
                              }
                              return null;
                            })()}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}

        {totalReports === 0 && !activeType && (
          <div style={{ textAlign: "center", color: INK3, fontSize: 11, padding: "6px 0" }}>
            Select a report type above to upload files
          </div>
        )}
      </div>

      {/* ── Lab values ── */}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>
            Lab Values{" "}
            <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
              (enter manually or from report)
            </span>
          </div>
          <div style={{ display: "flex", gap: 7 }}>
            <button
              onClick={handleSave}
              style={{
                padding: "6px 16px",
                borderRadius: 7,
                background: WH,
                color: T,
                border: `1px solid ${T}`,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              💾 Save
            </button>
            <button
              onClick={() => {
                handleSave();
                onContinue && onContinue();
              }}
              style={{
                padding: "6px 16px",
                borderRadius: 7,
                background: T,
                color: "#fff",
                border: "none",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              Save & Continue →
            </button>
          </div>
        </div>
        <div
          className="opd-biomarker-grid"
          style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8 }}
        >
          {fields.map((f) => {
            const v = vals[f.k];
            return (
              <div
                key={f.k}
                style={{
                  background: cBg(f.type || f.k, v),
                  border: `1px solid ${cBd(f.type || f.k, v)}`,
                  borderRadius: 8,
                  padding: "9px 10px",
                  transition: "border-color .15s",
                }}
              >
                <div
                  style={{
                    fontSize: 8,
                    fontWeight: 600,
                    color: INK3,
                    textTransform: "uppercase",
                    letterSpacing: ".08em",
                    marginBottom: 5,
                  }}
                >
                  {f.l}
                </div>
                <input
                  type="number"
                  step="0.1"
                  value={v}
                  onChange={(e) => {
                    const newVal = e.target.value;
                    setVals((p) => ({ ...p, [f.k]: newVal }));
                    setLabDates((p) => ({
                      ...p,
                      [f.k]: new Date().toISOString().split("T")[0],
                    }));
                  }}
                  placeholder="—"
                  style={{
                    border: "none",
                    outline: "none",
                    fontFamily: FM,
                    fontSize: 18,
                    fontWeight: 500,
                    color: cTx(f.type || f.k, v),
                    width: "100%",
                    background: "transparent",
                    borderBottom: `1px solid ${cBd(f.type || f.k, v)}`,
                    paddingBottom: 2,
                  }}
                />
                <div style={{ fontSize: 9, color: INK3, marginTop: 3 }}>
                  {f.u} · {f.ref}
                </div>
                {v && labDates[f.k] && (
                  <div
                    style={{
                      fontSize: 9,
                      color: INK3,
                      marginTop: 2,
                      fontStyle: "italic",
                    }}
                    title={`Added on ${fmtDate(labDates[f.k])}`}
                  >
                    📅 {fmtDate(labDates[f.k])}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// VITALS TAB (post check-in)
// ══════════════════════════════════════════════════════════════
function VitalsTab({ appt, onSave }) {
  const ex = appt.opd_vitals || {};
  const [v, setV] = useState({
    weight: "",
    height: "",
    waist: "",
    bpSys: "",
    bpDia: "",
    spo2: "",
    spotSugar: "",
    bodyFat: "",
    muscleMass: "",
    ...Object.fromEntries(
      Object.entries(ex).map(([k, val]) => [k, val != null ? String(val) : ""]),
    ),
  });
  const [saved, setSaved] = useState(false);

  const bmi =
    v.weight && v.height
      ? parseFloat((parseFloat(v.weight) / Math.pow(parseFloat(v.height) / 100, 2)).toFixed(1))
      : null;

  const fld = (label, key, unit, placeholder = "—") => (
    <div
      style={{ background: BG, border: `1px solid ${BD}`, borderRadius: 8, padding: "10px 11px" }}
    >
      <div
        style={{
          fontSize: 9,
          fontWeight: 600,
          color: INK3,
          textTransform: "uppercase",
          letterSpacing: ".07em",
          marginBottom: 5,
        }}
      >
        {label}
      </div>
      <input
        type="number"
        step="0.1"
        value={v[key]}
        onChange={(e) => setV((p) => ({ ...p, [key]: e.target.value }))}
        placeholder={placeholder}
        style={{
          border: "none",
          outline: "none",
          fontFamily: FM,
          fontSize: 19,
          fontWeight: 500,
          color: INK,
          width: "100%",
          background: "transparent",
          borderBottom: `1px solid ${BD}`,
          paddingBottom: 2,
        }}
      />
      <div style={{ fontSize: 9, color: INK3, marginTop: 3 }}>{unit}</div>
    </div>
  );

  const handleSave = () => {
    const p = { ...v };
    if (bmi) p.bmi = bmi;
    if (v.bpSys && v.bpDia) p.bp = `${v.bpSys}/${v.bpDia}`;
    Object.keys(p).forEach((k) => {
      if (p[k] === "" || p[k] == null) delete p[k];
      else {
        const n = parseFloat(p[k]);
        if (!isNaN(n)) p[k] = n;
      }
    });
    onSave(p);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  };

  return (
    <div>
      {saved && (
        <div
          style={{
            background: GNL,
            border: `1px solid ${GNB}`,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 12,
            fontSize: 12,
            color: GN,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          ✅ Vitals saved successfully
        </div>
      )}

      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 12,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: INK }}>Clinic Vitals</div>
            <div style={{ fontSize: 11, color: INK3, marginTop: 2 }}>
              Measured at reception after check-in
            </div>
          </div>
          <button
            onClick={handleSave}
            style={{
              padding: "7px 16px",
              borderRadius: 7,
              background: T,
              color: "#fff",
              border: "none",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            💾 Save Vitals
          </button>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9, marginBottom: 10 }}
        >
          {fld("Weight", "weight", "kg")}
          {fld("Height", "height", "cm")}
          {fld("Waist", "waist", "cm")}
        </div>

        {/* BMI auto-calc */}
        <div
          style={{
            background: bmi ? GNL : BG,
            border: `1px solid ${bmi ? GNB : BD}`,
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 10,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 9,
                fontWeight: 600,
                color: INK3,
                textTransform: "uppercase",
                letterSpacing: ".07em",
                marginBottom: 3,
              }}
            >
              BMI (auto-calculated)
            </div>
            <div
              style={{
                fontFamily: FM,
                fontSize: 24,
                fontWeight: 500,
                color: bmi ? bmiColor(bmi) : INK3,
              }}
            >
              {bmi || "—"}
            </div>
          </div>
          {bmi && (
            <div style={{ fontSize: 11, color: bmiColor(bmi), fontWeight: 600 }}>
              {bmi < 18.5
                ? "Underweight"
                : bmi < 25
                  ? "Normal weight"
                  : bmi < 30
                    ? "Overweight"
                    : "Obese"}
            </div>
          )}
          <div style={{ marginLeft: "auto", fontSize: 10, color: INK3, lineHeight: 1.6 }}>
            &lt;18.5 Underweight
            <br />
            18.5–24.9 Normal
            <br />
            25–29.9 Overweight
            <br />
            ≥30 Obese
          </div>
        </div>

        <div
          style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9, marginBottom: 10 }}
        >
          {fld("BP Systolic", "bpSys", "mmHg")}
          {fld("BP Diastolic", "bpDia", "mmHg")}
          {fld("SpO2", "spo2", "%")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}>
          {fld("Spot Sugar", "spotSugar", "mg/dL")}
          {fld("Body Fat", "bodyFat", "%")}
          {fld("Muscle Mass", "muscleMass", "kg")}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// MEDICINE & COMPLIANCE TAB
// ══════════════════════════════════════════════════════════════
function ComplianceTab({ appt, onSave, onContinue, showToast }) {
  const ex = appt.compliance || {};
  const [medPct, setMedPct] = useState(ex.medPct ?? 80);
  const [missed, setMissed] = useState(ex.missed || "");
  const [diet, setDiet] = useState(ex.diet || "Moderate — watching carbs");
  const [exercise, setExercise] = useState(ex.exercise || "Moderate (30 min, 3–4×/week)");
  const [stress, setStress] = useState(ex.stress || "Moderate");
  const [notes, setNotes] = useState(ex.notes || "");
  const [symptoms, setSymptoms] = useState(ex.symptoms || []);
  const [symptomInput, setSymptomInput] = useState("");
  const pctColor = medPct >= 90 ? GN : medPct >= 70 ? AM : RE;

  // Prescriptions: [{id, doctorName, date, fileName, uploading, docId?}]
  const [prescriptions, setPrescriptions] = useState([]);
  const [loadingRx, setLoadingRx] = useState(false);
  const [viewingDoc, setViewingDoc] = useState(null);
  const [addingRx, setAddingRx] = useState(false);
  // null | { id, docId, fileName, doctorName, extractedData } — drives the
  // delete confirmation modal so the × button never silently wipes a Rx.
  const [rxToDelete, setRxToDelete] = useState(null);
  const [rxForm, setRxForm] = useState({
    doctorName: "",
    date: new Date().toISOString().split("T")[0],
  });
  const rxFileRef = useRef();

  // Load previously uploaded prescriptions from DB
  useEffect(() => {
    if (!appt.patient_id) return;
    setLoadingRx(true);
    apiFetch(`/api/opd/patient-docs/${appt.patient_id}`)
      .then((r) => r.json())
      .then((docs) => {
        const rxDocs = docs
          .filter((d) => d.doc_type === "prescription")
          .map((d) => ({
            id: d.id,
            doctorName:
              d.notes && !d.notes.startsWith("healthray_") ? d.notes.replace(/^Dr\.\s*/, "") : "",
            date: d.doc_date
              ? new Date(d.doc_date).toISOString().split("T")[0]
              : new Date(d.created_at).toISOString().split("T")[0],
            fileName: d.file_name || d.title,
            uploading: false,
            extracting: false,
            extractedData: d.extracted_data || null,
            extractError: null,
            docId: d.id,
            storagePath: d.storage_path,
          }));
        setPrescriptions((prev) => {
          const active = prev.filter((p) => p.uploading || p.extracting);
          return [...rxDocs, ...active];
        });
      })
      .catch(() => {})
      .finally(() => setLoadingRx(false));
  }, [appt.patient_id]);

  const handleAddRx = () => {
    setAddingRx(true);
    setRxForm({ doctorName: "", date: new Date().toISOString().split("T")[0] });
  };

  const handleRxFile = async (file) => {
    if (!file) return;
    const patientId = appt.patient_id;
    const entryId = Date.now() + Math.random();

    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve(ev.target.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const mediaType = file.type || "application/octet-stream";

    const entry = {
      id: entryId,
      doctorName: rxForm.doctorName,
      date: rxForm.date,
      fileName: file.name,
      uploading: true,
      extracting: false,
      extractedData: null,
      extractError: null,
    };
    setPrescriptions((prev) => [...prev, entry]);
    setAddingRx(false);

    try {
      let uploadedDocId = null;

      if (patientId) {
        const docResp = await apiFetch(`/api/patients/${patientId}/documents`, {
          method: "POST",
          body: JSON.stringify({
            doc_type: "prescription",
            title: `Prescription - ${rxForm.doctorName || "Unknown"} - ${rxForm.date}`,
            file_name: file.name,
            doc_date: rxForm.date,
            source: "opd_upload",
            notes: rxForm.doctorName ? `Dr. ${rxForm.doctorName}` : null,
            extracted_data: { extraction_status: "pending" },
          }),
        });
        const doc = await docResp.json();
        if (doc.id) {
          await apiFetch(`/api/documents/${doc.id}/upload-file`, {
            method: "POST",
            body: JSON.stringify({ base64, mediaType, fileName: file.name }),
          });
          uploadedDocId = doc.id;
        }
      }

      // Mark upload done, start extraction
      setPrescriptions((prev) =>
        prev.map((p) =>
          p.id === entryId ? { ...p, uploading: false, docId: uploadedDocId, extracting: true } : p,
        ),
      );
      if (showToast) showToast(`✓ ${file.name} uploaded — extracting medicines…`);

      // Run AI extraction for prescription
      const { data: extractedData, error: extractError } = await extractRx(base64, mediaType);

      setPrescriptions((prev) =>
        prev.map((p) =>
          p.id === entryId ? { ...p, extracting: false, extractedData, extractError } : p,
        ),
      );

      if (extractedData) {
        // Save extracted_data to document record
        if (uploadedDocId) {
          apiFetch(`/api/documents/${uploadedDocId}`, {
            method: "PATCH",
            body: JSON.stringify({ extracted_data: extractedData }),
          }).catch(() => {});
        }

        const medCount = (extractedData.medications || []).length;
        if (showToast)
          showToast(
            `✓ Extracted ${medCount} medicine${medCount !== 1 ? "s" : ""} from prescription`,
          );
      } else if (extractError) {
        // Persist failed state so the Retry pill survives page reload.
        if (uploadedDocId) {
          const failedPayload = {
            extraction_status: "failed",
            error_message: extractError,
            retry_count: 3,
            failed_at: new Date().toISOString(),
          };
          apiFetch(`/api/documents/${uploadedDocId}`, {
            method: "PATCH",
            body: JSON.stringify({ extracted_data: failedPayload }),
          }).catch(() => {});
          setPrescriptions((prev) =>
            prev.map((p) => (p.id === entryId ? { ...p, extractedData: failedPayload } : p)),
          );
        }
        if (showToast) showToast(`Extraction failed: ${extractError} — tap Retry`, "err");
      }
    } catch (err) {
      setPrescriptions((prev) => prev.filter((p) => p.id !== entryId));
      if (showToast) showToast(`Upload failed: ${err.message}`, "err");
    }
  };

  const removeRx = (id, docId, extractedData) => {
    setPrescriptions((prev) => prev.filter((p) => p.id !== id));
    const medCount = (extractedData?.medications || []).length;
    if (medCount > 0 && showToast) {
      showToast(
        `Removed prescription — ${medCount} medicine${medCount !== 1 ? "s" : ""} will be excluded on next save`,
      );
    }
    if (docId) {
      apiFetch(`/api/documents/${docId}`, { method: "DELETE" }).catch(() => {});
    }
  };

  if (loadingRx) {
    return <TabShimmer rows={3} />;
  }

  return (
    <div>
      <ConfirmModal
        open={!!rxToDelete}
        title="Delete this prescription?"
        message={
          rxToDelete
            ? `"${rxToDelete.fileName || "Prescription"}"${rxToDelete.doctorName ? ` from Dr. ${rxToDelete.doctorName}` : ""} will be removed. ${(rxToDelete.extractedData?.medications?.length || 0) > 0 ? `${rxToDelete.extractedData.medications.length} extracted medicine${rxToDelete.extractedData.medications.length !== 1 ? "s" : ""} will be excluded on next save.` : "This can't be undone."}`
            : ""
        }
        confirmLabel="Delete prescription"
        onCancel={() => setRxToDelete(null)}
        onConfirm={() => {
          const r = rxToDelete;
          setRxToDelete(null);
          if (!r) return;
          removeRx(r.id, r.docId, r.extractedData);
        }}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 14,
        }}
      >
        <div style={{ fontFamily: FD, fontSize: 17, color: INK }}>Medicine & Compliance</div>
        <div style={{ display: "flex", gap: 7 }}>
          <button
            onClick={() => {
              const rxData = prescriptions.filter((p) => p.extractedData);
              const allMeds = rxData.flatMap((p) => p.extractedData.medications || []);
              const stoppedMeds = rxData.flatMap((p) => p.extractedData.stopped_medications || []);
              const allDiags = rxData.flatMap((p) => p.extractedData.diagnoses || []);
              // Deduplicate diagnoses by id
              const diagMap = {};
              for (const d of allDiags) {
                if (d.id) diagMap[d.id] = d;
              }
              onSave({
                medPct: parseInt(medPct),
                missed,
                diet,
                exercise,
                stress,
                notes,
                symptoms,
                medications: allMeds,
                stopped_medications: stoppedMeds,
                diagnoses: Object.values(diagMap),
              });
            }}
            style={{
              padding: "7px 16px",
              borderRadius: 7,
              background: WH,
              color: T,
              border: `1px solid ${T}`,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            💾 Save
          </button>
          <button
            onClick={() => {
              const rxData = prescriptions.filter((p) => p.extractedData);
              const allMeds = rxData.flatMap((p) => p.extractedData.medications || []);
              const stoppedMeds = rxData.flatMap((p) => p.extractedData.stopped_medications || []);
              const allDiags = rxData.flatMap((p) => p.extractedData.diagnoses || []);
              const diagMap = {};
              for (const d of allDiags) {
                if (d.id) diagMap[d.id] = d;
              }
              onSave({
                medPct: parseInt(medPct),
                missed,
                diet,
                exercise,
                stress,
                notes,
                symptoms,
                medications: allMeds,
                stopped_medications: stoppedMeds,
                diagnoses: Object.values(diagMap),
              });
              onContinue && onContinue();
            }}
            style={{
              padding: "7px 16px",
              borderRadius: 7,
              background: T,
              color: "#fff",
              border: "none",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            Save & Continue →
          </button>
        </div>
      </div>

      {/* ── Prescriptions ── */}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 11,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: ".12em",
                textTransform: "uppercase",
                color: INK3,
              }}
            >
              Prescriptions
            </span>
            {prescriptions.filter((p) => !p.uploading).length > 0 && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "1px 8px",
                  borderRadius: 9,
                  background: TL,
                  color: T,
                }}
              >
                {prescriptions.filter((p) => !p.uploading).length} uploaded
              </span>
            )}
          </div>
          {!addingRx && (
            <button
              onClick={handleAddRx}
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                background: T,
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              + Add Prescription
            </button>
          )}
        </div>

        {/* Add prescription form */}
        {addingRx && (
          <div
            style={{
              background: BG,
              border: `1px solid ${BD}`,
              borderRadius: 8,
              padding: 12,
              marginBottom: 10,
            }}
          >
            <div
              style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}
            >
              <div>
                <Lbl>Prescribing Doctor</Lbl>
                <Inp
                  value={rxForm.doctorName}
                  onChange={(e) => setRxForm((f) => ({ ...f, doctorName: e.target.value }))}
                  placeholder="e.g. Dr. Sharma, Cardio"
                />
              </div>
              <div>
                <Lbl>Prescription Date</Lbl>
                <Inp
                  type="date"
                  value={rxForm.date}
                  onChange={(e) => setRxForm((f) => ({ ...f, date: e.target.value }))}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <div
                onClick={() => {
                  const inp = document.createElement("input");
                  inp.type = "file";
                  inp.accept = ".pdf,.jpg,.jpeg,.png";
                  inp.onchange = (e) => handleRxFile(e.target.files[0]);
                  inp.click();
                }}
                style={{
                  flex: 1,
                  border: `2px dashed ${BD2}`,
                  borderRadius: 7,
                  padding: "12px",
                  textAlign: "center",
                  cursor: "pointer",
                  background: WH,
                }}
              >
                <div style={{ fontSize: 18, marginBottom: 3 }}>📄</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: INK }}>
                  Upload prescription file
                </div>
                <div style={{ fontSize: 9, color: INK3 }}>PDF or image</div>
              </div>
              <button
                onClick={() => setAddingRx(false)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 7,
                  fontSize: 11,
                  fontWeight: 600,
                  background: BG,
                  border: `1px solid ${BD}`,
                  color: INK3,
                  cursor: "pointer",
                  fontFamily: FB,
                  alignSelf: "center",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Prescription list */}
        {prescriptions.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {prescriptions.map((p) => {
              const edParsed =
                typeof p.extractedData === "string"
                  ? (() => {
                      try {
                        return JSON.parse(p.extractedData);
                      } catch {
                        return null;
                      }
                    })()
                  : p.extractedData;
              const needsReview = edParsed?.extraction_status === "mismatch_review";
              return (
                <div key={p.id}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      background: needsReview ? "#fef2f2" : p.uploading || p.extracting ? BG : WH,
                      border: `1px solid ${
                        needsReview
                          ? "#fecaca"
                          : p.uploading || p.extracting
                            ? BD
                            : p.extractedData
                              ? SKB
                              : GNB
                      }`,
                      borderRadius: p.extractedData ? "8px 8px 0 0" : 8,
                      padding: "10px 12px",
                    }}
                  >
                    <span style={{ fontSize: 22, flexShrink: 0 }}>
                      {p.uploading
                        ? "⏳"
                        : p.extracting
                          ? "🔬"
                          : needsReview
                            ? "⚠️"
                            : p.extractedData
                              ? "✅"
                              : "💊"}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: needsReview ? "#b91c1c" : INK,
                          marginBottom: 2,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {p.fileName}
                      </div>
                      <div
                        style={{
                          display: "flex",
                          gap: 10,
                          fontSize: 10,
                          color: needsReview ? "#b91c1c" : INK3,
                          fontWeight: needsReview ? 600 : 400,
                        }}
                      >
                        {p.doctorName && <span>By {p.doctorName}</span>}
                        <span>
                          {p.uploading
                            ? "Uploading…"
                            : p.extracting
                              ? "AI extracting medicines…"
                              : p.extractError
                                ? `Extraction failed`
                                : needsReview
                                  ? `${fmtDate(p.date)} · Needs review in Companion — extraction not applied`
                                  : p.extractedData
                                    ? `${fmtDate(p.date)} · ${(p.extractedData.medications || []).length} medicine${(p.extractedData.medications || []).length !== 1 ? "s" : ""} found`
                                    : fmtDate(p.date)}
                        </span>
                      </div>
                    </div>
                    {needsReview && (
                      <span
                        style={{
                          fontSize: 9,
                          padding: "3px 7px",
                          borderRadius: 10,
                          background: "#fee2e2",
                          color: "#b91c1c",
                          border: "1px solid #fecaca",
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                        }}
                        title="Extraction not applied — review in the Companion app"
                      >
                        Needs Review
                      </span>
                    )}
                    {p.extracting && (
                      <span
                        style={{ fontSize: 10, color: SK, fontWeight: 600, whiteSpace: "nowrap" }}
                      >
                        Extracting…
                      </span>
                    )}
                    {!p.uploading && !p.extracting && p.docId && p.extractedData && (
                      <DocStatusPill
                        doc={{ id: p.docId, extracted_data: p.extractedData }}
                        patientId={appt.patient_id}
                        size="sm"
                      />
                    )}
                    {!p.uploading && !p.extracting && p.docId && (
                      <button
                        onClick={() =>
                          setViewingDoc({
                            id: p.docId,
                            title: `Prescription — ${p.doctorName || "Unknown"}`,
                            file_name: p.fileName,
                            doc_type: "prescription",
                            doc_date: p.date,
                            source: "opd_upload",
                            reviewed: true,
                          })
                        }
                        style={{
                          fontSize: 11,
                          color: T,
                          background: TL,
                          border: `1px solid ${TB}`,
                          cursor: "pointer",
                          padding: "3px 8px",
                          borderRadius: 5,
                          fontWeight: 600,
                          fontFamily: FB,
                        }}
                      >
                        View
                      </button>
                    )}
                    {!p.uploading && !p.extracting && (
                      <button
                        onClick={() =>
                          setRxToDelete({
                            id: p.id,
                            docId: p.docId,
                            fileName: p.fileName,
                            doctorName: p.doctorName,
                            extractedData: p.extractedData,
                          })
                        }
                        style={{
                          fontSize: 12,
                          color: INK3,
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          padding: "2px 6px",
                          borderRadius: 4,
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {/* Extracted prescription data */}
                  {p.extractedData &&
                    (() => {
                      const rx = p.extractedData;
                      const meds = rx.medications || [];
                      const diags = rx.diagnoses || [];
                      if (!meds.length && !diags.length) return null;
                      return (
                        <div
                          style={{
                            background: SKL,
                            border: `1px solid ${SKB}`,
                            borderTop: "none",
                            borderRadius: "0 0 8px 8px",
                            padding: "10px 12px",
                          }}
                        >
                          <div
                            style={{
                              fontSize: 9,
                              fontWeight: 700,
                              color: SK,
                              textTransform: "uppercase",
                              letterSpacing: ".08em",
                              marginBottom: 6,
                            }}
                          >
                            AI Extracted{rx.doctor_name ? ` — ${rx.doctor_name}` : ""}
                            {rx.visit_date ? ` · ${rx.visit_date}` : ""}
                          </div>
                          {diags.length > 0 && (
                            <div
                              style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 6 }}
                            >
                              {diags.map((d, di) => (
                                <span
                                  key={di}
                                  style={{
                                    fontSize: 10,
                                    padding: "2px 7px",
                                    borderRadius: 5,
                                    fontWeight: 600,
                                    background:
                                      d.status === "Uncontrolled"
                                        ? REL
                                        : d.status === "New"
                                          ? AML
                                          : GNL,
                                    color:
                                      d.status === "Uncontrolled"
                                        ? RE
                                        : d.status === "New"
                                          ? AM
                                          : GN,
                                    border: `1px solid ${d.status === "Uncontrolled" ? REB : d.status === "New" ? AMB : GNB}`,
                                  }}
                                >
                                  {d.label || d.id}
                                </span>
                              ))}
                            </div>
                          )}
                          {meds.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                              {meds.map((m, mi) => (
                                <div
                                  key={mi}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    background: WH,
                                    border: `1px solid ${BD}`,
                                    borderRadius: 5,
                                    padding: "5px 9px",
                                  }}
                                >
                                  <span style={{ fontSize: 12 }}>💊</span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <span style={{ fontSize: 11, fontWeight: 600, color: INK }}>
                                      {m.name}
                                    </span>
                                    <span style={{ fontSize: 10, color: INK3, marginLeft: 6 }}>
                                      {[m.dose, m.frequency, m.timing].filter(Boolean).join(" · ")}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {(rx.stopped_medications || []).length > 0 && (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 3,
                                marginTop: 4,
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 9,
                                  fontWeight: 700,
                                  color: RE,
                                  textTransform: "uppercase",
                                  letterSpacing: ".06em",
                                }}
                              >
                                Stopped / Omitted
                              </div>
                              {rx.stopped_medications.map((m, mi) => (
                                <div
                                  key={mi}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    background: REL,
                                    border: `1px solid ${REB}`,
                                    borderRadius: 5,
                                    padding: "5px 9px",
                                  }}
                                >
                                  <span style={{ fontSize: 12 }}>🚫</span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <span
                                      style={{
                                        fontSize: 11,
                                        fontWeight: 600,
                                        color: RE,
                                        textDecoration: "line-through",
                                      }}
                                    >
                                      {m.name}
                                    </span>
                                    {m.reason && (
                                      <span style={{ fontSize: 10, color: INK3, marginLeft: 6 }}>
                                        — {m.reason}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                          {(() => {
                            const adviceText = Array.isArray(rx.advice)
                              ? rx.advice.join("; ")
                              : typeof rx.advice === "string"
                                ? rx.advice
                                : "";
                            return adviceText ? (
                              <div
                                style={{
                                  fontSize: 10,
                                  color: INK2,
                                  marginTop: 5,
                                  fontStyle: "italic",
                                }}
                              >
                                {adviceText}
                              </div>
                            ) : null;
                          })()}
                        </div>
                      );
                    })()}
                </div>
              );
            })}
          </div>
        ) : (
          !addingRx && (
            <div style={{ textAlign: "center", padding: "14px 0", color: INK3, fontSize: 11 }}>
              No prescriptions added — click Add Prescription to upload
            </div>
          )
        )}
      </div>

      {/* ── Medication compliance slider ── */}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <SLbl>Medication Compliance</SLbl>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 9,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 500 }}>Overall Compliance</span>
          <span style={{ fontFamily: FM, fontSize: 22, fontWeight: 500, color: pctColor }}>
            {medPct}%
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          step="5"
          value={medPct}
          onChange={(e) => setMedPct(e.target.value)}
          style={{ width: "100%", accentColor: T, marginBottom: 5 }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: INK3 }}>
          <span>0% — Not taking</span>
          <span>50% — Sometimes</span>
          <span>100% — Always</span>
        </div>
      </div>

      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <SLbl>Medications Stopped / Changed</SLbl>
        <Inp
          value={missed}
          onChange={(e) => setMissed(e.target.value)}
          placeholder="e.g. Stopped Glimepiride due to dizziness…"
        />
      </div>

      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <SLbl>Lifestyle</SLbl>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 9 }}>
          {[
            [
              "Exercise",
              exercise,
              setExercise,
              [
                "None / Minimal",
                "Light (10–15 min daily)",
                "Moderate (30 min, 3–4×/week)",
                "Active (40+ min daily)",
              ],
            ],
            [
              "Diet",
              diet,
              setDiet,
              ["High carb / Irregular", "Moderate — watching carbs", "Low carb / Strict"],
            ],
            ["Stress", stress, setStress, ["High", "Moderate", "Low"]],
          ].map(([l, vl, setter, opts]) => (
            <div
              key={l}
              style={{ background: BG, border: `1px solid ${BD}`, borderRadius: 8, padding: 10 }}
            >
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  color: INK3,
                  textTransform: "uppercase",
                  letterSpacing: ".07em",
                  marginBottom: 6,
                }}
              >
                {l}
              </div>
              <select
                value={vl}
                onChange={(e) => setter(e.target.value)}
                style={{
                  border: `1px solid ${BD}`,
                  borderRadius: 6,
                  padding: "6px 8px",
                  fontFamily: FB,
                  fontSize: 11,
                  color: INK,
                  background: WH,
                  outline: "none",
                  width: "100%",
                }}
              >
                {opts.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          boxShadow: SH,
        }}
      >
        <SLbl>Symptoms since last visit</SLbl>
        <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
          <input
            value={symptomInput}
            onChange={(e) => setSymptomInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === ",") && symptomInput.trim()) {
                e.preventDefault();
                const val = symptomInput.trim().replace(/,$/, "");
                if (val && !symptoms.includes(val)) setSymptoms((prev) => [...prev, val]);
                setSymptomInput("");
              }
            }}
            placeholder="Type symptom + Enter (e.g. fatigue, dizziness…)"
            style={{
              flex: 1,
              border: `1px solid ${BD}`,
              borderRadius: 7,
              padding: "7px 10px",
              fontFamily: FB,
              fontSize: 13,
              color: INK,
              outline: "none",
              background: WH,
            }}
          />
          <button
            onClick={() => {
              const val = symptomInput.trim();
              if (val && !symptoms.includes(val)) setSymptoms((prev) => [...prev, val]);
              setSymptomInput("");
            }}
            style={{
              padding: "7px 12px",
              borderRadius: 7,
              border: `1px solid ${BD}`,
              background: WH,
              fontFamily: FB,
              fontSize: 12,
              cursor: "pointer",
              color: T,
              fontWeight: 600,
            }}
          >
            + Add
          </button>
        </div>
        {symptoms.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
            {symptoms.map((s, i) => (
              <span
                key={i}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  background: "#fff7ed",
                  border: `1px solid #fed7aa`,
                  color: "#92400e",
                  borderRadius: 20,
                  padding: "3px 10px",
                  fontSize: 12,
                  fontFamily: FB,
                  fontWeight: 500,
                }}
              >
                {s}
                <span
                  onClick={() => setSymptoms((prev) => prev.filter((_, j) => j !== i))}
                  style={{ cursor: "pointer", opacity: 0.6, fontSize: 11 }}
                >
                  ✕
                </span>
              </span>
            ))}
          </div>
        )}
        <SLbl style={{ marginTop: 4 }}>Notes</SLbl>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Any additional notes…"
          rows={2}
          style={{
            width: "100%",
            border: `1px solid ${BD}`,
            borderRadius: 7,
            padding: "8px 10px",
            fontFamily: FB,
            fontSize: 13,
            color: INK,
            outline: "none",
            resize: "vertical",
            background: WH,
          }}
        />
      </div>
      {viewingDoc && <PdfViewerModal doc={viewingDoc} onClose={() => setViewingDoc(null)} />}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CATEGORIZE & ASSIGN TAB
// ══════════════════════════════════════════════════════════════
function CategorizeTab({ appt, doctors, allAppts, onSave, onContinue }) {
  const [cat, setCat] = useState(appt.category || "");
  const [selDoc, setSelDoc] = useState(appt.doctor_name || "");
  const bio = appt.biomarkers || {};
  const aiCat = bio.hba1c
    ? bio.hba1c > 9
      ? "complex"
      : bio.hba1c > 7
        ? "maint"
        : "ctrl"
    : appt.visit_type === "New Patient"
      ? "new"
      : null;
  const cats = [
    ["complex", "Uncontrolled", RE, REB, "⚠"],
    ["maint", "Maintenance", AM, AMB, "↑"],
    ["ctrl", "Continuous Care", GN, GNB, "✓"],
    ["new", "New Patient", "#b45309", "rgba(180,83,9,.2)", "★"],
  ];

  return (
    <div>
      <div style={{ fontFamily: FD, fontSize: 17, color: INK, marginBottom: 14 }}>
        Categorize & Assign Doctor
      </div>
      {aiCat && (
        <div
          style={{
            borderRadius: 9,
            padding: "12px 14px",
            marginBottom: 14,
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            fontSize: 12,
            ...catSty(aiCat),
            border: `1px solid ${catSty(aiCat).color}44`,
            boxShadow: SH,
          }}
        >
          <div style={{ fontSize: 18, flexShrink: 0 }}>✨</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 3 }}>
              AI Suggestion: {catIcon(aiCat)} {catLabel(aiCat)}
            </div>
            <div style={{ fontSize: 11, lineHeight: 1.5, opacity: 0.85 }}>
              {(() => {
                const h = parseFloat(bio.hba1c);
                const prev = parseFloat(appt.prev_hba1c);
                const hasPrev = !isNaN(prev);
                const improving = hasPrev && h < prev;
                const worsening = hasPrev && h > prev;
                const stable = hasPrev && !improving && !worsening;

                // Tier-1/Tier-2 composite check — flips the headline label to
                // "Mixed" when HbA1c is improving but a Tier-2 marker (FBS,
                // LDL, TG, UACR, eGFR) or SBP is moving the wrong way.
                const prevBio = appt.prev_biomarkers || {};
                const composite = classifyComposite({
                  hba1c: { cur: h, prev: hasPrev ? prev : null },
                  sbp: { cur: parseFloat(bio.sbp), prev: parseFloat(prevBio.sbp) },
                  fg: { cur: parseFloat(bio.fg), prev: parseFloat(prevBio.fg) },
                  ldl: { cur: parseFloat(bio.ldl), prev: parseFloat(prevBio.ldl) },
                  tg: { cur: parseFloat(bio.tg), prev: parseFloat(prevBio.tg) },
                  uacr: { cur: parseFloat(bio.uacr), prev: parseFloat(prevBio.uacr) },
                  egfr: { cur: parseFloat(bio.egfr), prev: parseFloat(prevBio.egfr) },
                });

                let trendText = "";
                let trajectoryLabel = "";
                let trajectoryColor = INK3;

                if (improving) {
                  trendText = `↓ improving from ${prev}%`;
                  trajectoryLabel =
                    h <= 7
                      ? "Getting better — at target ✓"
                      : h <= 9
                        ? `Getting better — HbA1c ${h}%, not at target yet`
                        : `Getting better — still critically high at ${h}%`;
                  trajectoryColor = GN;
                } else if (worsening) {
                  trendText = `↑ worsening from ${prev}%`;
                  trajectoryLabel =
                    h > 9
                      ? `Getting worse — critically uncontrolled at ${h}%`
                      : h > 7
                        ? `Getting worse — HbA1c rising to ${h}%`
                        : `Getting worse — rising but still at target (${h}%)`;
                  trajectoryColor = RE;
                } else if (stable) {
                  trendText = `→ unchanged from ${prev}%`;
                  trajectoryLabel =
                    h > 9
                      ? `⚠ Stuck — critically uncontrolled at ${h}%. No improvement.`
                      : h > 7
                        ? `Not improving — stuck at ${h}%`
                        : `At target & stable ✓`;
                  trajectoryColor = h > 9 ? RE : h > 7 ? AM : GN;
                } else {
                  trajectoryLabel =
                    h > 9
                      ? "Uncontrolled. Needs senior review."
                      : h > 7
                        ? "Not at target yet."
                        : "At target. Routine care.";
                }

                // If composite says mixed, override the colour and append
                // the conflict reason — never let the label say "Better"
                // when a Tier-2 marker is heading the wrong way.
                const mixedNote =
                  composite.outcome === "mixed" && composite.conflicts.length > 0
                    ? composite.conflicts[0]
                    : null;
                if (mixedNote) {
                  trajectoryColor = AM;
                  trajectoryLabel = `⚠ Mixed signals — ${mixedNote}`;
                }

                return (
                  <>
                    Based on HbA1c <b>{bio.hba1c}%</b> {trendText}
                    <br />
                    <span style={{ fontWeight: 600, color: trajectoryColor }}>
                      {trajectoryLabel}
                    </span>
                  </>
                );
              })()}
            </div>
          </div>
          <button
            onClick={() => setCat(aiCat)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              fontSize: 10,
              fontWeight: 600,
              background: "rgba(255,255,255,.55)",
              border: "1px solid currentColor",
              cursor: "pointer",
              fontFamily: FB,
              flexShrink: 0,
            }}
          >
            Use →
          </button>
        </div>
      )}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <SLbl>Category</SLbl>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {cats.map(([v, l, color, bdr, ico]) => (
            <button
              key={v}
              onClick={() => setCat(v)}
              style={{
                padding: "9px 18px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                border: `2px solid ${cat === v ? color : BD}`,
                cursor: "pointer",
                fontFamily: FB,
                background: cat === v ? color : WH,
                color: cat === v ? "#fff" : color,
                transition: "all .15s",
              }}
            >
              {ico} {l}
            </button>
          ))}
        </div>
      </div>
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 14,
          boxShadow: SH,
        }}
      >
        <SLbl>Assign Doctor</SLbl>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {doctors
            .filter((d) => d.name)
            .map((d) => {
              const cnt = allAppts.filter((a) => a.doctor_name === d.name).length;
              const pct = Math.min(Math.round((cnt / 25) * 100), 100);
              const isSel = selDoc === d.name;
              return (
                <div
                  key={d.id}
                  onClick={() => setSelDoc(d.name)}
                  style={{
                    background: isSel ? TL : WH,
                    border: `2px solid ${isSel ? T : BD}`,
                    borderRadius: 9,
                    padding: "11px 14px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    transition: "all .15s",
                    position: "relative",
                  }}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: "50%",
                      background: SKL,
                      color: SK,
                      border: `2px solid ${SKB}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 12,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {(d.name || "")
                      .replace(/^Dr\.\s*/i, "")
                      .substring(0, 2)
                      .toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 1 }}>
                      {d.name}
                    </div>
                    <div
                      style={{
                        fontSize: 9,
                        color: INK3,
                        marginBottom: 5,
                        textTransform: "uppercase",
                        letterSpacing: ".06em",
                      }}
                    >
                      {d.role}
                      {d.speciality ? ` · ${d.speciality}` : ""}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <div
                        style={{
                          height: 3,
                          background: BD,
                          borderRadius: 2,
                          overflow: "hidden",
                          width: 60,
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            background: pct > 80 ? RE : T,
                            borderRadius: 2,
                            width: `${pct}%`,
                            transition: "width .4s",
                          }}
                        />
                      </div>
                      <span style={{ fontSize: 10, color: INK3, fontFamily: FM }}>
                        {cnt}/25 today
                      </span>
                    </div>
                  </div>
                  {isSel && (
                    <span style={{ fontSize: 18, color: T, position: "absolute", right: 13 }}>
                      ✓
                    </span>
                  )}
                </div>
              );
            })}
        </div>
      </div>
      <button
        onClick={() => {
          if (cat && selDoc) {
            onSave(cat, selDoc);
            onContinue && onContinue();
          }
        }}
        disabled={!cat || !selDoc}
        style={{
          padding: "10px 22px",
          borderRadius: 8,
          background: cat && selDoc ? T : "#94a3b8",
          color: "#fff",
          border: "none",
          fontSize: 13,
          fontWeight: 600,
          cursor: cat && selDoc ? "pointer" : "not-allowed",
          fontFamily: FB,
        }}
      >
        ✓ Confirm & Continue →
      </button>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// CHECK-IN TAB
// ══════════════════════════════════════════════════════════════
function CheckInTab({ appt, onCheckIn, onMarkSeen }) {
  const ps = appt.prep_steps || {},
    ready = isReady(appt);
  const checklist = [
    { t: "Biomarkers entered", done: ps.biomarkers },
    { t: "Compliance reviewed", done: ps.compliance },
    { t: `Category: ${appt.category ? catLabel(appt.category) : "Not set"}`, done: ps.categorized },
    { t: `Doctor: ${appt.doctor_name || "Not assigned"}`, done: ps.assigned },
  ];
  const isCI = appt.status === "checkedin",
    isIV = appt.status === "in_visit",
    isSeen = appt.status === "seen" || appt.status === "completed";

  return (
    <div>
      <div
        style={{
          borderRadius: 9,
          padding: "14px 16px",
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          gap: 13,
          boxShadow: SH,
          background: isIV ? "#f5f3ff" : isCI ? SKL : isSeen ? GNL : ready ? GNL : AML,
          border: `1px solid ${isIV ? "rgba(124,58,237,.2)" : isCI ? SKB : isSeen ? GNB : ready ? GNB : AMB}`,
        }}
      >
        <div style={{ fontSize: 26 }}>
          {isIV ? "🩺" : isCI ? "🔵" : isSeen ? "✅" : ready ? "✅" : "⏳"}
        </div>
        <div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 3,
              color: isIV ? "#7c3aed" : isCI ? SK : isSeen ? GN : ready ? GN : AM,
            }}
          >
            {isIV
              ? "Doctor is seeing the patient"
              : isCI
                ? "Patient checked in — ready to start visit"
                : isSeen
                  ? "Visit completed"
                  : ready
                    ? "Ready to check in"
                    : "Complete prep steps first"}
          </div>
          <div
            style={{
              fontSize: 11,
              color: INK3,
              lineHeight: 1.5,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {isIV ? (
              <>
                Visit in progress. End visit from the visit page.
                <WaitTime checkedInAt={appt.checked_in_at} />
              </>
            ) : isCI ? (
              <>
                Waiting for doctor.
                <WaitTime checkedInAt={appt.checked_in_at} />
              </>
            ) : isSeen ? (
              "This appointment has been completed."
            ) : ready ? (
              "All steps done. Check in when patient arrives."
            ) : (
              "All 4 prep steps must be completed."
            )}
          </div>
        </div>
      </div>
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 14,
          marginBottom: 14,
          boxShadow: SH,
        }}
      >
        <SLbl>Pre-Visit Checklist</SLbl>
        <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
          {checklist.map((c, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 12px",
                background: c.done ? GNL : BG,
                border: `1px solid ${c.done ? GNB : BD}`,
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  border: `2px solid ${c.done ? GN : BD2}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  flexShrink: 0,
                  background: c.done ? GN : WH,
                  color: c.done ? "#fff" : INK3,
                }}
              >
                {c.done ? "✓" : ""}
              </div>
              <div style={{ fontSize: 12, fontWeight: 500, color: c.done ? GN : INK }}>{c.t}</div>
            </div>
          ))}
        </div>
      </div>
      {!isSeen && !isIV && (
        <div style={{ display: "flex", gap: 9 }}>
          {!isCI && (
            <button
              onClick={onCheckIn}
              disabled={!ready}
              style={{
                padding: "10px 22px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                background: ready ? SK : "#94a3b8",
                color: "#fff",
                border: "none",
                cursor: ready ? "pointer" : "not-allowed",
                fontFamily: FB,
              }}
            >
              ✓ Check In Patient
            </button>
          )}
          {isCI && (
            <button
              onClick={onMarkSeen}
              style={{
                padding: "10px 22px",
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                background: GN,
                color: "#fff",
                border: "none",
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              🩺 Start Visit
            </button>
          )}
        </div>
      )}
      {isCI && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            background: SKL,
            border: `1px solid ${SKB}`,
            borderRadius: 8,
            fontSize: 12,
            color: SK,
            fontWeight: 500,
          }}
        >
          📏 Patient is checked in — record <strong>Vitals</strong> then click{" "}
          <strong>Start Visit</strong> when doctor is ready
        </div>
      )}
      {isIV && (
        <div
          style={{
            marginTop: 14,
            padding: "10px 14px",
            background: "#f5f3ff",
            border: "1px solid rgba(124,58,237,.2)",
            borderRadius: 8,
            fontSize: 12,
            color: "#7c3aed",
            fontWeight: 500,
          }}
        >
          🩺 Visit in progress — the doctor will end the visit from the visit page
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// PATIENT DETAIL PANEL
// ══════════════════════════════════════════════════════════════
function PatientDetail({
  appt,
  doctors,
  activeTab,
  setActiveTab,
  onPatchStatus,
  onPatchPrep,
  onPostBiomarkers,
  onPostCompliance,
  onPatchCategoryDoc,
  onPostVitals,
  allAppts,
  showToast,
}) {
  const navigate = useNavigate();
  const setDbPatientId = usePatientStore((s) => s.setDbPatientId);
  const setPatient = usePatientStore((s) => s.setPatient);
  const ps = appt.prep_steps || {},
    ss = statusSty(appt.status);
  const showVitals =
    appt.status === "checkedin" ||
    appt.status === "in_visit" ||
    appt.status === "seen" ||
    appt.status === "completed";
  const STEPS = [
    { k: "biomarkers", l: "Labs" },
    { k: "compliance", l: "Compliance" },
    { k: "categorized", l: "Category" },
    { k: "assigned", l: "Doctor" },
  ];
  const TABS = [
    ["overview", "📊 Overview"],
    ["biomarkers", "🧪 Labs"],
    ["compliance", "💊 Medicine"],
    ["categorize", "🏷 Assign"],
    ["checkin", "✓ Check In"],
    ...(showVitals ? [["vitals", "📏 Vitals"]] : []),
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Header */}
      <div
        className="opd-detail-header"
        style={{
          background: WH,
          borderBottom: `1px solid ${BD}`,
          padding: "16px 20px",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="opd-detail-name"
              style={{
                fontFamily: FD,
                fontSize: 23,
                fontWeight: 700,
                color: INK,
                marginBottom: 4,
                lineHeight: 1.1,
              }}
            >
              {appt.patient_name || "—"}
            </div>
            {/* Age · Sex · File no — always shown */}
            <div style={{ fontFamily: FM, fontSize: 11, color: INK3, marginBottom: 5 }}>
              {`${appt.age ? appt.age + "Y" : "—"} · ${appt.sex || "—"} · ${appt.file_no || "—"}`}
            </div>
            <div
              style={{
                display: "flex",
                gap: 6,
                flexWrap: "wrap",
                alignItems: "center",
                marginBottom: appt.last_visit_date ? 5 : 0,
              }}
            >
              <VisitChip a={appt} />
              {appt.visit_count && (
                <span style={{ fontFamily: FM, fontSize: 10, fontWeight: 600, color: SK }}>
                  Visit #{appt.visit_count}
                </span>
              )}
              {appt.category && (
                <span
                  style={{
                    fontSize: 9,
                    padding: "2px 9px",
                    borderRadius: 10,
                    fontWeight: 600,
                    ...catSty(appt.category),
                  }}
                >
                  {catIcon(appt.category)} {catLabel(appt.category)}
                </span>
              )}
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: 5,
                  background: ss.bg,
                  color: ss.color,
                }}
              >
                {ss.label}
              </span>
            </div>
            {appt.last_visit_date &&
              (() => {
                const ds = daysSince(appt.last_visit_date);
                return (
                  <div style={{ fontSize: 10, color: INK3, fontFamily: FB }}>
                    📅 {fmtDate(appt.last_visit_date)}
                    {ds !== null && (
                      <span
                        style={{
                          color: visitGapColor(appt.last_visit_date, appt.appointment_date),
                          fontWeight: 600,
                        }}
                      >
                        {" "}
                        · {ds} days since last visit
                      </span>
                    )}
                  </div>
                );
              })()}
          </div>
          <div
            className="opd-detail-actions"
            style={{ display: "flex", gap: 7, flexShrink: 0, flexWrap: "wrap" }}
          >
            {appt.phone && (
              <a
                href={`https://wa.me/91${appt.phone}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  padding: "7px 13px",
                  borderRadius: 7,
                  fontSize: 11,
                  fontWeight: 600,
                  background: "#25D366",
                  color: "#fff",
                  textDecoration: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                📱 WhatsApp
              </a>
            )}
            {appt.status !== "checkedin" &&
              appt.status !== "in_visit" &&
              appt.status !== "seen" &&
              appt.status !== "completed" &&
              isReady(appt) && (
                <button
                  onClick={() => onPatchStatus(appt.id, "checkedin")}
                  style={{
                    padding: "7px 13px",
                    borderRadius: 7,
                    fontSize: 11,
                    fontWeight: 600,
                    background: SK,
                    color: "#fff",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: FB,
                  }}
                >
                  ✓ Check In
                </button>
              )}
            {appt.status === "checkedin" && (
              <a
                href={
                  appt.patient_id
                    ? `/visit?patient=${encodeURIComponent(appt.patient_id)}&appt=${encodeURIComponent(appt.id)}`
                    : "#"
                }
                onClick={async (e) => {
                  if (!appt.patient_id) {
                    e.preventDefault();
                    return;
                  }
                  const newTab = e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
                  if (!newTab) e.preventDefault();
                  await onPatchStatus(appt.id, "in_visit");
                  sessionStorage.setItem("gini_opd_appt_id", String(appt.id));
                  sessionStorage.setItem("gini_opd_patient_id", String(appt.patient_id));
                  sessionStorage.setItem("gini_visit_start", new Date().toISOString());
                  setDbPatientId(appt.patient_id);
                  sessionStorage.setItem("gini_active_patient", String(appt.patient_id));
                  if (!newTab) navigate("/visit");
                }}
                style={{
                  padding: "7px 13px",
                  borderRadius: 7,
                  fontSize: 11,
                  fontWeight: 600,
                  background: GN,
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  fontFamily: FB,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                🩺 Start Visit
              </a>
            )}
            <a
              href={
                appt.patient_id
                  ? `/visit?patient=${encodeURIComponent(appt.patient_id)}&appt=${encodeURIComponent(appt.id)}`
                  : "#"
              }
              onClick={(e) => {
                if (!appt.patient_id) {
                  e.preventDefault();
                  return;
                }
                setPatient({
                  name: appt.patient_name || "",
                  phone: appt.phone || "",
                  age: appt.age || "",
                  sex: appt.sex || "Male",
                  fileNo: appt.file_no || "",
                  dob: "",
                  abhaId: "",
                  healthId: "",
                  aadhaar: "",
                  govtId: "",
                  govtIdType: "",
                  address: "",
                });
                setDbPatientId(appt.patient_id);
                sessionStorage.setItem("gini_active_patient", String(appt.patient_id));
                sessionStorage.setItem("gini_opd_appt_id", String(appt.id));
                sessionStorage.setItem("gini_opd_patient_id", String(appt.patient_id));
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
                e.preventDefault();
                navigate("/visit");
              }}
              style={{
                padding: "7px 13px",
                borderRadius: 7,
                fontSize: 11,
                fontWeight: 600,
                background: BG,
                border: `1px solid ${BD}`,
                color: INK2,
                cursor: "pointer",
                fontFamily: FB,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
              }}
            >
              🩺 Open Scribe
            </a>
          </div>
        </div>
        {/* Step bar */}
        <div className="opd-step-bar" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s.k}>
              <div
                className="opd-step"
                style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}
              >
                <div
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    border: `2px solid ${ps[s.k] ? T : BD2}`,
                    background: ps[s.k] ? T : WH,
                    color: ps[s.k] ? "#fff" : INK3,
                  }}
                >
                  {ps[s.k] ? "✓" : i + 1}
                </div>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: ps[s.k] ? T : INK3,
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.l}
                </span>
              </div>
              {i < 3 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    background: ps[s.k] ? T : BD,
                    margin: "0 8px",
                    minWidth: 16,
                    borderRadius: 1,
                  }}
                />
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
      {/* Tabs */}
      <div
        style={{
          display: "flex",
          background: WH,
          borderBottom: `1px solid ${BD}`,
          flexShrink: 0,
          padding: "0 16px",
          overflowX: "auto",
        }}
      >
        {TABS.map(([id, lbl]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            style={{
              padding: "9px 13px",
              fontSize: 11,
              fontWeight: 600,
              color: activeTab === id ? T : INK3,
              cursor: "pointer",
              background: "transparent",
              border: "none",
              borderBottom: activeTab === id ? `2px solid ${T}` : "2px solid transparent",
              transition: "all .15s",
              whiteSpace: "nowrap",
              fontFamily: FB,
            }}
          >
            {lbl}
          </button>
        ))}
      </div>
      {/* Pane */}
      <div style={{ flex: 1, overflowY: "auto", padding: "18px 20px" }}>
        {activeTab === "overview" && (
          <OverviewTab
            appt={appt}
            setTab={setActiveTab}
            onCheckIn={() => onPatchStatus(appt.id, "checkedin")}
          />
        )}
        {activeTab === "biomarkers" && (
          <BiomarkersTab
            appt={appt}
            onSave={(d) => onPostBiomarkers(appt.id, d)}
            onContinue={() => setActiveTab("compliance")}
            showToast={showToast}
          />
        )}
        {activeTab === "compliance" && (
          <ComplianceTab
            appt={appt}
            onSave={(d) => onPostCompliance(appt.id, d)}
            onContinue={() => setActiveTab("categorize")}
            showToast={showToast}
          />
        )}
        {activeTab === "categorize" && (
          <CategorizeTab
            appt={appt}
            doctors={doctors}
            allAppts={allAppts}
            onSave={(cat, doc) => {
              onPatchCategoryDoc(appt.id, cat, doc);
              onPatchPrep(appt.id, "categorized");
              onPatchPrep(appt.id, "assigned");
            }}
            onContinue={() => setActiveTab("checkin")}
          />
        )}
        {activeTab === "checkin" && (
          <CheckInTab
            appt={appt}
            onCheckIn={() => onPatchStatus(appt.id, "checkedin")}
            onMarkSeen={async (e) => {
              if (appt.patient_id) {
                await onPatchStatus(appt.id, "in_visit");
                sessionStorage.setItem("gini_opd_appt_id", String(appt.id));
                sessionStorage.setItem("gini_opd_patient_id", String(appt.patient_id));
                setPatient({
                  name: appt.patient_name || "",
                  phone: appt.phone || "",
                  age: appt.age || "",
                  sex: appt.sex || "Male",
                  fileNo: appt.file_no || "",
                  dob: "",
                  abhaId: "",
                  healthId: "",
                  aadhaar: "",
                  govtId: "",
                  govtIdType: "",
                  address: "",
                });
                setDbPatientId(appt.patient_id);
                sessionStorage.setItem("gini_active_patient", String(appt.patient_id));
                sessionStorage.setItem("gini_opd_appt_id", String(appt.id));
                sessionStorage.setItem("gini_opd_patient_id", String(appt.patient_id));
                if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
                  const url = `/visit?patient=${encodeURIComponent(appt.patient_id)}&appt=${encodeURIComponent(appt.id)}`;
                  window.open(url, "_blank", "noopener,noreferrer");
                } else {
                  navigate("/visit");
                }
              }
            }}
          />
        )}
        {activeTab === "vitals" && showVitals && (
          <VitalsTab appt={appt} onSave={(d) => onPostVitals(appt.id, d)} />
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// NEW PATIENT REGISTRATION FORM
// ══════════════════════════════════════════════════════════════
function NewPatientForm({ onCreated, onBack, showToast }) {
  const [showIds, setShowIds] = useState(false);
  const [saving, setSaving] = useState(false);
  const [p, setP] = useState({
    name: "",
    dob: "",
    sex: "Female",
    phone: "",
    file_no: "",
    email: "",
    blood_group: "",
    address: "",
    abha_id: "",
    health_id: "",
    genie_id: "",
    aadhaar: "",
    govt_id_type: "",
    govt_id: "",
  });
  const set = (k, v) => setP((prev) => ({ ...prev, [k]: v }));

  const sel = (label, key, opts) => (
    <div>
      <Lbl>{label}</Lbl>
      <select
        value={p[key]}
        onChange={(e) => set(key, e.target.value)}
        style={{
          border: `1px solid ${BD}`,
          borderRadius: 7,
          padding: "8px 11px",
          fontSize: 13,
          color: INK,
          background: WH,
          outline: "none",
          width: "100%",
          fontFamily: FB,
        }}
      >
        {opts.map((o) =>
          Array.isArray(o) ? (
            <option key={o[0]} value={o[0]}>
              {o[1]}
            </option>
          ) : (
            <option key={o}>{o}</option>
          ),
        )}
      </select>
    </div>
  );

  const handleCreate = async () => {
    if (!p.name) {
      showToast("Full name is required", "err");
      return;
    }
    setSaving(true);
    try {
      const r = await apiFetch("/api/patients", { method: "POST", body: JSON.stringify(p) });
      const data = await r.json();
      if (data.id) {
        onCreated(data);
        showToast(`✓ Patient ${data._isNew ? "created" : "updated"}`);
      } else showToast(data.error || "Could not create patient", "err");
    } catch {
      showToast("Network error", "err");
    }
    setSaving(false);
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
        <button
          onClick={onBack}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 16,
            color: INK3,
            padding: 0,
          }}
        >
          ←
        </button>
        <div>
          <div style={{ fontFamily: FD, fontSize: 18, color: INK }}>Register New Patient</div>
          <div style={{ fontSize: 11, color: INK3, marginTop: 2 }}>
            Patient not found — fill in details to create a new record
          </div>
        </div>
      </div>

      {/* Basic info */}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          padding: 16,
          marginBottom: 12,
          boxShadow: SH,
        }}
      >
        <SLbl>Patient Details</SLbl>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{ gridColumn: "1/-1" }}>
            <Lbl>Full Name *</Lbl>
            <Inp
              value={p.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Harpreet Singh Mann"
            />
          </div>
          <div>
            <Lbl>Date of Birth</Lbl>
            <Inp value={p.dob} onChange={(e) => set("dob", e.target.value)} type="date" />
          </div>
          {sel("Gender", "sex", ["Female", "Male", "Other"])}
          <div>
            <Lbl>File Number</Lbl>
            <Inp
              value={p.file_no}
              onChange={(e) => set("file_no", e.target.value)}
              placeholder="e.g. GS-1042"
            />
          </div>
          <div>
            <Lbl>Phone Number *</Lbl>
            <Inp
              value={p.phone}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="9814XXXXXX"
              type="tel"
            />
          </div>
          <div>
            <Lbl>Email (optional)</Lbl>
            <Inp
              value={p.email}
              onChange={(e) => set("email", e.target.value)}
              placeholder="patient@email.com"
              type="email"
            />
          </div>
          {sel("Blood Group", "blood_group", [
            "",
            "A+",
            "A-",
            "B+",
            "B-",
            "O+",
            "O-",
            "AB+",
            "AB-",
          ])}
          <div style={{ gridColumn: "1/-1" }}>
            <Lbl>Address</Lbl>
            <textarea
              value={p.address}
              onChange={(e) => set("address", e.target.value)}
              placeholder="House no., Street, City, State…"
              rows={2}
              style={{
                border: `1px solid ${BD}`,
                borderRadius: 7,
                padding: "8px 11px",
                fontSize: 13,
                color: INK,
                outline: "none",
                background: WH,
                width: "100%",
                fontFamily: FB,
                resize: "none",
              }}
            />
          </div>
        </div>
      </div>

      {/* Health & Govt IDs */}
      <div
        style={{
          background: WH,
          border: `1px solid ${BD}`,
          borderRadius: 10,
          marginBottom: 16,
          boxShadow: SH,
          overflow: "hidden",
        }}
      >
        <button
          onClick={() => setShowIds((s) => !s)}
          style={{
            width: "100%",
            padding: "12px 16px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: FB,
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: INK }}>
            🪪 Health & Government IDs{" "}
            <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>(optional)</span>
          </span>
          <span
            style={{
              fontSize: 11,
              color: INK3,
              transition: "transform .2s",
              display: "inline-block",
              transform: showIds ? "rotate(90deg)" : "none",
            }}
          >
            ▶
          </span>
        </button>
        {showIds && (
          <div
            style={{
              padding: "0 16px 16px",
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 10,
              borderTop: `1px solid ${BD}`,
            }}
          >
            <div>
              <Lbl>ABHA ID</Lbl>
              <Inp
                value={p.abha_id}
                onChange={(e) => set("abha_id", e.target.value)}
                placeholder="XX-XXXX-XXXX-XXXX"
              />
            </div>
            <div>
              <Lbl>Health ID</Lbl>
              <Inp
                value={p.health_id}
                onChange={(e) => set("health_id", e.target.value)}
                placeholder="Health ID"
              />
            </div>
            <div>
              <Lbl>MyHealth Genie ID</Lbl>
              <Inp
                value={p.genie_id}
                onChange={(e) => set("genie_id", e.target.value)}
                placeholder="Genie ID"
              />
            </div>
            <div>
              <Lbl>Aadhaar</Lbl>
              <Inp
                value={p.aadhaar}
                onChange={(e) => set("aadhaar", e.target.value)}
                placeholder="XXXX XXXX XXXX"
              />
            </div>
            <div>
              {sel("Other ID Type", "govt_id_type", [
                ["", "— Select type"],
                "Passport",
                "Driver's License",
                "Voter ID",
                "PAN Card",
              ])}
            </div>
            <div>
              <Lbl>ID Number</Lbl>
              <Inp
                value={p.govt_id}
                onChange={(e) => set("govt_id", e.target.value)}
                placeholder="ID number"
              />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 9 }}>
        <button
          onClick={onBack}
          style={{
            padding: "9px 18px",
            borderRadius: 8,
            fontSize: 12,
            fontWeight: 600,
            background: WH,
            border: `1px solid ${BD}`,
            color: INK2,
            cursor: "pointer",
            fontFamily: FB,
          }}
        >
          ← Back
        </button>
        <button
          onClick={handleCreate}
          disabled={saving}
          style={{
            padding: "9px 24px",
            borderRadius: 8,
            fontSize: 13,
            fontWeight: 600,
            background: T,
            color: "#fff",
            border: "none",
            cursor: saving ? "not-allowed" : "pointer",
            fontFamily: FB,
            boxShadow: "0 2px 8px rgba(0,158,140,.25)",
          }}
        >
          {saving ? "Creating…" : "Create Patient & Continue →"}
        </button>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// NEW APPOINTMENT VIEW (3 steps)
// ══════════════════════════════════════════════════════════════
function NewApptView({ doctors, onSaved, onCancel, showToast }) {
  const [mode, setMode] = useState("search"); // search | register | details
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [selPt, setSelPt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    appointment_date: new Date().toISOString().split("T")[0],
    time_slot: "",
    visit_type: "OPD",
    doctor_name: "",
    notes: "",
    is_walkin: false,
  });

  useEffect(() => {
    if (search.length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      apiFetch(`/api/patients?q=${encodeURIComponent(search)}`)
        .then((r) => r.json())
        .then((d) => setResults(Array.isArray(d?.data) ? d.data.slice(0, 8) : []))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const handleSave = async () => {
    if (!selPt) {
      showToast("Select a patient first", "err");
      return;
    }
    setSaving(true);
    try {
      const r = await apiFetch("/api/appointments", {
        method: "POST",
        body: JSON.stringify({
          patient_id: selPt.id,
          patient_name: selPt.name,
          file_no: selPt.file_no,
          phone: selPt.phone,
          doctor_name: form.doctor_name || null,
          appointment_date: form.appointment_date,
          time_slot: form.time_slot || null,
          visit_type: form.visit_type,
          notes: form.notes || null,
          is_walkin: form.is_walkin,
        }),
      });
      const data = await r.json();
      setSaving(false);
      if (data.id) onSaved(data);
      else {
        const msg = data.details?.length
          ? data.details.join(", ")
          : data.error || "Error creating appointment";
        showToast(msg, "err");
      }
    } catch {
      setSaving(false);
      showToast("Network error", "err");
    }
  };

  const sty = (active) => ({
    padding: "5px 14px",
    borderRadius: 20,
    fontSize: 11,
    fontWeight: 600,
    border: "none",
    cursor: "pointer",
    fontFamily: FB,
    background: active ? NV : "transparent",
    color: active ? "#fff" : INK3,
    transition: "all .15s",
  });

  // ── SEARCH ──
  if (mode === "search")
    return (
      <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div
          style={{
            background: WH,
            borderBottom: `1px solid ${BD}`,
            padding: "14px 20px",
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <button
            onClick={onCancel}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              fontSize: 18,
              color: INK3,
              padding: 0,
            }}
          >
            ←
          </button>
          <div style={{ fontFamily: FD, fontSize: 18, color: INK }}>Find Patient</div>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              background: WH,
              border: `2px solid ${BD}`,
              borderRadius: 10,
              padding: "10px 14px",
              marginBottom: 14,
              boxShadow: SH,
            }}
          >
            <span style={{ fontSize: 18, color: INK3 }}>🔍</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              placeholder="Search by name, phone number, or file number…"
              style={{
                flex: 1,
                border: "none",
                outline: "none",
                fontFamily: FB,
                fontSize: 14,
                color: INK,
                background: "transparent",
              }}
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  color: INK3,
                  fontSize: 18,
                }}
              >
                ×
              </button>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7, marginBottom: 14 }}>
            {results.map((p) => (
              <div
                key={p.id}
                onClick={() => {
                  setSelPt(p);
                  setMode("details");
                }}
                style={{
                  background: WH,
                  border: `1px solid ${BD}`,
                  borderRadius: 9,
                  padding: "12px 14px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  boxShadow: SH,
                  transition: "border-color .15s",
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "#e8edf4",
                    color: NV,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 14,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {(p.name || "?").substring(0, 2).toUpperCase()}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: FD, fontSize: 15, color: INK, marginBottom: 3 }}>
                    {p.name}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    {p.file_no && (
                      <span
                        style={{
                          fontFamily: FM,
                          fontSize: 10,
                          background: TL,
                          color: T,
                          padding: "1px 7px",
                          borderRadius: 4,
                        }}
                      >
                        {p.file_no}
                      </span>
                    )}
                    {p.phone && (
                      <span style={{ fontFamily: FM, fontSize: 10, color: INK3 }}>{p.phone}</span>
                    )}
                    {p.age && (
                      <span style={{ fontSize: 10, color: INK3 }}>
                        {p.age}y {p.sex || ""}
                      </span>
                    )}
                    {p.dob && <span style={{ fontSize: 10, color: INK3 }}>{fmtDate(p.dob)}</span>}
                  </div>
                </div>
                <span style={{ color: T, fontSize: 20 }}>→</span>
              </div>
            ))}
          </div>

          {search.length >= 2 && results.length === 0 && (
            <div
              style={{
                textAlign: "center",
                color: INK3,
                padding: 20,
                fontSize: 12,
                background: WH,
                borderRadius: 9,
                border: `1px solid ${BD}`,
                marginBottom: 14,
              }}
            >
              No patients found for "{search}"
            </div>
          )}

          <div
            onClick={() => setMode("register")}
            style={{
              background: WH,
              border: `2px dashed ${BD}`,
              borderRadius: 9,
              padding: 16,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 12,
              boxShadow: SH,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: "50%",
                background: TL,
                color: T,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 18,
                flexShrink: 0,
              }}
            >
              ➕
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: INK, marginBottom: 2 }}>
                Register New Patient
              </div>
              <div style={{ fontSize: 11, color: INK3 }}>
                Patient not in system — create a new record with full details
              </div>
            </div>
          </div>
        </div>
      </div>
    );

  // ── REGISTER ──
  if (mode === "register")
    return (
      <NewPatientForm
        showToast={showToast}
        onBack={() => setMode("search")}
        onCreated={(pt) => {
          setSelPt(pt);
          setMode("details");
        }}
      />
    );

  // ── DETAILS ──
  return (
    <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          background: WH,
          borderBottom: `1px solid ${BD}`,
          padding: "14px 20px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={() => setMode("search")}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 18,
            color: INK3,
            padding: 0,
          }}
        >
          ←
        </button>
        <div style={{ fontFamily: FD, fontSize: 18, color: INK }}>Appointment Details</div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
        {/* Patient card */}
        {selPt && (
          <div
            style={{
              background: TL,
              border: `1px solid ${TB}`,
              borderRadius: 9,
              padding: "12px 14px",
              marginBottom: 16,
              display: "flex",
              alignItems: "center",
              gap: 12,
              boxShadow: SH,
            }}
          >
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: "50%",
                background: T,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 14,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {(selPt.name || "?").substring(0, 2).toUpperCase()}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: FD, fontSize: 15, color: INK, marginBottom: 3 }}>
                {selPt.name}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {selPt.file_no && (
                  <span style={{ fontFamily: FM, fontSize: 10, color: T }}>{selPt.file_no}</span>
                )}
                {selPt.phone && (
                  <span style={{ fontFamily: FM, fontSize: 10, color: INK3 }}>{selPt.phone}</span>
                )}
                {selPt.age && (
                  <span style={{ fontSize: 10, color: INK3 }}>
                    {selPt.age}y {selPt.sex || ""}
                  </span>
                )}
                {selPt.dob && (
                  <span style={{ fontSize: 10, color: INK3 }}>{fmtDate(selPt.dob)}</span>
                )}
              </div>
            </div>
            <button
              onClick={() => setMode("search")}
              style={{
                fontSize: 11,
                color: INK3,
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: FB,
                fontWeight: 600,
              }}
            >
              Change →
            </button>
          </div>
        )}

        <div
          style={{
            background: WH,
            border: `1px solid ${BD}`,
            borderRadius: 10,
            padding: 16,
            marginBottom: 14,
            boxShadow: SH,
          }}
        >
          <SLbl>Schedule</SLbl>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}
          >
            <div>
              <Lbl>Date *</Lbl>
              <Inp
                value={form.appointment_date}
                onChange={(e) => setForm((f) => ({ ...f, appointment_date: e.target.value }))}
                type="date"
              />
            </div>
            <div>
              <Lbl>Time Slot</Lbl>
              <Inp
                value={form.time_slot}
                onChange={(e) => setForm((f) => ({ ...f, time_slot: e.target.value }))}
                placeholder="09:30"
                type="time"
              />
            </div>
            <div>
              <Lbl>Visit Type</Lbl>
              <select
                value={form.visit_type}
                onChange={(e) => setForm((f) => ({ ...f, visit_type: e.target.value }))}
                style={{
                  border: `1px solid ${BD}`,
                  borderRadius: 7,
                  padding: "8px 11px",
                  fontSize: 13,
                  color: INK,
                  outline: "none",
                  background: WH,
                  width: "100%",
                  fontFamily: FB,
                }}
              >
                {["OPD", "Follow-Up", "New Patient", "Emergency", "Online"].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <Lbl>Assign Doctor</Lbl>
              <select
                value={form.doctor_name}
                onChange={(e) => setForm((f) => ({ ...f, doctor_name: e.target.value }))}
                style={{
                  border: `1px solid ${BD}`,
                  borderRadius: 7,
                  padding: "8px 11px",
                  fontSize: 13,
                  color: INK,
                  outline: "none",
                  background: WH,
                  width: "100%",
                  fontFamily: FB,
                }}
              >
                <option value="">— Assign later</option>
                {doctors
                  .filter((d) => d.name)
                  .map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div style={{ marginBottom: 10 }}>
            <Lbl>Reason / Notes</Lbl>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={2}
              placeholder="e.g. High sugar, fatigue, referred by Dr. Rajan…"
              style={{
                border: `1px solid ${BD}`,
                borderRadius: 7,
                padding: "8px 11px",
                fontSize: 13,
                color: INK,
                outline: "none",
                background: WH,
                width: "100%",
                fontFamily: FB,
                resize: "none",
              }}
            />
          </div>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 500,
              color: INK,
            }}
          >
            <input
              type="checkbox"
              checked={form.is_walkin}
              onChange={(e) => setForm((f) => ({ ...f, is_walkin: e.target.checked }))}
              style={{ accentColor: AM, width: 15, height: 15 }}
            />
            Mark as Walk-In
            <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
              (patient arrived without appointment)
            </span>
          </label>
        </div>

        <div style={{ display: "flex", gap: 9 }}>
          <button
            onClick={() => setMode("search")}
            style={{
              padding: "9px 18px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              background: WH,
              border: `1px solid ${BD}`,
              color: INK2,
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            ← Back
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              padding: "9px 24px",
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 600,
              background: T,
              color: "#fff",
              border: "none",
              cursor: saving ? "not-allowed" : "pointer",
              fontFamily: FB,
              boxShadow: "0 2px 8px rgba(0,158,140,.25)",
            }}
          >
            {saving ? "Saving…" : "✓ Create Appointment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// EXCEL IMPORT VIEW (unchanged from before)
// ══════════════════════════════════════════════════════════════
function ExcelImportView({ doctors, onDone, showToast }) {
  const [stage, setStage] = useState("upload");
  const [rows, setRows] = useState([]),
    [headers, setHeaders] = useState([]),
    [mapping, setMapping] = useState({});
  const [importing, setImporting] = useState(false),
    [importedN, setImportedN] = useState(0),
    [importFailed, setImportFailed] = useState(0);
  const fileRef = useRef();
  const FIELDS = [
    { k: "patient_name", l: "Patient Name" },
    { k: "phone", l: "Phone" },
    { k: "file_no", l: "File Number" },
    { k: "appointment_date", l: "Date" },
    { k: "time_slot", l: "Time" },
    { k: "doctor_name", l: "Doctor" },
    { k: "visit_type", l: "Visit Type" },
    { k: "hba1c", l: "HbA1c (%)" },
    { k: "fg", l: "Fasting Glucose" },
    { k: "ldl", l: "LDL" },
    { k: "weight", l: "Weight" },
    { k: "notes", l: "Notes" },
  ];
  const parseCSV = (txt) => {
    const lines = txt.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return { headers: [], rows: [] };
    const pr = (l) => {
      const r = [];
      let c = "",
        q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === "," && !q) {
          r.push(c.trim());
          c = "";
        } else c += ch;
      }
      r.push(c.trim());
      return r;
    };
    const hdrs = pr(lines[0]).map((h) => h.replace(/^"|"$/g, ""));
    const data = lines.slice(1).map((l) => {
      const cols = pr(l);
      const o = {};
      hdrs.forEach((h, i) => {
        o[h] = (cols[i] || "").replace(/^"|"$/g, "");
      });
      return o;
    });
    return { headers: hdrs, rows: data };
  };
  const autoMap = (hdrs) => {
    const m = {};
    const rx = {
      patient_name: /name|patient/i,
      phone: /phone|mobile|tel/i,
      file_no: /file|id|no\b/i,
      appointment_date: /date/i,
      time_slot: /time|slot/i,
      doctor_name: /doctor|dr\b/i,
      visit_type: /visit|type/i,
      hba1c: /hba1c|a1c/i,
      fg: /fasting|fg|glucose/i,
      ldl: /ldl/i,
      weight: /weight|wt/i,
      notes: /notes|remarks/i,
    };
    hdrs.forEach((h) => {
      for (const [f, r] of Object.entries(rx)) {
        if (r.test(h) && !Object.values(m).includes(h)) {
          m[f] = h;
          break;
        }
      }
    });
    return m;
  };
  const handleFile = (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["csv", "txt", "xlsx", "xls"].includes(ext)) {
      showToast("Unsupported file type. Use CSV, TXT, or Excel files.", "err");
      return;
    }

    if (ext === "xlsx" || ext === "xls") {
      const rd = new FileReader();
      rd.onload = async (e) => {
        try {
          const XLSX = await import("xlsx");
          const workbook = XLSX.read(e.target.result, { type: "array" });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
          if (jsonData.length < 2) {
            showToast("Excel file is empty or has no data rows", "err");
            return;
          }
          const hdrs = jsonData[0].map((h) => String(h).trim());
          const data = jsonData
            .slice(1)
            .filter((row) => row.some((c) => c !== ""))
            .map((row) => {
              const o = {};
              hdrs.forEach((h, i) => {
                o[h] = row[i] != null ? String(row[i]).trim() : "";
              });
              return o;
            });
          setHeaders(hdrs);
          setRows(data);
          setMapping(autoMap(hdrs));
          setStage("mapping");
        } catch (err) {
          showToast("Failed to parse Excel file: " + err.message, "err");
        }
      };
      rd.readAsArrayBuffer(file);
    } else {
      const rd = new FileReader();
      rd.onload = (e) => {
        const { headers: hdrs, rows: data } = parseCSV(e.target.result);
        if (!hdrs.length) {
          showToast("Could not parse file", "err");
          return;
        }
        setHeaders(hdrs);
        setRows(data);
        setMapping(autoMap(hdrs));
        setStage("mapping");
      };
      rd.readAsText(file);
    }
  };
  const aiCat = (row) => {
    const h = parseFloat(row[mapping.hba1c] || "");
    if (isNaN(h)) return null;
    return h > 9 ? "complex" : h > 7 ? "maint" : "ctrl";
  };
  const handleImport = async () => {
    setImporting(true);
    let n = 0;
    let failed = 0;
    const today = new Date().toISOString().split("T")[0];
    for (const row of rows.slice(0, 200)) {
      const name = row[mapping.patient_name];
      if (!name) continue;
      const h = parseFloat(row[mapping.hba1c]);
      const cat = isNaN(h) ? null : h > 9 ? "complex" : h > 7 ? "maint" : "ctrl";
      const payload = {
        patient_name: name,
        phone: row[mapping.phone] || null,
        file_no: row[mapping.file_no] || null,
        appointment_date: row[mapping.appointment_date] || today,
        time_slot: row[mapping.time_slot] || null,
        doctor_name: row[mapping.doctor_name] || null,
        visit_type: row[mapping.visit_type] || "OPD",
        notes: row[mapping.notes] || null,
        category: cat,
      };
      try {
        const r = await apiFetch("/api/appointments", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        const d = await r.json();
        if (d.id) {
          const bio = {};
          if (!isNaN(h)) bio.hba1c = h;
          const fg = parseFloat(row[mapping.fg]);
          if (!isNaN(fg)) bio.fg = fg;
          const ldl = parseFloat(row[mapping.ldl]);
          if (!isNaN(ldl)) bio.ldl = ldl;
          const wt = parseFloat(row[mapping.weight]);
          if (!isNaN(wt)) bio.weight = wt;
          if (Object.keys(bio).length)
            await apiFetch(`/api/appointments/${d.id}/biomarkers`, {
              method: "POST",
              body: JSON.stringify(bio),
            });
          n++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }
    setImportedN(n);
    setImportFailed(failed);
    setStage("done");
    setImporting(false);
  };
  const prev5 = rows.slice(0, 5);

  return (
    <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          background: WH,
          borderBottom: `1px solid ${BD}`,
          padding: "14px 20px",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={onDone}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            fontSize: 18,
            color: INK3,
            padding: 0,
          }}
        >
          ←
        </button>
        <div>
          <div style={{ fontFamily: FD, fontSize: 18, color: INK }}>Import from Excel / CSV</div>
          <div style={{ fontSize: 11, color: INK3, marginTop: 2 }}>
            {stage === "upload"
              ? "Upload a CSV file"
              : stage === "mapping"
                ? `${rows.length} rows — map columns`
                : stage === "preview"
                  ? "Preview & confirm"
                  : "Done"}
          </div>
        </div>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
        {stage === "upload" && (
          <>
            <div
              onClick={() => fileRef.current?.click()}
              style={{
                border: `2px dashed ${BD2}`,
                borderRadius: 11,
                padding: "32px 20px",
                textAlign: "center",
                cursor: "pointer",
                background: WH,
                boxShadow: SH,
                marginBottom: 16,
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,.xlsx,.xls"
                style={{ display: "none" }}
                onChange={(e) => handleFile(e.target.files[0])}
              />
              <div style={{ fontSize: 36, marginBottom: 10 }}>📊</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: INK, marginBottom: 4 }}>
                Click to upload Excel or CSV file
              </div>
              <div style={{ fontSize: 11, color: INK3, marginBottom: 12 }}>
                Supports .xlsx, .xls, .csv, and .txt files
              </div>
              <div
                style={{
                  display: "inline-block",
                  padding: "7px 18px",
                  borderRadius: 8,
                  background: T,
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Choose File
              </div>
            </div>
            <div
              style={{
                background: WH,
                border: `1px solid ${BD}`,
                borderRadius: 10,
                padding: 16,
                marginBottom: 12,
                boxShadow: SH,
              }}
            >
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: INK2,
                  marginBottom: 10,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                }}
              >
                Expected Columns
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 7 }}>
                {[
                  "Patient Name",
                  "Phone",
                  "File No",
                  "Appointment Date",
                  "Time",
                  "Doctor",
                  "HbA1c",
                  "Fasting Glucose",
                  "LDL",
                  "Weight",
                  "Visit Type",
                  "Notes",
                ].map((c) => (
                  <div
                    key={c}
                    style={{
                      background: BG,
                      padding: "6px 9px",
                      borderRadius: 6,
                      fontSize: 10,
                      color: INK2,
                      fontWeight: 500,
                    }}
                  >
                    {c}
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: T }}>
                ℹ HbA1c values trigger automatic AI categorization (Uncontrolled / Maintenance /
                Continuous Care)
              </div>
            </div>
            <button
              onClick={() => {
                const csv =
                  "Patient Name,Phone,File No,Appointment Date,Appointment Time,Doctor Name,Visit Type,HbA1c,Fasting Glucose,LDL,Weight,Notes\nHarpreet Singh,9812345678,GS001,2026-04-01,09:00,Dr. Bhansali,OPD,9.8,220,140,82,First visit\n";
                const a = document.createElement("a");
                a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
                a.download = "gini_template.csv";
                a.click();
              }}
              style={{
                fontSize: 12,
                color: T,
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: FB,
                fontWeight: 600,
                textDecoration: "underline",
                padding: 0,
              }}
            >
              📥 Download sample template
            </button>
          </>
        )}
        {stage === "mapping" && (
          <>
            <div
              style={{
                background: WH,
                border: `1px solid ${BD}`,
                borderRadius: 10,
                padding: 16,
                marginBottom: 14,
                boxShadow: SH,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, color: INK, marginBottom: 12 }}>
                Column Mapping — {rows.length} rows found
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                {FIELDS.map((f) => (
                  <div key={f.k} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div
                      style={{
                        width: 140,
                        fontSize: 11,
                        fontWeight: 500,
                        color: INK2,
                        flexShrink: 0,
                      }}
                    >
                      {f.l}
                    </div>
                    <span style={{ color: INK3, fontSize: 12 }}>→</span>
                    <select
                      value={mapping[f.k] || ""}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [f.k]: e.target.value || undefined }))
                      }
                      style={{
                        flex: 1,
                        border: `1px solid ${BD}`,
                        borderRadius: 6,
                        padding: "5px 8px",
                        fontFamily: FB,
                        fontSize: 11,
                        color: INK,
                        background: mapping[f.k] ? GNL : BG,
                        outline: "none",
                      }}
                    >
                      <option value="">— skip —</option>
                      {headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {mapping[f.k] && <span style={{ color: GN, fontSize: 14 }}>✓</span>}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              <button
                onClick={() => setStage("preview")}
                style={{
                  padding: "9px 22px",
                  borderRadius: 8,
                  background: T,
                  color: "#fff",
                  border: "none",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: FB,
                }}
              >
                Preview →
              </button>
              <button
                onClick={() => setStage("upload")}
                style={{
                  padding: "9px 18px",
                  borderRadius: 8,
                  background: WH,
                  border: `1px solid ${BD}`,
                  color: INK2,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: FB,
                }}
              >
                ← Back
              </button>
            </div>
          </>
        )}
        {stage === "preview" && (
          <>
            {mapping.hba1c &&
              (() => {
                const cats = { complex: 0, maint: 0, ctrl: 0, none: 0 };
                rows.forEach((r) => {
                  const c = aiCat(r);
                  if (c) cats[c] = (cats[c] || 0) + 1;
                  else cats.none++;
                });
                return (
                  <div
                    style={{
                      background: GNL,
                      border: `1px solid ${GNB}`,
                      borderRadius: 9,
                      padding: "11px 16px",
                      marginBottom: 12,
                      fontSize: 12,
                      color: GN,
                      fontWeight: 500,
                    }}
                  >
                    <strong>AI Categorization:</strong> {cats.complex} Uncontrolled · {cats.maint}{" "}
                    Maintenance · {cats.ctrl} Continuous Care · {cats.none} uncategorized
                  </div>
                );
              })()}
            <div
              style={{
                background: WH,
                border: `1px solid ${BD}`,
                borderRadius: 10,
                boxShadow: SH,
                overflow: "hidden",
                marginBottom: 14,
              }}
            >
              <div
                style={{
                  padding: "10px 14px",
                  background: BG,
                  borderBottom: `1px solid ${BD}`,
                  fontSize: 11,
                  fontWeight: 600,
                  color: INK3,
                }}
              >
                Preview — First {prev5.length} of {rows.length} rows
              </div>
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 11,
                    fontFamily: FB,
                  }}
                >
                  <thead>
                    <tr style={{ background: BG }}>
                      {["Name", "Date", "Time", "HbA1c", "Doctor", "Category"].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: "8px 12px",
                            textAlign: "left",
                            fontSize: 9,
                            fontWeight: 700,
                            color: INK3,
                            textTransform: "uppercase",
                            letterSpacing: ".08em",
                            borderBottom: `1px solid ${BD}`,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {prev5.map((r, i) => {
                      const cat = aiCat(r);
                      return (
                        <tr key={i} style={{ borderBottom: `1px solid ${BD}` }}>
                          <td style={{ padding: "9px 12px", fontWeight: 500, color: INK }}>
                            {r[mapping.patient_name] || "—"}
                          </td>
                          <td
                            style={{
                              padding: "9px 12px",
                              fontFamily: FM,
                              fontSize: 10,
                              color: INK2,
                            }}
                          >
                            {r[mapping.appointment_date] || "—"}
                          </td>
                          <td
                            style={{
                              padding: "9px 12px",
                              fontFamily: FM,
                              fontSize: 10,
                              color: INK3,
                            }}
                          >
                            {r[mapping.time_slot] || "—"}
                          </td>
                          <td
                            style={{
                              padding: "9px 12px",
                              fontFamily: FM,
                              fontWeight: 600,
                              color: r[mapping.hba1c]
                                ? BC[bioS("hba1c", parseFloat(r[mapping.hba1c]))]
                                : INK3,
                            }}
                          >
                            {r[mapping.hba1c] ? `${r[mapping.hba1c]}%` : "—"}
                          </td>
                          <td style={{ padding: "9px 12px", color: INK2 }}>
                            {r[mapping.doctor_name] || "—"}
                          </td>
                          <td style={{ padding: "9px 12px" }}>
                            {cat ? (
                              <span
                                style={{
                                  fontSize: 9,
                                  padding: "2px 8px",
                                  borderRadius: 9,
                                  fontWeight: 600,
                                  ...catSty(cat),
                                }}
                              >
                                {catIcon(cat)} {catLabel(cat)}
                              </span>
                            ) : (
                              <span style={{ color: INK3, fontSize: 10 }}>—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div style={{ display: "flex", gap: 9 }}>
              <button
                onClick={handleImport}
                disabled={importing}
                style={{
                  padding: "10px 24px",
                  borderRadius: 8,
                  background: T,
                  color: "#fff",
                  border: "none",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: importing ? "not-allowed" : "pointer",
                  fontFamily: FB,
                }}
              >
                {importing ? "⏳ Importing…" : `✓ Import ${rows.length} Appointments`}
              </button>
              <button
                onClick={() => setStage("mapping")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  background: WH,
                  border: `1px solid ${BD}`,
                  color: INK2,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                  fontFamily: FB,
                }}
              >
                ← Back
              </button>
            </div>
          </>
        )}
        {stage === "done" && (
          <div style={{ textAlign: "center", padding: 40 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
            <div style={{ fontFamily: FD, fontSize: 24, color: GN, marginBottom: 8 }}>
              {importedN} appointments imported
            </div>
            {importFailed > 0 && (
              <div style={{ fontSize: 13, color: "#e53e3e", marginBottom: 8 }}>
                {importFailed} row{importFailed > 1 ? "s" : ""} failed to import
              </div>
            )}
            <div style={{ fontSize: 13, color: INK3, marginBottom: 24 }}>
              {importFailed > 0
                ? "Successfully imported rows have been added to the schedule."
                : "All appointments added to today's schedule."}
            </div>
            <button
              onClick={onDone}
              style={{
                padding: "10px 28px",
                borderRadius: 8,
                background: T,
                color: "#fff",
                border: "none",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              View Schedule →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Fallback doctors for testing ────────────────────────────
const SAMPLE_DOCTORS = [
  { id: "s1", name: "Dr. Bhansali", role: "Senior Physician", speciality: "Diabetology" },
  { id: "s2", name: "Dr. Kunal Sharma", role: "Physician", speciality: "Internal Medicine" },
  { id: "s3", name: "Dr. Beant Sidhu", role: "Physician", speciality: "Endocrinology" },
  { id: "s4", name: "Dr. Simranpreet K.", role: "Resident", speciality: "Internal Medicine" },
  { id: "s5", name: "Dr. Priya Patel", role: "Physician", speciality: "Diabetology" },
];

// ══════════════════════════════════════════════════════════════
// MAIN OPD PAGE
// ══════════════════════════════════════════════════════════════
export default function OPD() {
  const [doctors, setDoctors] = useState([]);
  const [date, setDate] = useState(() => {
    const d = new Date();
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  });
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterDoc, setFilterDoc] = useState("all");
  const [filterCat, setFilterCat] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [selAppt, setSelAppt] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const isMobile = useIsMobile();
  const [mobileView, setMobileView] = useState("list"); // "list" | "detail"
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [showRangeReport, setShowRangeReport] = useState(false);

  // URL-driven tab: ?tab=schedule|dashboard|new-appt|excel. "schedule" maps to
  // the internal "list" view so shareable links read naturally.
  const [searchParams, setSearchParams] = useSearchParams();
  const TAB_TO_VIEW = {
    schedule: "list",
    dashboard: "dashboard",
    triage: "triage",
    "new-appt": "new-appt",
    excel: "excel",
  };
  const VIEW_TO_TAB = {
    list: "schedule",
    dashboard: "dashboard",
    triage: "triage",
    "new-appt": "new-appt",
    excel: "excel",
  };
  const view = TAB_TO_VIEW[searchParams.get("tab")] || "list";
  const setView = useCallback(
    (v) => {
      const next = new URLSearchParams(searchParams);
      const tab = VIEW_TO_TAB[v] || "schedule";
      if (tab === "schedule") next.delete("tab");
      else next.set("tab", tab);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );
  const [toast, setToast] = useState(null);
  const [clock, setClock] = useState("");
  const doctor = getDoctor();

  // React Query owns the OPD list. `updateLocal` below writes into the cache
  // directly via setQueryData so every subscriber sees the optimistic update.
  const qc = useQueryClient();
  // 30s polling keeps the Live Dashboard counters in sync without a manual
  // reload. refetchIntervalInBackground:false means we stop polling when the
  // tab is hidden — the focus-refetch will catch us up when it returns.
  const apptsQuery = useOpdAppointments(date, {
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const appointments = apptsQuery.data || [];
  // Only show the full-page loading state when there's no cached data yet
  // (isPending). Background refetches (isFetching while cache is warm) should
  // NOT blank the list — the user should see cached rows and have them swap
  // in place when the new response arrives.
  const loading = apptsQuery.isPending;
  const setAppointments = useCallback(
    (updater) => {
      qc.setQueryData(qk.opd.appointments(date), (prev) => {
        const base = Array.isArray(prev) ? prev : [];
        return typeof updater === "function" ? updater(base) : updater;
      });
    },
    [qc, date],
  );

  useEffect(() => {
    const tick = () => {
      const n = new Date();
      const p = (x) => String(x).padStart(2, "0");
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const ms = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      setClock(
        `${p(n.getHours())}:${p(n.getMinutes())}:${p(n.getSeconds())} — ${days[n.getDay()]} ${n.getDate()} ${ms[n.getMonth()]}`,
      );
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const showToast = (msg, type = "ok") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2800);
  };

  // Manual refetch helper — keeps the old call sites working. React Query
  // already fetches on mount/date-change/focus, so this is only needed when
  // something external (e.g. a save elsewhere) should force a refresh.
  const fetchAppts = useCallback(() => {
    apptsQuery.refetch();
  }, [apptsQuery]);
  useEffect(() => {
    apiFetch("/api/doctors")
      .then((r) => r.json())
      .then((d) => setDoctors(Array.isArray(d) && d.length > 0 ? d : SAMPLE_DOCTORS))
      .catch(() => setDoctors(SAMPLE_DOCTORS));
  }, []);

  // Smooth-scroll the schedule list to the selected appointment row whenever
  // the selection changes while the list view is visible. The data-appt-id
  // attribute on each ApptRow is the lookup key. We retry briefly because the
  // row may not be in the DOM yet right after a view-switch (e.g. arriving
  // from Triage → Schedule).
  useEffect(() => {
    if (!selAppt?.id || view !== "list") return;
    let attempts = 0;
    const tryScroll = () => {
      const el = document.querySelector(`[data-appt-id="${selAppt.id}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
      if (attempts++ < 6) setTimeout(tryScroll, 60);
    };
    tryScroll();
  }, [selAppt?.id, view]);

  const updateLocal = (u) => {
    setAppointments((prev) => prev.map((a) => (a.id === u.id ? { ...a, ...u } : a)));
    setSelAppt((prev) => (prev?.id === u.id ? { ...prev, ...u } : prev));
  };

  const patchStatus = (id, status) =>
    apiFetch(`/api/appointments/${id}`, { method: "PATCH", body: JSON.stringify({ status }) })
      .then((r) => r.json())
      .then((d) => {
        updateLocal(d);
        showToast(`✓ ${status}`);
      });
  const patchPrep = (id, step, value = true) =>
    apiFetch(`/api/appointments/${id}/prep`, {
      method: "PATCH",
      body: JSON.stringify({ step, value }),
    })
      .then((r) => r.json())
      .then(updateLocal);
  const postBiomarkers = (id, data) =>
    apiFetch(`/api/appointments/${id}/biomarkers`, { method: "POST", body: JSON.stringify(data) })
      .then((r) => {
        if (!r.ok) throw new Error("Save failed");
        return r.json();
      })
      .then((d) => {
        updateLocal(d);
        const count = Object.entries(data).filter(
          ([k, v]) => v != null && v !== "" && k !== "bp",
        ).length;
        showToast(`✓ Lab values saved — ${count} value${count !== 1 ? "s" : ""} synced to records`);
      })
      .catch(() => showToast("✗ Failed to save lab values — please retry", "err"));
  const postCompliance = (id, data) =>
    apiFetch(`/api/appointments/${id}/compliance`, { method: "POST", body: JSON.stringify(data) })
      .then((r) => {
        if (!r.ok) throw new Error("Save failed");
        return r.json();
      })
      .then((d) => {
        updateLocal(d);
        const medCount = (data.medications || []).length;
        const diagCount = (data.diagnoses || []).length;
        const stoppedCount = (data.stopped_medications || []).length;
        const parts = [];
        if (medCount > 0) parts.push(`${medCount} medicine${medCount !== 1 ? "s" : ""}`);
        if (stoppedCount > 0) parts.push(`${stoppedCount} stopped`);
        if (diagCount > 0) parts.push(`${diagCount} condition${diagCount !== 1 ? "s" : ""}`);
        const msg =
          parts.length > 0
            ? `✓ Compliance saved — ${parts.join(", ")} synced`
            : "✓ Compliance saved";
        showToast(msg);
      })
      .catch(() => showToast("✗ Failed to save compliance — please retry", "err"));
  const patchCategoryDoc = (id, category, doctor_name) =>
    apiFetch(`/api/appointments/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ category, doctor_name }),
    })
      .then((r) => r.json())
      .then((d) => {
        updateLocal(d);
        showToast("✓ Category & doctor saved");
      });
  const postVitals = (id, data) =>
    apiFetch(`/api/appointments/${id}/vitals`, { method: "POST", body: JSON.stringify(data) })
      .then((r) => {
        if (!r.ok) throw new Error("Save failed");
        return r.json();
      })
      .then((d) => {
        updateLocal(d);
        showToast("✓ Vitals saved & synced to records");
      })
      .catch(() => showToast("✗ Failed to save vitals — please retry", "err"));

  // Unique doctors from appointments for filter
  const apptDoctors = [...new Set(appointments.map((a) => a.doctor_name).filter(Boolean))];

  // Apply filters
  const filtered = appointments.filter((a) => {
    if (filterStatus === "pending" && a.status && a.status !== "pending") return false;
    if (filterStatus === "checkedin" && a.status !== "checkedin") return false;
    if (filterStatus === "in_visit" && a.status !== "in_visit") return false;
    if (filterStatus === "seen" && a.status !== "seen" && a.status !== "completed") return false;
    if (
      filterStatus === "ready" &&
      (!isReady(a) || ["checkedin", "in_visit", "seen", "completed"].includes(a.status))
    )
      return false;
    if (filterDoc === "__noshow__") {
      if (a.status !== "no_show") return false;
    } else if (filterDoc !== "all") {
      if (a.doctor_name !== filterDoc) return false;
    }
    // Filter against the effective category (manually-set OR AI-suggested) so
    // un-assigned appointments still surface under the suggested bucket.
    if (filterCat === "complex" || filterCat === "maint" || filterCat === "ctrl") {
      if (effectiveCategory(a) !== filterCat) return false;
    }
    if (searchQ.trim()) {
      const q = searchQ.trim().toLowerCase();
      const name = (a.patient_name || "").toLowerCase();
      const phone = (a.phone || "").toLowerCase();
      const file = (a.file_no || "").toLowerCase();
      if (!name.includes(q) && !phone.includes(q) && !file.includes(q)) return false;
    }
    return true;
  });

  // Group by doctor — no-show patients get their own group regardless of doctor
  const grouped = {};
  filtered.forEach((a) => {
    const k = a.status === "no_show" ? "No-Show" : a.doctor_name || "Unassigned";
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(a);
  });

  // Bucket every appointment by its workflow status. Pending absorbs every
  // not-yet-actioned status (scheduled, null/empty, the literal "pending"),
  // which is everything that isn't terminal (no_show / cancelled) and isn't
  // already checkedin / in_visit / seen. Cards reconcile to Total:
  //   total = pending + checkedin + in_visit + seen + no_show
  // (cancelled, if present, also rolls into the difference; almost never used
  // in practice, so we don't show its own card.)
  const checkedinCount = appointments.filter((a) => a.status === "checkedin").length;
  const inVisitCount = appointments.filter((a) => a.status === "in_visit").length;
  const seenCount = appointments.filter(
    (a) => a.status === "seen" || a.status === "completed",
  ).length;
  const noShowCount = appointments.filter((a) => a.status === "no_show").length;
  const cancelledCount = appointments.filter((a) => a.status === "cancelled").length;
  const total = appointments.length;
  const stats = {
    total,
    pending: total - checkedinCount - inVisitCount - seenCount - noShowCount - cancelledCount,
    checkedin: checkedinCount,
    in_visit: inVisitCount,
    seen: seenCount,
    no_show: noShowCount,
    cancelled: cancelledCount,
  };

  const changeDate = (delta) => {
    const d = new Date(date);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().split("T")[0]);
  };
  const selectAppt = (a) => {
    setSelAppt(a);
    setActiveTab("overview");
    setMobileView("detail");
  };

  const filterBtn = (label, val, active, onClick, color) => (
    <button
      onClick={onClick}
      style={{
        padding: "3px 11px",
        borderRadius: 20,
        fontSize: 11,
        fontWeight: 500,
        border: "none",
        cursor: "pointer",
        fontFamily: FB,
        background: active ? color || TL : "transparent",
        color: active ? (color ? "#fff" : T) : INK3,
        transition: "all .15s",
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="opd-page"
      style={{
        display: "flex",
        flexDirection: "column",
        background: BG,
        fontFamily: FB,
        fontSize: 13,
        color: INK,
      }}
    >
      {/* Topbar */}
      <div
        className="opd-topbar"
        style={{
          background: NV,
          height: 52,
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          gap: 14,
          flexShrink: 0,
          zIndex: 60,
        }}
      >
        <div className="opd-topbar-title" style={{ fontFamily: FD, fontSize: 20, color: "#fff" }}>
          Gini <em style={{ fontStyle: "italic", color: "#5dd6ca" }}>Scribe</em>
        </div>
        <div
          className="opd-topbar-sub"
          style={{ width: 1, height: 18, background: "rgba(255,255,255,.15)", margin: "0 2px" }}
        />
        <div className="opd-topbar-sub" style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>
          OPD Manager
        </div>
        <div className="opd-topbar-nav" style={{ display: "flex", gap: 2, marginLeft: 6 }}>
          {[
            ["list", "📋 Schedule"],
            ["dashboard", "📊 Live Dashboard"],
            ["triage", "🔴🟡✅ Triage"],
            ["new-appt", "➕ New Appointment"],
            ["excel", "📊 Import Excel"],
          ].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: "5px 12px",
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 500,
                color: view === v ? "#fff" : "rgba(255,255,255,.5)",
                background: view === v ? "rgba(255,255,255,.13)" : "transparent",
                border: "none",
                cursor: "pointer",
                fontFamily: FB,
                transition: "all .15s",
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <div
          className="opd-topbar-right"
          style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}
        >
          <div
            className="opd-clock"
            style={{
              background: "rgba(255,255,255,.1)",
              border: "1px solid rgba(255,255,255,.14)",
              borderRadius: 6,
              padding: "3px 11px",
              fontFamily: FM,
              fontSize: 11,
              color: "rgba(255,255,255,.6)",
            }}
          >
            {clock}
          </div>
          {doctor && (
            <div
              className="opd-doctor-pill"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                background: "rgba(255,255,255,.1)",
                borderRadius: 20,
                padding: "3px 12px 3px 5px",
              }}
            >
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: "50%",
                  background: "linear-gradient(135deg,#5dd6ca,#009e8c)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 700,
                  color: NV,
                  flexShrink: 0,
                }}
              >
                {(doctor.short_name || doctor.name || "?").substring(0, 2).toUpperCase()}
              </div>
              <div className="opd-doctor-meta">
                <div style={{ fontSize: 11, fontWeight: 500, color: "rgba(255,255,255,.85)" }}>
                  {doctor.short_name || doctor.name}
                </div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,.4)" }}>
                  {doctor.role || "Staff"}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Sub-nav — only visible on Schedule tab */}
      {view === "list" && (!isMobile || mobileView === "list") && (
        <div
          className="opd-subnav"
          style={{
            background: WH,
            borderBottom: `1px solid ${BD}`,
            padding: "0 18px",
            flexShrink: 0,
          }}
        >
          {/* Mobile filter toggle bar */}
          <div className="opd-filter-toggle">
            <button
              type="button"
              className={`opd-filter-toggle-btn${mobileFiltersOpen ? " active" : ""}`}
              onClick={() => setMobileFiltersOpen((o) => !o)}
              aria-expanded={mobileFiltersOpen}
            >
              <span>🔍 Filters</span>
              <span style={{ fontSize: 10, opacity: 0.7 }}>{mobileFiltersOpen ? "▲" : "▼"}</span>
            </button>
            <div className="opd-filter-summary">
              {[
                filterStatus !== "all" ? filterStatus : null,
                filterDoc !== "all" && filterDoc !== "__noshow__"
                  ? filterDoc.replace(/^Dr\.\s*/i, "").split(" ")[0]
                  : null,
                filterDoc === "__noshow__" ? "No-Show" : null,
                filterCat !== "all" ? filterCat : null,
              ]
                .filter(Boolean)
                .join(" · ") || "All patients"}
            </div>
            <button
              type="button"
              onClick={fetchAppts}
              style={{
                padding: "5px 10px",
                borderRadius: 6,
                border: `1px solid ${BD}`,
                background: "transparent",
                cursor: "pointer",
                fontSize: 11,
                color: INK3,
                fontFamily: FB,
              }}
            >
              ↺
            </button>
            <button
              type="button"
              onClick={() => setView("new-appt")}
              style={{
                padding: "5px 11px",
                borderRadius: 6,
                border: "none",
                background: T,
                color: "#fff",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 600,
                fontFamily: FB,
              }}
            >
              + New
            </button>
          </div>
          <div className={`opd-filter-body${isMobile && !mobileFiltersOpen ? " collapsed" : ""}`}>
            {/* Status filters */}
            <div
              className="opd-filter-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 2,
                height: 38,
                borderBottom: `1px solid ${BD}`,
              }}
            >
              {[
                ["all", "All"],
                ["pending", "Pending"],
                ["ready", "Ready"],
                ["checkedin", "Checked In"],
                ["in_visit", "In Visit"],
                ["seen", "Seen"],
              ].map(([v, l]) => filterBtn(l, v, filterStatus === v, () => setFilterStatus(v)))}
              <div
                className="opd-filter-stats"
                style={{ width: 1, height: 18, background: BD, margin: "0 8px" }}
              />
              <span
                className="opd-filter-stats"
                style={{ fontFamily: FM, fontSize: 11, color: AM, fontWeight: 500 }}
              >
                {stats.pending} pending
              </span>
              <span
                className="opd-filter-stats"
                style={{ fontFamily: FM, fontSize: 11, color: SK, fontWeight: 500, marginLeft: 8 }}
              >
                {stats.checkedin} waiting
              </span>
              <span
                className="opd-filter-stats"
                style={{
                  fontFamily: FM,
                  fontSize: 11,
                  color: "#7c3aed",
                  fontWeight: 500,
                  marginLeft: 8,
                }}
              >
                {stats.in_visit} in visit
              </span>
              <span
                className="opd-filter-stats"
                style={{ fontFamily: FM, fontSize: 11, color: GN, fontWeight: 500, marginLeft: 8 }}
              >
                {stats.seen} seen
              </span>
              <div
                className="opd-filter-actions"
                style={{ marginLeft: "auto", display: "flex", gap: 7 }}
              >
                <button
                  onClick={fetchAppts}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 5,
                    fontSize: 10,
                    fontWeight: 500,
                    background: "transparent",
                    border: `1px solid ${BD}`,
                    cursor: "pointer",
                    color: INK3,
                    fontFamily: FB,
                  }}
                >
                  ↺ Refresh
                </button>
                <button
                  onClick={() => setView("new-appt")}
                  style={{
                    padding: "3px 10px",
                    borderRadius: 5,
                    fontSize: 10,
                    fontWeight: 600,
                    background: T,
                    color: "#fff",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: FB,
                  }}
                >
                  + New
                </button>
              </div>
            </div>
            {/* Doctor + category filters */}
            <div
              className="opd-filter-row"
              style={{ display: "flex", alignItems: "center", gap: 3, height: 34 }}
            >
              <span
                className="opd-filter-label"
                style={{ fontSize: 10, color: INK3, fontWeight: 500, marginRight: 4 }}
              >
                Doctor:
              </span>
              {filterBtn("All", null, filterDoc === "all", () => setFilterDoc("all"))}
              {apptDoctors.map((d) =>
                filterBtn(d.replace(/^Dr\.\s*/i, "").split(" ")[0], d, filterDoc === d, () =>
                  setFilterDoc(d === filterDoc ? "all" : d),
                ),
              )}
              {filterBtn(
                `No-Show${appointments.filter((a) => a.status === "no_show").length ? ` (${appointments.filter((a) => a.status === "no_show").length})` : ""}`,
                "__noshow__",
                filterDoc === "__noshow__",
                () => setFilterDoc(filterDoc === "__noshow__" ? "all" : "__noshow__"),
                "#6b7280",
              )}
              <div
                style={{ width: 1, height: 18, background: BD, margin: "0 10px", flexShrink: 0 }}
              />
              <span
                className="opd-filter-label"
                style={{ fontSize: 10, color: INK3, fontWeight: 500, marginRight: 4 }}
              >
                Category:
              </span>
              {filterBtn("All", null, filterCat === "all", () => setFilterCat("all"))}
              {filterBtn(
                "⚠ Uncontrolled",
                "complex",
                filterCat === "complex",
                () => setFilterCat(filterCat === "complex" ? "all" : "complex"),
                RE,
              )}
              {filterBtn(
                "↑ Maintenance",
                "maint",
                filterCat === "maint",
                () => setFilterCat(filterCat === "maint" ? "all" : "maint"),
                AM,
              )}
              {filterBtn(
                "✓ Continuous Care",
                "ctrl",
                filterCat === "ctrl",
                () => setFilterCat(filterCat === "ctrl" ? "all" : "ctrl"),
                GN,
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {view === "excel" ? (
          <ExcelImportView
            doctors={doctors}
            showToast={showToast}
            onDone={() => {
              fetchAppts();
              setView("list");
            }}
          />
        ) : view === "new-appt" ? (
          <NewApptView
            doctors={doctors}
            showToast={showToast}
            onCancel={() => setView("list")}
            onSaved={() => {
              fetchAppts();
              setView("list");
              showToast("✓ Appointment created");
            }}
          />
        ) : view === "dashboard" ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              background: BG,
              overflow: "auto",
            }}
          >
            <LiveDashboard
              appointments={appointments}
              doctors={doctors}
              updatedAt={apptsQuery.dataUpdatedAt}
              isFetching={apptsQuery.isFetching}
              isPending={apptsQuery.isPending}
              isError={apptsQuery.isError}
              error={apptsQuery.error}
              onRefresh={() => apptsQuery.refetch()}
              date={date}
              onDateChange={setDate}
              onGenerateReport={() => setShowRangeReport(true)}
              onSelectAppt={(a) => {
                setSelAppt(a);
                setActiveTab("overview");
                setView("list");
              }}
            />
            {showRangeReport && (
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  background: "rgba(0,0,0,.45)",
                  zIndex: 1000,
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "center",
                  padding: 20,
                  overflow: "auto",
                }}
                onClick={() => setShowRangeReport(false)}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    background: "white",
                    borderRadius: 10,
                    width: "100%",
                    maxWidth: 1100,
                    maxHeight: "100%",
                    overflow: "auto",
                  }}
                >
                  <OpdRangeReport onClose={() => setShowRangeReport(false)} />
                </div>
              </div>
            )}
          </div>
        ) : view === "triage" ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              background: BG,
              overflow: "auto",
            }}
          >
            <TriageView
              appointments={appointments}
              doctors={doctors}
              date={date}
              onDateChange={setDate}
              onRefresh={() => apptsQuery.refetch()}
              isFetching={apptsQuery.isFetching}
              isPending={apptsQuery.isPending}
              updatedAt={apptsQuery.dataUpdatedAt}
              onUpdateAppt={(id, patch) =>
                patchCategoryDoc(id, patch.category ?? null, patch.doctor_name)
              }
              onSelectAppt={(a) => {
                setSearchQ("");
                setFilterStatus("all");
                setFilterDoc("all");
                setFilterCat("all");
                setSelAppt(a);
                setActiveTab("overview");
                setView("list");
              }}
            />
          </div>
        ) : (
          <>
            {/* Left schedule */}
            {(!isMobile || mobileView === "list") && (
              <div
                className="opd-schedule"
                style={{
                  width: 420,
                  flexShrink: 0,
                  borderRight: `1px solid ${BD}`,
                  display: "flex",
                  flexDirection: "column",
                  background: WH,
                  overflow: "hidden",
                }}
              >
                <div
                  className="opd-schedule-head"
                  style={{
                    padding: "13px 15px 11px",
                    borderBottom: `1px solid ${BD}`,
                    flexShrink: 0,
                  }}
                >
                  <div
                    className="opd-schedule-title"
                    style={{ fontFamily: FD, fontSize: 17, color: INK, marginBottom: 9 }}
                  >
                    {new Date(date + "T00:00").toLocaleDateString("en-IN", {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <button
                      onClick={() => changeDate(-1)}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        border: `1px solid ${BD}`,
                        background: "transparent",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 14,
                        color: INK3,
                      }}
                    >
                      ‹
                    </button>
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                      style={{
                        border: `1px solid ${BD}`,
                        borderRadius: 7,
                        padding: "4px 10px",
                        fontFamily: FM,
                        fontSize: 11,
                        color: INK,
                        background: BG,
                        outline: "none",
                        flex: 1,
                      }}
                    />
                    <button
                      onClick={() => changeDate(1)}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 6,
                        border: `1px solid ${BD}`,
                        background: "transparent",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 14,
                        color: INK3,
                      }}
                    >
                      ›
                    </button>
                    <button
                      onClick={() => setDate(new Date().toISOString().split("T")[0])}
                      style={{
                        padding: "4px 9px",
                        fontSize: 10,
                        fontWeight: 500,
                        border: `1px solid ${BD}`,
                        borderRadius: 6,
                        background: "transparent",
                        cursor: "pointer",
                        color: INK3,
                        fontFamily: FB,
                      }}
                    >
                      Today
                    </button>
                  </div>
                  <div
                    className="opd-schedule-search"
                    style={{ position: "relative", marginTop: 8 }}
                  >
                    <span
                      style={{
                        position: "absolute",
                        left: 9,
                        top: "50%",
                        transform: "translateY(-50%)",
                        fontSize: 12,
                        color: INK3,
                        pointerEvents: "none",
                      }}
                    >
                      🔍
                    </span>
                    <input
                      value={searchQ}
                      onChange={(e) => setSearchQ(e.target.value)}
                      placeholder="Search by name, phone, file no..."
                      style={{
                        width: "100%",
                        boxSizing: "border-box",
                        paddingLeft: 28,
                        paddingRight: searchQ ? 28 : 10,
                        paddingTop: 5,
                        paddingBottom: 5,
                        border: `1px solid ${BD}`,
                        borderRadius: 7,
                        fontFamily: FB,
                        fontSize: 11,
                        color: INK,
                        background: BG,
                        outline: "none",
                      }}
                    />
                    {searchQ && (
                      <button
                        onClick={() => setSearchQ("")}
                        style={{
                          position: "absolute",
                          right: 7,
                          top: "50%",
                          transform: "translateY(-50%)",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          fontSize: 12,
                          color: INK3,
                          padding: 0,
                          lineHeight: 1,
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ flex: 1, overflowY: "auto" }}>
                  {loading && (
                    <div style={{ padding: 20, textAlign: "center", color: INK3, fontSize: 12 }}>
                      Loading…
                    </div>
                  )}
                  {!loading && filtered.length === 0 && (
                    <div style={{ padding: 28, textAlign: "center", color: INK3 }}>
                      <div style={{ fontSize: 32, marginBottom: 10, opacity: 0.2 }}>📋</div>
                      <div style={{ fontSize: 13, marginBottom: 12 }}>No appointments</div>
                      <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                        <button
                          onClick={() => setView("new-appt")}
                          style={{
                            padding: "7px 14px",
                            borderRadius: 7,
                            background: T,
                            color: "#fff",
                            border: "none",
                            fontSize: 11,
                            fontWeight: 600,
                            cursor: "pointer",
                            fontFamily: FB,
                          }}
                        >
                          + New
                        </button>
                        <button
                          onClick={() => setView("excel")}
                          style={{
                            padding: "7px 14px",
                            borderRadius: 7,
                            background: WH,
                            border: `1px solid ${BD}`,
                            color: INK2,
                            fontSize: 11,
                            fontWeight: 500,
                            cursor: "pointer",
                            fontFamily: FB,
                          }}
                        >
                          📊 Import
                        </button>
                      </div>
                    </div>
                  )}
                  {!loading &&
                    Object.entries(grouped)
                      .sort(([a], [b]) =>
                        a === "Unassigned" ? -1 : b === "Unassigned" ? 1 : a.localeCompare(b),
                      )
                      .map(([doc, appts]) => (
                        <DocSection
                          key={doc}
                          docName={doc}
                          appts={appts}
                          selAppt={selAppt}
                          onSelect={selectAppt}
                          filterStatus={filterStatus}
                        />
                      ))}
                </div>
              </div>
            )}

            {/* Right detail */}
            {(!isMobile || mobileView === "detail") && (
              <div
                className="opd-detail"
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                  background: BG,
                }}
              >
                {isMobile && (
                  <div className="opd-mobile-back">
                    <button
                      onClick={() => setMobileView("list")}
                      style={{
                        background: "transparent",
                        border: `1px solid ${BD}`,
                        borderRadius: 6,
                        padding: "5px 10px",
                        fontSize: 12,
                        fontWeight: 600,
                        color: INK2,
                        cursor: "pointer",
                        fontFamily: FB,
                      }}
                    >
                      ← Back
                    </button>
                    <span style={{ fontSize: 12, color: INK3, fontFamily: FB }}>
                      {selAppt ? selAppt.patient_name || "Patient" : "Select a patient"}
                    </span>
                  </div>
                )}
                {!selAppt ? (
                  <EmptyState
                    onNew={() => setView("new-appt")}
                    onImport={() => setView("excel")}
                    onDashboard={() => setView("dashboard")}
                    stats={stats}
                  />
                ) : (
                  <PatientDetail
                    appt={selAppt}
                    doctors={doctors}
                    activeTab={activeTab}
                    setActiveTab={setActiveTab}
                    onPatchStatus={patchStatus}
                    onPatchPrep={patchPrep}
                    onPostBiomarkers={postBiomarkers}
                    onPostCompliance={postCompliance}
                    onPatchCategoryDoc={patchCategoryDoc}
                    onPostVitals={postVitals}
                    allAppts={appointments}
                    showToast={showToast}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

      {toast && (
        <div
          style={{
            position: "fixed",
            bottom: 20,
            right: 20,
            zIndex: 999,
            background: toast.type === "err" ? RE : T,
            color: "#fff",
            borderRadius: 9,
            padding: "11px 18px",
            fontSize: 13,
            fontWeight: 500,
            boxShadow: "0 4px 20px rgba(0,0,0,.18)",
            maxWidth: 320,
          }}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
