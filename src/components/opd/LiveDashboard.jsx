import React, { useEffect, useMemo, useRef, useState } from "react";
import CustomCalendar from "../ui/CustomCalendar";
import { useIsMobile } from "../../hooks/useIsMobile.js";
import {
  BIO_TIER,
  classifyBiomarker,
  classifyComposite,
  targetStatus,
} from "../../utils/biomarkerClassify.js";

const T = "#009e8c";
const TL = "#e6f6f4";
const TB = "rgba(0,158,140,.22)";
const BG = "#f0f4f7";
const WH = "#fff";
const INK = "#1a2332";
const INK2 = "#3d4f63";
const INK3 = "#6b7d90";
const BD = "#dde3ea";
const RE = "#d94f4f";
const REL = "#fdf0f0";
const AM = "#d97a0a";
const AML = "#fef6e6";
const GN = "#15803d";
const GNL = "#edfcf0";
const SK = "#2563eb";
const SKL = "#eff6ff";
const SH = "0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05)";

const FB = "'Inter',system-ui,sans-serif";
const FD = "'Instrument Serif',serif";
const FM = "'DM Mono',monospace";

if (typeof document !== "undefined" && !document.getElementById("live-dash-kf")) {
  const s = document.createElement("style");
  s.id = "live-dash-kf";
  s.textContent = `
@keyframes ldPulse {
  0%   { box-shadow: 0 0 0 0 rgba(21,128,61,.55); }
  70%  { box-shadow: 0 0 0 9px rgba(21,128,61,0);  }
  100% { box-shadow: 0 0 0 0 rgba(21,128,61,0);    }
}
.ld-dot { animation: ldPulse 1.8s ease-out infinite; }
.ld-row { transition: background .12s; }
.ld-row:hover { background: rgba(0,158,140,.06); cursor: pointer; }
@keyframes ldShimmer {
  0%   { background-position: -150% 0; }
  100% { background-position: 150% 0; }
}
.ld-shim {
  position: relative;
  background-color: #e8edf2;
  background-image: linear-gradient(
    90deg,
    rgba(232,237,242,0) 0%,
    rgba(255,255,255,.85) 50%,
    rgba(232,237,242,0) 100%
  );
  background-size: 60% 100%;
  background-repeat: no-repeat;
  animation: ldShimmer 1.4s ease-in-out infinite;
  overflow: hidden;
}
`;
  document.head.appendChild(s);
}

const firstName = (n) => (n ? String(n).split("(")[0].trim() : "—");

function fmtTime(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function useTick(ms = 1000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function Ring({ pct, color, centerLabel }) {
  const circ = 2 * Math.PI * 30;
  const arc = (Math.max(0, Math.min(100, pct)) / 100) * circ;
  return (
    <div style={{ position: "relative", width: 86, height: 86, flexShrink: 0 }}>
      <svg viewBox="0 0 70 70" width="86" height="86">
        <circle cx="35" cy="35" r="30" stroke={BD} strokeWidth="8" fill="none" />
        <circle
          cx="35"
          cy="35"
          r="30"
          stroke={color}
          strokeWidth="8"
          fill="none"
          strokeDasharray={circ}
          strokeDashoffset={circ - arc}
          transform="rotate(-90 35 35)"
          style={{ transition: "stroke-dashoffset .6s" }}
          strokeLinecap="round"
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ fontFamily: FM, fontSize: 18, fontWeight: 600, color }}>{pct}%</div>
        <div style={{ fontSize: 9, color: INK3, letterSpacing: ".06em" }}>{centerLabel}</div>
      </div>
    </div>
  );
}

// Stacked donut — multiple segments rendered around the same circle so we can
// show the full Better/Stable/Worse distribution at a glance instead of just
// one slice. `segments` is `[{ pct, color, label, count }, ...]`; sum of pcts
// should be ≤100. Hovering or tapping a segment shows a tooltip with the
// label · count · percentage so the centre count alone isn't the only readout.
function StackedRing({ segments, centerValue, centerLabel, centerColor }) {
  const circ = 2 * Math.PI * 30;
  const [hover, setHover] = useState(null);
  let cursor = 0;
  return (
    <div style={{ position: "relative", width: 86, height: 86, flexShrink: 0 }}>
      <svg viewBox="0 0 70 70" width="86" height="86">
        <circle cx="35" cy="35" r="30" stroke={BD} strokeWidth="8" fill="none" />
        {segments.map((s, i) => {
          if (!s || s.pct <= 0) return null;
          const arc = (s.pct / 100) * circ;
          const rotation = -90 + (cursor / 100) * 360;
          cursor += s.pct;
          const isActive = hover === i;
          return (
            <circle
              key={i}
              cx="35"
              cy="35"
              r="30"
              stroke={s.color}
              strokeWidth={isActive ? 10 : 8}
              fill="none"
              strokeDasharray={`${arc} ${circ - arc}`}
              strokeDashoffset={0}
              transform={`rotate(${rotation} 35 35)`}
              style={{ transition: "stroke-dasharray .6s, stroke-width .15s", cursor: "pointer" }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onClick={() => setHover((h) => (h === i ? null : i))}
            >
              <title>
                {`${s.label || ""}: ${s.count != null ? s.count + " · " : ""}${s.pct}%`}
              </title>
            </circle>
          );
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        {hover != null && segments[hover] ? (
          <>
            <div
              style={{
                fontFamily: FM,
                fontWeight: 700,
                color: segments[hover].color,
                lineHeight: 1,
                display: "flex",
                alignItems: "baseline",
                gap: 3,
              }}
            >
              {segments[hover].count != null && (
                <span style={{ fontSize: 18 }}>{segments[hover].count}</span>
              )}
              <span style={{ fontSize: 9, fontWeight: 600, opacity: 0.85 }}>
                {segments[hover].pct}%
              </span>
            </div>
            <div
              style={{
                fontSize: 8,
                color: segments[hover].color,
                letterSpacing: ".06em",
                fontWeight: 700,
                marginTop: 2,
                textTransform: "uppercase",
              }}
            >
              {segments[hover].label}
            </div>
          </>
        ) : (
          <>
            <div
              style={{ fontFamily: FM, fontSize: 18, fontWeight: 600, color: centerColor || INK }}
            >
              {centerValue}
            </div>
            <div style={{ fontSize: 9, color: INK3, letterSpacing: ".06em" }}>{centerLabel}</div>
          </>
        )}
      </div>
    </div>
  );
}

// Small Tier-2 chip used inline on each patient row in the trend cards.
// Colour follows clinical target (green=at target, amber=borderline, red=outside).
function ParamChip({ label, value, prev, status }) {
  if (value == null || isNaN(value)) return null;
  const palette =
    status === "good"
      ? { bg: GNL, fg: GN }
      : status === "warn"
        ? { bg: AML, fg: AM }
        : status === "bad"
          ? { bg: REL, fg: RE }
          : { bg: BG, fg: INK3 };
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: 8,
        background: palette.bg,
        color: palette.fg,
        fontFamily: FM,
        border: `1px solid ${palette.fg}33`,
        whiteSpace: "nowrap",
      }}
    >
      {label}{" "}
      {prev != null && !isNaN(prev) && prev !== value ? (
        <>
          {prev} <span style={{ opacity: 0.6, margin: "0 2px" }}>→</span> <b>{value}</b>
        </>
      ) : (
        <b>{value}</b>
      )}
    </span>
  );
}

// Render the standard set of Tier-1/Tier-2 chips for a patient row.
// HbA1c + SBP are always shown if present; FBS/LDL/TG show when recorded.
function ParamChips({ r }) {
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        marginTop: 4,
      }}
    >
      <ParamChip
        label="HbA1c"
        value={r.hba1c}
        prev={r.prevHba1c}
        status={targetStatus("hba1c", r.hba1c)}
      />
      {r.sbp != null && (
        <ParamChip
          label={`BP${r.dbp ? "" : ""}`}
          value={r.dbp ? `${r.sbp}/${r.dbp}` : r.sbp}
          prev={r.prevSbp}
          status={targetStatus("sbp", r.sbp)}
        />
      )}
      <ParamChip label="FBS" value={r.fg} prev={r.prevFg} status={targetStatus("fg", r.fg)} />
      <ParamChip label="LDL" value={r.ldl} prev={r.prevLdl} status={targetStatus("ldl", r.ldl)} />
      <ParamChip label="TG" value={r.tg} prev={r.prevTg} status={targetStatus("tg", r.tg)} />
    </div>
  );
}

function Bar({ pct, color }) {
  return (
    <div
      style={{
        height: 5,
        background: BG,
        borderRadius: 3,
        overflow: "hidden",
        width: "100%",
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.max(0, Math.min(100, pct))}%`,
          background: color,
          borderRadius: 3,
          transition: "width .6s",
        }}
      />
    </div>
  );
}

function Stat({ val, subVal, label, valColor, bg, labelColor }) {
  return (
    <div
      style={{
        background: bg || WH,
        border: `1px solid ${BD}`,
        borderRadius: 10,
        padding: "14px 14px",
        boxShadow: SH,
      }}
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: 26,
          fontWeight: 500,
          color: valColor || INK,
          lineHeight: 1,
        }}
      >
        {val}
        {subVal !== undefined && (
          <span style={{ fontSize: 15, color: INK3, marginLeft: 3 }}>/{subVal}</span>
        )}
      </div>
      <div
        style={{
          fontSize: 10,
          color: labelColor || INK3,
          fontWeight: 600,
          marginTop: 6,
          textTransform: "uppercase",
          letterSpacing: ".06em",
        }}
      >
        {label}
      </div>
    </div>
  );
}

function SectionTitle({ children, right }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: INK2,
        marginBottom: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        textTransform: "uppercase",
        letterSpacing: ".07em",
      }}
    >
      <span>{children}</span>
      {right}
    </div>
  );
}

function Shim({ w = "100%", h = 12, r = 6, style }) {
  return <div className="ld-shim" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

// Biomarker directionality map (true = lower value is better).
// Mirrors the logic in src/pages/FUReviewPage.jsx so improving/worsening
// stays consistent across the app.
const BIO_DIR = { hba1c: true, ldl: true, tg: true, fg: true, ppbs: true, hdl: false };

function classifyTrend(cur, prev, lowerIsBetter = true) {
  if (!cur || !prev) return "unknown";
  const diff = cur - prev;
  const pct = Math.abs(diff / prev) * 100;
  if (pct <= 5) return "stable";
  const down = diff < 0;
  if (lowerIsBetter) return down ? "better" : "worse";
  return down ? "worse" : "better";
}

function Card({ children, style }) {
  return (
    <div
      style={{
        background: WH,
        border: `1px solid ${BD}`,
        borderRadius: 10,
        padding: 14,
        boxShadow: SH,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function MultiSelectFilter({
  label: titleLabel,
  allLabel,
  unitSingular,
  unitPlural,
  options,
  selected,
  onChange,
  displayName,
  searchable = true,
  icon,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const total = options.length;
  const isAll = selected.size === 0 || selected.size === total;

  const triggerLabel =
    isAll || selected.size === 0
      ? allLabel
      : selected.size === 1
        ? displayName
          ? displayName([...selected][0])
          : [...selected][0]
        : `${selected.size} ${unitPlural || unitSingular + "s"}`;

  const toggleOne = (name) => {
    const cur = selected.size === 0 ? new Set(options) : new Set(selected);
    if (cur.has(name)) cur.delete(name);
    else cur.add(name);
    if (cur.size === 0 || cur.size === total) onChange(new Set());
    else onChange(cur);
  };

  const selectAll = () => onChange(new Set());
  const toggleAll = () => {
    if (isAll && total > 0) onChange(new Set([options[0]]));
    else onChange(new Set());
  };

  const filtered = query.trim()
    ? options.filter((d) => d.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  const isChecked = (name) => (selected.size === 0 ? true : selected.has(name));

  const CheckBox = ({ checked }) => (
    <span
      aria-hidden
      style={{
        width: 14,
        height: 14,
        borderRadius: 4,
        border: `1.5px solid ${checked ? T : BD}`,
        background: checked ? T : WH,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        transition: "all .12s",
      }}
    >
      {checked && (
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
          <path
            d="M1.5 5.2 4 7.7 8.8 2.8"
            stroke="#fff"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );

  const defaultIcon = (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 3.5h11M4.5 8h7M6.5 12.5h3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );

  return (
    <div ref={wrapRef} style={{ position: "relative", fontFamily: FB }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={titleLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          background: isAll ? WH : TL,
          border: `1px solid ${isAll ? BD : TB}`,
          color: isAll ? INK2 : T,
          borderRadius: 6,
          padding: "5px 10px",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
          fontFamily: FB,
          maxWidth: 220,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {icon || defaultIcon}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{triggerLabel}</span>
        {!isAll && (
          <span
            style={{
              background: T,
              color: WH,
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 10,
              padding: "1px 6px",
              fontFamily: FM,
              lineHeight: 1.3,
            }}
          >
            {selected.size}
          </span>
        )}
        <span
          style={{
            fontSize: 9,
            color: isAll ? INK3 : T,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform .15s",
            marginLeft: 1,
          }}
        >
          ▾
        </span>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 260,
            background: WH,
            border: `1px solid ${BD}`,
            borderRadius: 8,
            boxShadow: SH,
            zIndex: 50,
            overflow: "hidden",
            fontFamily: FB,
          }}
        >
          <div
            style={{
              padding: "10px 12px 8px",
              borderBottom: `1px solid ${BD}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, color: INK, letterSpacing: 0.2 }}>
              {titleLabel}
            </span>
            {!isAll && (
              <button
                type="button"
                onClick={selectAll}
                style={{
                  background: "none",
                  border: "none",
                  color: T,
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: "pointer",
                  padding: 0,
                  fontFamily: FB,
                }}
              >
                Reset
              </button>
            )}
          </div>

          {searchable && options.length > 6 && (
            <div style={{ padding: "8px 10px", borderBottom: `1px solid ${BD}` }}>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${unitPlural || unitSingular + "s"}…`}
                style={{
                  width: "100%",
                  padding: "5px 8px",
                  fontSize: 11,
                  fontFamily: FB,
                  color: INK,
                  border: `1px solid ${BD}`,
                  borderRadius: 5,
                  outline: "none",
                  background: BG,
                  boxSizing: "border-box",
                }}
                onFocus={(e) => (e.target.style.borderColor = T)}
                onBlur={(e) => (e.target.style.borderColor = BD)}
              />
            </div>
          )}

          <div style={{ maxHeight: 240, overflowY: "auto", padding: "4px 0" }}>
            <div
              role="button"
              tabIndex={0}
              onClick={toggleAll}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleAll();
                }
              }}
              className="ld-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "7px 12px",
                cursor: "pointer",
                fontSize: 11,
                color: INK,
                fontWeight: 600,
                borderBottom: `1px dashed ${BD}`,
                marginBottom: 2,
                userSelect: "none",
              }}
            >
              <CheckBox checked={isAll} />
              <span style={{ flex: 1 }}>{allLabel}</span>
              <span style={{ fontSize: 10, color: INK3, fontFamily: FM }}>{total}</span>
            </div>

            {filtered.length === 0 ? (
              <div
                style={{
                  padding: "10px 12px",
                  fontSize: 11,
                  color: INK3,
                  textAlign: "center",
                }}
              >
                No {unitPlural || unitSingular + "s"} match
              </div>
            ) : (
              filtered.map((name) => {
                const checked = isChecked(name);
                return (
                  <div
                    key={name}
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleOne(name)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleOne(name);
                      }
                    }}
                    className="ld-row"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "7px 12px",
                      cursor: "pointer",
                      fontSize: 11,
                      color: INK2,
                      userSelect: "none",
                    }}
                  >
                    <CheckBox checked={checked} />
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {displayName ? displayName(name) : name}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function LiveDashboard({
  appointments = [],
  doctors = [],
  updatedAt,
  isFetching,
  isPending = false,
  isError = false,
  error,
  onRefresh,
  onSelectAppt,
  date,
  onDateChange,
  onGenerateReport,
}) {
  const toLocalIso = (d) => {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}`;
  };
  const todayIso = toLocalIso(new Date());
  const isToday = !date || date === todayIso;
  const isMobile = useIsMobile();
  const isSmall = useIsMobile(480);
  const isNarrow = useIsMobile(1100);
  const grid5 = isSmall ? "1fr 1fr" : isMobile ? "1fr 1fr 1fr" : "repeat(5,1fr)";
  const grid6 = isSmall ? "1fr 1fr" : isMobile ? "1fr 1fr 1fr" : "repeat(6,1fr)";
  const grid7 = isSmall ? "1fr 1fr" : isMobile ? "1fr 1fr 1fr" : "repeat(7,1fr)";
  // 6 trend cards — capped at 3 columns on wide screens so chips stay legible.
  // Mobile = 1 col, tablet/<1100px = 2 col, desktop ≥1100px = 3 col.
  const gridTrend = isSmall || isMobile ? "1fr" : isNarrow ? "1fr 1fr" : "1fr 1fr 1fr";
  // Fixed body height on every trend card — list area scrolls when "Show more"
  // expands the row count, so the page layout doesn't jump.
  const TREND_BODY_HEIGHT = 280;
  const TREND_BODY_HEIGHT_EXPANDED = 380;
  const grid3 = isMobile ? "1fr" : "1fr 1fr 1fr";
  const grid2 = isSmall ? "1fr" : "1fr 1fr";
  const [calOpen, setCalOpen] = useState(false);
  useEffect(() => {
    if (!calOpen) return;
    const close = () => setCalOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [calOpen]);
  useTick(1000);

  const [selectedDoctors, setSelectedDoctors] = useState(() => new Set());
  const [selectedSpecs, setSelectedSpecs] = useState(() => new Set());

  const doctorSpecMap = useMemo(() => {
    const map = new Map();
    (Array.isArray(doctors) ? doctors : []).forEach((d) => {
      if (d && d.name) {
        const sp = (d.speciality || d.specialization || d.specialty || "").trim();
        if (sp) map.set(d.name, sp);
      }
    });
    return map;
  }, [doctors]);

  const doctorList = useMemo(() => {
    const set = new Set();
    (Array.isArray(appointments) ? appointments : []).forEach((a) => {
      if (a && a.doctor_name) set.add(a.doctor_name);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [appointments]);

  const specList = useMemo(() => {
    const set = new Set();
    doctorList.forEach((name) => {
      const sp = doctorSpecMap.get(name);
      if (sp) set.add(sp);
    });
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [doctorList, doctorSpecMap]);

  useEffect(() => {
    if (selectedDoctors.size === 0) return;
    const available = new Set(doctorList);
    let changed = false;
    const next = new Set();
    selectedDoctors.forEach((name) => {
      if (available.has(name)) next.add(name);
      else changed = true;
    });
    if (changed) setSelectedDoctors(next);
  }, [doctorList, selectedDoctors]);

  useEffect(() => {
    if (selectedSpecs.size === 0) return;
    const available = new Set(specList);
    let changed = false;
    const next = new Set();
    selectedSpecs.forEach((sp) => {
      if (available.has(sp)) next.add(sp);
      else changed = true;
    });
    if (changed) setSelectedSpecs(next);
  }, [specList, selectedSpecs]);

  const filteredAppointments = useMemo(() => {
    const base = Array.isArray(appointments) ? appointments : [];
    const hasDoc = selectedDoctors && selectedDoctors.size > 0;
    const hasSpec = selectedSpecs && selectedSpecs.size > 0;
    if (!hasDoc && !hasSpec) return base;
    return base.filter((a) => {
      if (hasDoc && !selectedDoctors.has(a.doctor_name)) return false;
      if (hasSpec) {
        const sp = doctorSpecMap.get(a.doctor_name);
        if (!sp || !selectedSpecs.has(sp)) return false;
      }
      return true;
    });
  }, [appointments, selectedDoctors, selectedSpecs, doctorSpecMap]);

  const m = useMemo(() => {
    const appts = Array.isArray(filteredAppointments) ? filteredAppointments : [];
    const get = (a) => {
      const bio = a.biomarkers || {};
      const prevBio = a.prev_biomarkers || {};
      const compl = a.compliance || {};
      const prevHba1c = Number(a.prev_hba1c) || Number(prevBio.hba1c) || null;
      const cur = Number(bio.hba1c) || null;
      const sbp = Number(bio.sbp) || null;
      const prevSbp = Number(prevBio.sbp) || null;
      // Composite outcome across all Tier-1 / Tier-2 biomarkers (matches the
      // period report's classifyPatient — keeps the daily and report bucket
      // counts comparable). Rows with at least one current reading but no
      // prior trend collapse into the "single" bucket below.
      const per = {};
      let anyTrend = false;
      for (const key of Object.keys(BIO_TIER)) {
        if (BIO_TIER[key] === 3) continue;
        const c = Number(bio[key]);
        const p = Number(prevBio[key]);
        const curV = Number.isFinite(c) ? c : null;
        const prevV = Number.isFinite(p) ? p : null;
        if (curV == null && prevV == null) continue;
        const status =
          curV != null && prevV != null ? classifyBiomarker(key, curV, prevV) : "unknown";
        if (status !== "unknown") anyTrend = true;
        per[key] = { cur: curV, prev: prevV, status };
      }
      const compositeRaw = classifyComposite(per);
      const composite = {
        outcome: anyTrend ? compositeRaw.outcome : "single",
        reasons: compositeRaw.reasons || [],
      };
      // Pull Tier-2 supporting values too — surfaced as small chips on each
      // patient row so the coordinator sees the full picture, not just HbA1c.
      return {
        id: a.id,
        name: firstName(a.patient_name),
        time: a.time_slot || "",
        status: a.status || "pending",
        category: a.category || null,
        hba1c: cur,
        prevHba1c,
        sbp,
        prevSbp,
        dbp: Number(bio.dbp) || null,
        fg: Number(bio.fg) || null,
        prevFg: Number(prevBio.fg) || null,
        ldl: Number(bio.ldl) || null,
        prevLdl: Number(prevBio.ldl) || null,
        tg: Number(bio.tg) || null,
        prevTg: Number(prevBio.tg) || null,
        uacr: Number(bio.uacr) || null,
        egfr: Number(bio.egfr) || null,
        medPct: compl.medPct != null ? Number(compl.medPct) : null,
        outcome: composite.outcome,
        outcomeReason: composite.reasons[0] || "",
        raw: a,
      };
    };
    const rows = appts.map(get);
    const total = rows.length;
    const withHba1c = rows.filter((r) => r.hba1c).length;
    const controlled = rows.filter((r) => r.hba1c && r.hba1c <= 7).length;
    const improving = rows.filter(
      (r) => r.hba1c && r.prevHba1c && r.hba1c > 7 && r.hba1c <= 9 && r.hba1c < r.prevHba1c,
    ).length;
    const uncontrolled = rows.filter((r) => r.hba1c && r.hba1c > 9).length;
    const rising = rows.filter((r) => r.hba1c && r.prevHba1c && r.hba1c > r.prevHba1c).length;
    const noData = rows.filter((r) => !r.hba1c).length;

    const countStatus = (s) => rows.filter((r) => r.status === s).length;
    const seen = countStatus("seen");
    const checkedin = countStatus("checkedin");
    const in_visit = countStatus("in_visit");
    const no_show = countStatus("no_show");
    const cancelled = countStatus("cancelled");
    // Pending soaks up everything not actioned and not terminal so the four
    // workflow buckets + no-show always add to total.
    const pending = total - seen - checkedin - in_visit - no_show - cancelled;

    const pctCoverage = total ? Math.round((withHba1c / total) * 100) : 0;
    const pctControlled = withHba1c ? Math.round((controlled / withHba1c) * 100) : 0;

    const needsAttention = rows
      .filter(
        (r) =>
          r.hba1c &&
          (r.hba1c > 9 ||
            (r.prevHba1c && r.hba1c > r.prevHba1c && r.hba1c > 8) ||
            (r.medPct != null && r.medPct < 60)),
      )
      .sort((a, b) => b.hba1c - a.hba1c);

    const missingBio = rows.filter(
      (r) => !r.hba1c && r.status !== "cancelled" && r.status !== "no_show",
    );

    const onTrack = rows
      .filter((r) => r.hba1c && r.hba1c <= 7.5 && (!r.prevHba1c || r.hba1c <= r.prevHba1c))
      .sort((a, b) => a.hba1c - b.hba1c);

    // Tier-1 composite outcome (HbA1c + SBP). Mixed = HbA1c improving but
    // SBP worsening (or vice-versa). Partial = no prior reading on either.
    // Trend buckets use the same composite-across-all-biomarkers classifier
    // as the period report, so the five tiles (worse/mixed/stable/better/single)
    // partition exactly `total` and match the report's "Getting Better /
    // Stable / Flag for review / Getting Worse / Single Visit" totals.
    const gettingBetter = rows
      .filter((r) => r.outcome === "better")
      .sort((a, b) => (b.prevHba1c || 0) - (b.hba1c || 0) - ((a.prevHba1c || 0) - (a.hba1c || 0)));

    const gettingWorse = rows
      .filter((r) => r.outcome === "worse")
      .sort((a, b) => (b.hba1c || 0) - (b.prevHba1c || 0) - ((a.hba1c || 0) - (a.prevHba1c || 0)));

    const mixedSignals = rows.filter((r) => r.outcome === "mixed");

    // "trendable" = rows where the composite outcome could resolve a direction
    // (better/worse/mixed/stable). Single = at least one reading but no prior
    // to compare against (matches the report's "Single Visit" bucket).
    const trendable = rows.filter(
      (r) =>
        r.outcome === "better" ||
        r.outcome === "worse" ||
        r.outcome === "mixed" ||
        r.outcome === "stable",
    ).length;
    const singleVisit = rows.filter((r) => r.outcome === "single").length;
    // newHba1c kept for downstream label "First reading — no prior" — mirrors
    // the report's single-visit count rather than HbA1c-only.
    const newHba1c = singleVisit;
    const stablePatients = rows.filter((r) => r.outcome === "stable");
    const stableTrend = stablePatients.length;
    const pctBetter = trendable ? Math.round((gettingBetter.length / trendable) * 100) : 0;
    const pctWorse = trendable ? Math.round((gettingWorse.length / trendable) * 100) : 0;
    const pctStable = trendable ? Math.max(0, 100 - pctBetter - pctWorse) : 0;
    const avgDeltaBetter = gettingBetter.length
      ? gettingBetter.reduce((s, r) => s + (r.hba1c - r.prevHba1c), 0) / gettingBetter.length
      : 0;
    const avgDeltaWorse = gettingWorse.length
      ? gettingWorse.reduce((s, r) => s + (r.hba1c - r.prevHba1c), 0) / gettingWorse.length
      : 0;

    const buckets = [
      rows.filter((r) => r.hba1c && r.hba1c <= 7).length,
      rows.filter((r) => r.hba1c && r.hba1c > 7 && r.hba1c <= 8).length,
      rows.filter((r) => r.hba1c && r.hba1c > 8 && r.hba1c <= 9).length,
      rows.filter((r) => r.hba1c && r.hba1c > 9 && r.hba1c <= 10).length,
      rows.filter((r) => r.hba1c && r.hba1c > 10).length,
    ];

    return {
      rows,
      total,
      withHba1c,
      controlled,
      improving,
      uncontrolled,
      rising,
      noData,
      seen,
      checkedin,
      in_visit,
      pending,
      no_show,
      cancelled,
      othersTotal: total - seen - checkedin - in_visit - pending - no_show - cancelled,
      pctCoverage,
      pctControlled,
      needsAttention,
      missingBio,
      onTrack,
      gettingBetter,
      gettingWorse,
      mixedSignals,
      stablePatients,
      trendable,
      newHba1c,
      stableTrend,
      pctBetter,
      pctWorse,
      pctStable,
      avgDeltaBetter,
      avgDeltaWorse,
      buckets,
    };
  }, [filteredAppointments]);

  const coverageColor = m.pctCoverage >= 80 ? GN : m.pctCoverage >= 60 ? AM : RE;
  const controlColor = m.pctControlled >= 60 ? GN : m.pctControlled >= 30 ? AM : RE;

  const displayDate = date ? new Date(date + "T00:00:00") : new Date();
  const todayStr = displayDate.toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const flowRow = (key, label, color) => {
    const counts = {
      seen: m.seen,
      in_visit: m.in_visit,
      checkedin: m.checkedin,
      pending: m.pending,
      no_show: m.no_show,
      cancelled: m.cancelled,
    };
    const count = counts[key] || 0;
    if (!count) return null;
    const pct = m.total ? Math.round((count / m.total) * 100) : 0;
    return (
      <div key={key} style={{ marginBottom: 7 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: 11,
            marginBottom: 3,
          }}
        >
          <span style={{ color, fontWeight: 600 }}>{label}</span>
          <span style={{ fontFamily: FM, color: INK2 }}>{count}</span>
        </div>
        <Bar pct={pct} color={color} />
      </div>
    );
  };

  const select = (row, e) => {
    // Ctrl/Cmd/Shift/middle-click → open the visit in a new tab so the
    // coordinator can keep the dashboard open while reviewing a patient.
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
      e.preventDefault();
      const a = row.raw || {};
      if (a.patient_id != null && a.id != null) {
        const url = `/visit?patient=${encodeURIComponent(a.patient_id)}&appt=${encodeURIComponent(a.id)}`;
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
    }
    if (onSelectAppt) onSelectAppt(row.raw);
  };

  // Lists scroll inside their card body (fixed height) so we always render the
  // full list — no "+N more" toggle needed.

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: isMobile ? "12px 10px" : "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        fontFamily: FB,
        color: INK,
      }}
    >
      {/* ── Header ────────────────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <div>
          <div style={{ fontFamily: FD, fontSize: 22, color: INK }}>
            {isToday ? "Today's Clinical Dashboard" : "Clinical Dashboard"}
          </div>
          <div style={{ fontSize: 11, color: INK3 }}>{todayStr}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              background: isToday ? GNL : AML,
              border: `1px solid ${isToday ? GN : AM}22`,
              borderRadius: 16,
              padding: "4px 11px",
              fontSize: 11,
              color: isToday ? GN : AM,
              fontWeight: 600,
            }}
          >
            <span
              className="ld-dot"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: isToday ? GN : AM,
                display: "inline-block",
                opacity: isFetching ? 1 : 0.85,
              }}
            />
            {isToday ? `Live · Updated ${fmtTime(updatedAt)}` : "Historical view"}
          </div>
          {onDateChange && !isToday && (
            <button
              type="button"
              onClick={() => onDateChange(todayIso)}
              style={{
                background: TL,
                border: `1px solid ${TB}`,
                color: T,
                borderRadius: 6,
                padding: "5px 11px",
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              Today
            </button>
          )}
          {onDateChange && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                background: WH,
                border: `1px solid ${BD}`,
                borderRadius: 6,
                padding: "2px 4px",
                position: "relative",
              }}
            >
              <button
                type="button"
                onClick={() => {
                  const d = new Date(displayDate);
                  d.setDate(d.getDate() - 1);
                  onDateChange(toLocalIso(d));
                }}
                title="Previous day"
                style={{
                  background: "none",
                  border: "none",
                  padding: "2px 6px",
                  fontSize: 13,
                  color: INK2,
                  cursor: "pointer",
                  fontFamily: FB,
                }}
              >
                ‹
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setCalOpen((v) => !v);
                }}
                style={{
                  background: "none",
                  border: "none",
                  outline: "none",
                  fontFamily: FM,
                  fontSize: 11,
                  color: INK,
                  padding: "3px 6px",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}
              >
                📅 {date || todayIso}
              </button>
              <button
                type="button"
                disabled={isToday}
                onClick={() => {
                  const d = new Date(displayDate);
                  d.setDate(d.getDate() + 1);
                  const next = toLocalIso(d);
                  if (next <= todayIso) onDateChange(next);
                }}
                title="Next day"
                style={{
                  background: "none",
                  border: "none",
                  padding: "2px 6px",
                  fontSize: 13,
                  color: isToday ? INK3 : INK2,
                  cursor: isToday ? "default" : "pointer",
                  opacity: isToday ? 0.4 : 1,
                  fontFamily: FB,
                }}
              >
                ›
              </button>
              {calOpen && (
                <CustomCalendar
                  value={date || todayIso}
                  maxDate={todayIso}
                  onSelect={(v) => onDateChange(v)}
                  onClose={() => setCalOpen(false)}
                />
              )}
            </div>
          )}
          {onGenerateReport && (
            <button
              type="button"
              onClick={onGenerateReport}
              style={{
                background: T,
                border: `1px solid ${T}`,
                color: WH,
                borderRadius: 6,
                padding: "5px 11px",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              📝 Generate Report
            </button>
          )}
          {specList.length > 0 && (
            <MultiSelectFilter
              label="Filter by specialization"
              allLabel="All specializations"
              unitSingular="specialization"
              unitPlural="specializations"
              options={specList}
              selected={selectedSpecs}
              onChange={setSelectedSpecs}
              icon={
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M8 1.8v3.1M8 11.1v3.1M1.8 8h3.1M11.1 8h3.1M4.5 4.5 6.6 6.6M9.4 9.4l2.1 2.1M11.5 4.5 9.4 6.6M6.6 9.4 4.5 11.5"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              }
            />
          )}
          {doctorList.length > 0 && (
            <MultiSelectFilter
              label="Filter by doctor"
              allLabel="All doctors"
              unitSingular="doctor"
              unitPlural="doctors"
              options={doctorList}
              selected={selectedDoctors}
              onChange={setSelectedDoctors}
              displayName={firstName}
              icon={
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <circle cx="8" cy="5.2" r="2.6" stroke="currentColor" strokeWidth="1.4" />
                  <path
                    d="M2.8 13.6c.9-2.5 3-3.6 5.2-3.6s4.3 1.1 5.2 3.6"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              }
            />
          )}
          <button
            onClick={onRefresh}
            disabled={isFetching}
            style={{
              background: WH,
              border: `1px solid ${BD}`,
              color: INK2,
              borderRadius: 6,
              padding: "5px 11px",
              fontSize: 11,
              fontWeight: 600,
              cursor: isFetching ? "default" : "pointer",
              opacity: isFetching ? 0.6 : 1,
              fontFamily: FB,
            }}
          >
            {isFetching ? "… refreshing" : "⟳ Refresh"}
          </button>
        </div>
      </div>

      {isError && (
        <Card style={{ borderLeft: `3px solid ${RE}` }}>
          <div style={{ fontSize: 12, color: RE, fontWeight: 600, marginBottom: 4 }}>
            Failed to load dashboard
          </div>
          <div style={{ fontSize: 11, color: INK2, marginBottom: 8 }}>
            {error?.message || "Network error. Please try again."}
          </div>
          <button
            type="button"
            onClick={onRefresh}
            style={{
              background: T,
              color: WH,
              border: "none",
              borderRadius: 6,
              padding: "6px 12px",
              fontSize: 11,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            ⟳ Retry
          </button>
        </Card>
      )}

      {isPending ? (
        <>
          <div style={{ display: "grid", gridTemplateColumns: grid5, gap: 10 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <Card key={i}>
                <Shim w="60%" h={24} />
                <div style={{ height: 8 }} />
                <Shim w="80%" h={10} />
              </Card>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: grid3, gap: 10 }}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i}>
                <Shim w="50%" h={12} />
                <div style={{ height: 10 }} />
                <Shim w="100%" h={70} r={8} />
              </Card>
            ))}
          </div>
          <Card>
            <Shim w="40%" h={12} />
            <div style={{ height: 12 }} />
            <Shim w="100%" h={12} />
            <div style={{ height: 6 }} />
            <Shim w="90%" h={10} />
          </Card>
          <div style={{ display: "grid", gridTemplateColumns: grid2, gap: 10 }}>
            {Array.from({ length: 2 }).map((_, col) => (
              <Card key={col}>
                <Shim w="45%" h={12} />
                <div style={{ height: 10 }} />
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} style={{ marginBottom: 8 }}>
                    <Shim w="100%" h={34} r={7} />
                  </div>
                ))}
              </Card>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* ── Tier-1 outcome row (HbA1c + SBP composite) ────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: grid7,
              gap: 10,
              flexShrink: 0,
            }}
          >
            <Stat val={m.total} label="Today's appointments" />
            <Stat
              val={m.withHba1c}
              subVal={m.total}
              label="HbA1c on file"
              valColor={coverageColor}
            />
            <Stat
              val={m.gettingWorse.length}
              label="Getting worse ↑"
              valColor={m.gettingWorse.length ? RE : INK3}
              bg={m.gettingWorse.length ? REL : WH}
              labelColor={m.gettingWorse.length ? RE : INK3}
            />
            <Stat
              val={m.mixedSignals.length}
              label="⚠ Mixed signals"
              valColor={m.mixedSignals.length ? AM : INK3}
              bg={m.mixedSignals.length ? AML : WH}
              labelColor={m.mixedSignals.length ? AM : INK3}
            />
            <Stat
              val={m.stableTrend}
              label="Stable"
              valColor={m.stableTrend ? INK : INK3}
              labelColor={INK3}
            />
            <Stat
              val={m.gettingBetter.length}
              label="Getting better ↓"
              valColor={m.gettingBetter.length ? GN : INK3}
              bg={m.gettingBetter.length ? GNL : WH}
              labelColor={m.gettingBetter.length ? GN : INK3}
            />
            <Stat
              val={m.newHba1c}
              label="First reading — no prior"
              valColor={m.newHba1c ? INK : INK3}
              labelColor={INK3}
            />
          </div>

          {/* ── Middle row: rings + flow ──────────────────────────── */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: grid3,
              gap: 10,
              flexShrink: 0,
            }}
          >
            <Card style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <Ring pct={m.pctCoverage} color={coverageColor} centerLabel="data" />
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>
                  Biomarker Coverage
                </div>
                <div style={{ fontSize: 11, color: INK3 }}>
                  {m.withHba1c} of {m.total} appointments have HbA1c on file
                </div>
                {m.noData > 0 ? (
                  <div style={{ fontSize: 11, color: RE, marginTop: 6, fontWeight: 600 }}>
                    ⚠ {m.noData} missing — enter before visit
                  </div>
                ) : m.total > 0 ? (
                  <div style={{ fontSize: 11, color: GN, marginTop: 6 }}>
                    ✓ All patients have data
                  </div>
                ) : null}
              </div>
            </Card>

            <Card style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <StackedRing
                segments={[
                  { pct: m.pctWorse, color: RE, label: "Worse", count: m.gettingWorse.length },
                  { pct: m.pctStable, color: AM, label: "Stable", count: m.stableTrend },
                  { pct: m.pctBetter, color: GN, label: "Better", count: m.gettingBetter.length },
                ]}
                centerValue={m.trendable}
                centerLabel="trended"
                centerColor={INK}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>HbA1c Trend</div>
                <div style={{ fontSize: 11, color: INK3, marginBottom: 6 }}>
                  {m.trendable} patients with prior value
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span style={{ color: GN, fontWeight: 600 }}>📈 Better</span>
                    <span style={{ fontFamily: FM, color: GN, fontWeight: 600 }}>
                      {m.gettingBetter.length} · {m.pctBetter}%
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span style={{ color: AM, fontWeight: 600 }}>→ Stable</span>
                    <span style={{ fontFamily: FM, color: AM, fontWeight: 600 }}>
                      {m.stableTrend} · {m.pctStable}%
                    </span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
                    <span style={{ color: RE, fontWeight: 600 }}>📉 Worse</span>
                    <span style={{ fontFamily: FM, color: RE, fontWeight: 600 }}>
                      {m.gettingWorse.length} · {m.pctWorse}%
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <SectionTitle>Today&apos;s visit flow</SectionTitle>
              {flowRow("seen", "Seen", GN)}
              {flowRow("in_visit", "With doctor", "#7c3aed")}
              {flowRow("checkedin", "Checked in", SK)}
              {flowRow("pending", "Pending", INK3)}
              {flowRow("no_show", "No-show", RE)}
              {flowRow("cancelled", "Cancelled", INK3)}
              {m.total === 0 && (
                <div style={{ fontSize: 11, color: INK3 }}>No appointments today</div>
              )}
            </Card>
          </div>

          {/* ── Six trend cards: worse · mixed · stable · better · attention · on-track · missing-bio ── */}
          <div style={{ display: "grid", gridTemplateColumns: gridTrend, gap: 10 }}>
            <Card>
              <SectionTitle
                right={
                  <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                    {m.gettingWorse.length} patients · {m.pctWorse}%
                  </span>
                }
              >
                📉 Getting worse — Tier 1 (HbA1c / SBP)
              </SectionTitle>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 8,
                  paddingBottom: 8,
                  borderBottom: `1px solid ${BD}`,
                }}
              >
                <div
                  style={{
                    fontFamily: FM,
                    fontSize: 24,
                    fontWeight: 500,
                    color: RE,
                    lineHeight: 1,
                  }}
                >
                  {m.gettingWorse.length}
                </div>
                <div style={{ fontSize: 10, color: INK3 }}>
                  of {m.trendable} trended · avg{" "}
                  <span style={{ color: RE, fontFamily: FM, fontWeight: 600 }}>
                    +{m.avgDeltaWorse.toFixed(2)}%
                  </span>
                </div>
              </div>
              <Bar pct={m.pctWorse} color={RE} />
              <div style={{ height: 8 }} />
              {m.gettingWorse.length === 0 ? (
                <div style={{ fontSize: 12, color: INK3, padding: "4px 0" }}>
                  No Tier-1 deterioration today
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: TREND_BODY_HEIGHT_EXPANDED,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  {m.gettingWorse.map((r) => {
                    const delta = (r.hba1c - r.prevHba1c).toFixed(1);
                    return (
                      <div
                        key={r.id}
                        className="ld-row"
                        onClick={(e) => select(r, e)}
                        onAuxClick={(e) => select(r, e)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "7px 10px",
                          background: REL,
                          border: `1px solid ${RE}22`,
                          borderRadius: 7,
                          marginBottom: 6,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>
                            {r.name}
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 8,
                                fontWeight: 800,
                                padding: "1px 5px",
                                borderRadius: 6,
                                background: GNL,
                                color: GN,
                                border: `1px solid ${GN}`,
                                letterSpacing: ".04em",
                              }}
                            >
                              T1
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: INK3 }}>{r.time}</div>
                          {r.outcomeReason && (
                            <div style={{ fontSize: 9, color: RE, marginTop: 2, fontWeight: 600 }}>
                              {r.outcomeReason}
                            </div>
                          )}
                          <ParamChips r={r} />
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontFamily: FM, fontSize: 10, color: RE, fontWeight: 600 }}>
                            +{delta} ↑
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card>
              <SectionTitle
                right={
                  <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                    {m.gettingBetter.length} patients · {m.pctBetter}%
                  </span>
                }
              >
                📈 Getting better — Tier 1 (HbA1c / SBP)
              </SectionTitle>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  marginBottom: 8,
                  paddingBottom: 8,
                  borderBottom: `1px solid ${BD}`,
                }}
              >
                <div
                  style={{
                    fontFamily: FM,
                    fontSize: 24,
                    fontWeight: 500,
                    color: GN,
                    lineHeight: 1,
                  }}
                >
                  {m.gettingBetter.length}
                </div>
                <div style={{ fontSize: 10, color: INK3 }}>
                  of {m.trendable} trended · avg{" "}
                  <span style={{ color: GN, fontFamily: FM, fontWeight: 600 }}>
                    {m.avgDeltaBetter.toFixed(2)}%
                  </span>
                </div>
              </div>
              <Bar pct={m.pctBetter} color={GN} />
              <div style={{ height: 8 }} />
              {m.gettingBetter.length === 0 ? (
                <div style={{ fontSize: 12, color: INK3, padding: "4px 0" }}>
                  No Tier-1 improvement today
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: TREND_BODY_HEIGHT_EXPANDED,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  {m.gettingBetter.map((r) => {
                    const delta = (r.hba1c - r.prevHba1c).toFixed(1);
                    return (
                      <div
                        key={r.id}
                        className="ld-row"
                        onClick={(e) => select(r, e)}
                        onAuxClick={(e) => select(r, e)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "7px 10px",
                          background: GNL,
                          border: `1px solid ${GN}22`,
                          borderRadius: 7,
                          marginBottom: 6,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>
                            {r.name}
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 8,
                                fontWeight: 800,
                                padding: "1px 5px",
                                borderRadius: 6,
                                background: GNL,
                                color: GN,
                                border: `1px solid ${GN}`,
                                letterSpacing: ".04em",
                              }}
                            >
                              T1
                            </span>
                          </div>
                          <div style={{ fontSize: 10, color: INK3 }}>{r.time}</div>
                          {r.outcomeReason && (
                            <div style={{ fontSize: 9, color: GN, marginTop: 2, fontWeight: 600 }}>
                              {r.outcomeReason}
                            </div>
                          )}
                          <ParamChips r={r} />
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontFamily: FM, fontSize: 10, color: GN, fontWeight: 600 }}>
                            {delta} ↓
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* ── ⚠ Flag for review — Tier-1 better but Tier-2 conflicts ──────── */}
            {
              <Card>
                <SectionTitle
                  right={
                    <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                      {m.mixedSignals.length} patients
                    </span>
                  }
                >
                  ⚠ Flag for review
                </SectionTitle>
                <div style={{ fontSize: 10, color: INK3, marginBottom: 8 }}>
                  Tier 1 and Tier 2 are moving in opposite directions, or one condition is improving
                  while another is deteriorating. Do not mark these patients "improving" without a
                  doctor review.
                </div>
                {m.mixedSignals.length === 0 ? (
                  <div style={{ fontSize: 12, color: GN, padding: "8px 0" }}>
                    ✓ No conflicting signals today
                  </div>
                ) : (
                  <div
                    style={{
                      maxHeight: TREND_BODY_HEIGHT_EXPANDED,
                      overflowY: "auto",
                      paddingRight: 4,
                    }}
                  >
                    {m.mixedSignals.map((r) => {
                      const sbpBad = r.sbp && r.sbp >= 130;
                      return (
                        <div
                          key={r.id}
                          className="ld-row"
                          onClick={(e) => select(r, e)}
                          onAuxClick={(e) => select(r, e)}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "7px 10px",
                            background: AML,
                            border: `1px solid ${AM}33`,
                            borderRadius: 7,
                            marginBottom: 6,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>
                              {r.name}
                              <span
                                style={{
                                  marginLeft: 6,
                                  fontSize: 8,
                                  fontWeight: 800,
                                  padding: "1px 5px",
                                  borderRadius: 6,
                                  background: AML,
                                  color: AM,
                                  border: `1px solid ${AM}`,
                                  letterSpacing: ".04em",
                                }}
                              >
                                ⚠ MIXED
                              </span>
                            </div>
                            {r.outcomeReason && (
                              <div
                                style={{ fontSize: 10, color: AM, marginTop: 2, fontWeight: 600 }}
                              >
                                {r.outcomeReason}
                              </div>
                            )}
                            <ParamChips r={r} />
                          </div>
                          <div style={{ textAlign: "right" }}>
                            {sbpBad && (
                              <div
                                style={{ fontFamily: FM, fontSize: 10, color: RE, fontWeight: 700 }}
                              >
                                ⚠
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            }

            {/* ── Stable patients — Tier-1 within ±0.3% / ±5 mmHg ───── */}
            {
              <Card>
                <SectionTitle
                  right={
                    <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                      {m.stablePatients.length} patients · {m.pctStable}%
                    </span>
                  }
                >
                  ➖ Stable — Tier 1 (HbA1c / SBP)
                </SectionTitle>
                <div style={{ fontSize: 10, color: INK3, marginBottom: 8 }}>
                  No meaningful change since last visit (HbA1c ±0.3% · SBP ±5 mmHg).
                </div>
                {m.stablePatients.length === 0 ? (
                  <div style={{ fontSize: 12, color: INK3, padding: "8px 0" }}>
                    No stable patients today
                  </div>
                ) : (
                  <div
                    style={{
                      maxHeight: TREND_BODY_HEIGHT_EXPANDED,
                      overflowY: "auto",
                      paddingRight: 4,
                    }}
                  >
                    {m.stablePatients.map((r) => {
                      const sbpBad = r.sbp && r.sbp >= 130;
                      const hbaBad = r.hba1c && r.hba1c > 9;
                      return (
                        <div
                          key={r.id}
                          className="ld-row"
                          onClick={(e) => select(r, e)}
                          onAuxClick={(e) => select(r, e)}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            padding: "7px 10px",
                            background: BG,
                            border: `1px solid ${BD}`,
                            borderRadius: 7,
                            marginBottom: 6,
                          }}
                        >
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>
                              {r.name}
                              <span
                                style={{
                                  marginLeft: 6,
                                  fontSize: 8,
                                  fontWeight: 800,
                                  padding: "1px 5px",
                                  borderRadius: 6,
                                  background: WH,
                                  color: INK3,
                                  border: `1px solid ${INK3}`,
                                  letterSpacing: ".04em",
                                }}
                              >
                                → STABLE
                              </span>
                            </div>
                            <div style={{ fontSize: 10, color: INK3 }}>{r.time}</div>
                            {(hbaBad || sbpBad) && (
                              <div
                                style={{ fontSize: 9, color: AM, marginTop: 2, fontWeight: 600 }}
                              >
                                stable but{hbaBad ? ` HbA1c ${r.hba1c}% above target` : ""}
                                {hbaBad && sbpBad ? " · " : ""}
                                {sbpBad ? `SBP ${r.sbp} above target` : ""}
                              </div>
                            )}
                            <ParamChips r={r} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </Card>
            }

            {/* ── Needs extra attention ─────────────────────────────── */}
            <Card>
              <SectionTitle
                right={
                  <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                    {m.needsAttention.length} patients
                  </span>
                }
              >
                ⚠ Needs extra attention
              </SectionTitle>
              {m.needsAttention.length === 0 ? (
                <div style={{ fontSize: 12, color: GN, padding: "8px 0" }}>
                  ✓ All controlled patients today
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: TREND_BODY_HEIGHT_EXPANDED,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  {m.needsAttention.map((r) => {
                    const trend =
                      r.prevHba1c && r.hba1c > r.prevHba1c
                        ? "↑"
                        : r.prevHba1c && r.hba1c < r.prevHba1c
                          ? "↓"
                          : "";
                    const reasons = [];
                    if (r.hba1c > 9) reasons.push("HbA1c " + r.hba1c + "%");
                    if (r.prevHba1c && r.hba1c > r.prevHba1c)
                      reasons.push("Rising from " + r.prevHba1c + "%");
                    if (r.medPct != null && r.medPct < 60) reasons.push(r.medPct + "% compliance");
                    return (
                      <div
                        key={r.id}
                        className="ld-row"
                        onClick={(e) => select(r, e)}
                        onAuxClick={(e) => select(r, e)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "8px 10px",
                          background: REL,
                          border: `1px solid ${RE}22`,
                          borderRadius: 7,
                          marginBottom: 6,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>{r.name}</div>
                          <div style={{ fontSize: 10, color: RE }}>{reasons.join(" · ")}</div>
                          <ParamChips r={r} />
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontFamily: FM, fontSize: 13, color: RE, fontWeight: 600 }}>
                            <span style={{ color: trend === "↑" ? RE : GN }}>{trend}</span>
                          </div>
                          <div style={{ fontSize: 10, color: INK3 }}>{r.time}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* ── On track today ────────────────────────────────────── */}
            <Card>
              <SectionTitle
                right={
                  <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                    {m.onTrack.length} patients
                  </span>
                }
              >
                ✅ On track today
              </SectionTitle>
              {m.onTrack.length === 0 ? (
                <div style={{ fontSize: 12, color: INK3 }}>No patients at target today</div>
              ) : (
                <div
                  style={{
                    maxHeight: TREND_BODY_HEIGHT_EXPANDED,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  {m.onTrack.map((r) => {
                    const trend =
                      r.prevHba1c && r.hba1c > r.prevHba1c
                        ? "↑"
                        : r.prevHba1c && r.hba1c < r.prevHba1c
                          ? "↓"
                          : "";
                    return (
                      <div
                        key={r.id}
                        className="ld-row"
                        onClick={(e) => select(r, e)}
                        onAuxClick={(e) => select(r, e)}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "7px 10px",
                          background: GNL,
                          border: `1px solid ${GN}22`,
                          borderRadius: 7,
                          marginBottom: 6,
                        }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>{r.name}</div>
                          <div style={{ fontSize: 10, color: GN }}>
                            {r.category === "ctrl" ? "Controlled" : "Improving"}
                          </div>
                          <ParamChips r={r} />
                        </div>
                        <div style={{ fontFamily: FM, fontSize: 13, color: GN, fontWeight: 600 }}>
                          <span>{trend}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* ── No biomarkers yet ─────────────────────────────────── */}
            <Card>
              <SectionTitle
                right={
                  <span style={{ fontSize: 10, color: INK3, fontWeight: 400 }}>
                    {m.missingBio.length} patients
                  </span>
                }
              >
                ⚠ No biomarkers yet
              </SectionTitle>
              {m.missingBio.length === 0 ? (
                <div style={{ fontSize: 12, color: GN, padding: "8px 0" }}>
                  ✓ All patients have biomarker data
                </div>
              ) : (
                <div
                  style={{
                    maxHeight: TREND_BODY_HEIGHT_EXPANDED,
                    overflowY: "auto",
                    paddingRight: 4,
                  }}
                >
                  {m.missingBio.map((r) => (
                    <div
                      key={r.id}
                      className="ld-row"
                      onClick={(e) => select(r, e)}
                      onAuxClick={(e) => select(r, e)}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "7px 10px",
                        background: AML,
                        border: `1px solid ${AM}22`,
                        borderRadius: 7,
                        marginBottom: 6,
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 12, color: INK }}>{r.name}</div>
                        <div style={{ fontSize: 10, color: AM }}>Enter HbA1c before visit</div>
                      </div>
                      <div style={{ fontSize: 10, color: INK3, fontFamily: FM }}>{r.time}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
