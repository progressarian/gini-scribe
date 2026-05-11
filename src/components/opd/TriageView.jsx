import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  targetStatus,
  classifyBiomarker,
  classifyComposite,
  BIO_TIER,
} from "../../utils/biomarkerClassify.js";
import { useIsMobile } from "../../hooks/useIsMobile.js";
import CustomCalendar from "../ui/CustomCalendar.jsx";

// ── Design tokens — kept in sync with LiveDashboard.jsx ──
const T = "#009e8c";
const TL = "#e6f6f4";
const TB = "rgba(0,158,140,.22)";
const NV = "#0e2240";
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
const LV = "#7c3aed";
const LVL = "#f5f3ff";
const SH = "0 1px 3px rgba(0,0,0,.08),0 1px 2px rgba(0,0,0,.05)";

// Appointment status pill — mirrors `statusSty()` in src/OPD.jsx so the
// triage card and the schedule list use the same labels/colours.
// `pulse` flags active in-clinic states that get a pulsing dot.
const STATUS_STYLE = {
  seen: { label: "Seen", fg: GN, bg: GNL, pulse: false },
  completed: { label: "Seen", fg: GN, bg: GNL, pulse: false },
  in_visit: { label: "In Visit", fg: LV, bg: LVL, pulse: true },
  checkedin: { label: "Checked In", fg: SK, bg: SKL, pulse: true },
  prepped: { label: "Ready", fg: T, bg: TL, pulse: false },
  no_show: { label: "No Show", fg: INK3, bg: BG, pulse: false },
  cancelled: { label: "Cancelled", fg: INK3, bg: BG, pulse: false },
  pending: { label: "Pending", fg: INK3, bg: BG, pulse: false },
};
const statusOf = (s) => STATUS_STYLE[s] || STATUS_STYLE.pending;

const FB = "'Inter',system-ui,sans-serif";
const FD = "'Instrument Serif',serif";
const FM = "'DM Mono',monospace";

// Shimmer keyframes — reuse the Live Dashboard's idiom. Inject once.
if (typeof document !== "undefined" && !document.getElementById("triage-shim-kf")) {
  const s = document.createElement("style");
  s.id = "triage-shim-kf";
  s.textContent = `
@keyframes triShimmer {
  0%   { background-position: -150% 0; }
  100% { background-position: 150% 0; }
}
.tri-shim {
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
  animation: triShimmer 1.4s ease-in-out infinite;
  overflow: hidden;
}
`;
  document.head.appendChild(s);
}

function Shim({ w = "100%", h = 12, r = 6, style }) {
  return <div className="tri-shim" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

const TIER_KEYS = ["hba1c", "sbp", "dbp", "fg", "ldl", "tg", "uacr", "egfr"];

const KEY_LABEL = {
  hba1c: "HbA1c",
  sbp: "BP",
  dbp: "DBP",
  fg: "FBS",
  ldl: "LDL",
  tg: "TG",
  uacr: "UACR",
  egfr: "eGFR",
};

const toLocalIso = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
};

const fmtTime = (ms) => {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

function num(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

function readBio(appt) {
  const b = appt.biomarkers || {};
  return {
    hba1c: num(b.hba1c),
    sbp: num(b.sbp ?? b.bpSys),
    dbp: num(b.dbp ?? b.bpDia),
    fg: num(b.fg ?? b.fbs),
    ldl: num(b.ldl),
    tg: num(b.tg),
    uacr: num(b.uacr),
    egfr: num(b.egfr),
  };
}

// Compute the dashboard's composite outcome for an appointment by comparing
// `biomarkers` (current) against `prev_biomarkers` (last visit). Same shape
// LiveDashboard builds in its `m = useMemo()` block — kept identical so
// triage and the live dashboard agree on every patient's bucket.
function computeOutcome(appt) {
  const bio = appt.biomarkers || {};
  const prevBio = appt.prev_biomarkers || {};
  const per = {};
  let anyTrend = false;
  for (const key of Object.keys(BIO_TIER)) {
    if (BIO_TIER[key] === 3) continue; // skip Tier-3 (weight, hb, etc.)
    const c = Number(bio[key]);
    const p = Number(prevBio[key]);
    const curV = Number.isFinite(c) ? c : null;
    const prevV = Number.isFinite(p) ? p : null;
    if (curV == null && prevV == null) continue;
    const status = curV != null && prevV != null ? classifyBiomarker(key, curV, prevV) : "unknown";
    if (status !== "unknown") anyTrend = true;
    per[key] = { cur: curV, prev: prevV, status };
  }
  // Allow `prev_hba1c` (legacy field) when prev_biomarkers doesn't carry it.
  if (per.hba1c && per.hba1c.prev == null && Number.isFinite(Number(appt.prev_hba1c))) {
    per.hba1c.prev = Number(appt.prev_hba1c);
    per.hba1c.status = classifyBiomarker("hba1c", per.hba1c.cur, per.hba1c.prev);
    if (per.hba1c.status !== "unknown") anyTrend = true;
  }
  const composite = classifyComposite(per);
  // "single" = at least one current reading but no prior to trend against —
  // matches LiveDashboard's collapse rule so totals line up.
  return anyTrend ? composite.outcome : "single";
}

// Patient triage tier — trend-first, target-fallback.
//
// Primary signal is the **dashboard's composite outcome** (better / worse /
// mixed / stable / partial / single). This puts triage and the live
// dashboard on the same logic so the two views never disagree.
//
// Mapping:
//   worse  → 🔴 Red   (Tier-1 marker is deteriorating — expert help)
//   mixed  → 🟡 Amber (Flag for review — conflicting signals)
//   better → ✅ Green when at-target, else 🟡 Amber (improving but still off)
//   stable → 🔴 Red when chronically off-target (any 'bad' marker),
//            🟡 Amber when borderline, ✅ Green when at target
//   single → first reading, no trend yet → fall back to absolute targets
//   partial→ no readings at all → 🟡 Amber + "no reports" banner
//
// `outcome` is also returned so the card can render a Worse/Mixed/Better
// chip that explains *why* the patient is in this bucket.
function triageTier(appt) {
  const bio = readBio(appt);
  const present = TIER_KEYS.filter((k) => bio[k] != null);
  if (present.length === 0) return { tier: "amber", noReports: true, outcome: "partial" };

  let hasBad = false;
  let hasWarn = false;
  for (const k of present) {
    const s = targetStatus(k, bio[k]);
    if (s === "bad") hasBad = true;
    else if (s === "warn") hasWarn = true;
  }

  const outcome = computeOutcome(appt);
  const isNew =
    (appt.visit_type || "").toLowerCase().includes("new") ||
    (appt.visit_count != null && Number(appt.visit_count) <= 1);

  // Trend-first decision (give more weight to live-dashboard logic).
  if (outcome === "worse") return { tier: "red", noReports: false, outcome };
  if (outcome === "mixed") return { tier: "amber", noReports: false, outcome };

  if (outcome === "better") {
    // Improving but still in 'bad' zone → flag for review, not green yet.
    if (hasBad) return { tier: "amber", noReports: false, outcome };
    return { tier: "green", noReports: false, outcome };
  }

  if (outcome === "stable") {
    // Stuck off-target despite stable trend = senior physician territory.
    if (hasBad) return { tier: "red", noReports: false, outcome };
    if (hasWarn) return { tier: "amber", noReports: false, outcome };
    return { tier: "green", noReports: false, outcome };
  }

  // single / partial — no trend, use absolute targets.
  if (hasBad) return { tier: "red", noReports: false, outcome };
  if (isNew && bio.hba1c != null && bio.hba1c > 9)
    return { tier: "red", noReports: false, outcome };
  if (hasWarn) return { tier: "amber", noReports: false, outcome };
  return { tier: "green", noReports: false, outcome };
}

// ── presentational primitives ──
function ParamChip({ label, value, status }) {
  if (value == null) return null;
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
      {label} <b>{value}</b>
    </span>
  );
}

function bioChips(appt) {
  const bio = readBio(appt);
  const out = [];
  for (const k of TIER_KEYS) {
    if (bio[k] == null) continue;
    if (k === "dbp") continue;
    let valueText = `${bio[k]}`;
    if (k === "sbp" && bio.dbp != null) valueText = `${bio.sbp}/${bio.dbp}`;
    out.push({
      key: k,
      label: KEY_LABEL[k],
      value: valueText,
      status: targetStatus(k, bio[k]),
    });
  }
  return out;
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

function Stat({ val, label, valColor, bg, labelColor, compact }) {
  return (
    <div
      style={{
        background: bg || WH,
        border: `1px solid ${BD}`,
        borderRadius: 10,
        padding: compact ? "10px 11px" : "14px 14px",
        boxShadow: SH,
      }}
    >
      <div
        style={{
          fontFamily: FM,
          fontSize: compact ? 20 : 26,
          fontWeight: 500,
          color: valColor || INK,
          lineHeight: 1,
        }}
      >
        {val}
      </div>
      <div
        style={{
          fontSize: compact ? 9 : 10,
          color: labelColor || INK3,
          fontWeight: 600,
          marginTop: 5,
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

function metaText(appt) {
  const parts = [];
  if (appt.age != null && appt.age !== "")
    parts.push(`${appt.age}${appt.sex ? appt.sex[0]?.toUpperCase() : ""}`);
  if (appt.file_no) parts.push(appt.file_no);
  else if (appt.patient_id) parts.push(`P_${appt.patient_id}`);
  if (appt.visit_count) parts.push(`Visit ${appt.visit_count}`);
  else if ((appt.visit_type || "").toLowerCase().includes("new")) parts.push("New patient");
  return parts.join(" · ");
}

// ── Date picker (mirrors LiveDashboard) ──
function DatePicker({ date, onDateChange, isMobile }) {
  const todayIso = toLocalIso(new Date());
  const isToday = !date || date === todayIso;
  const displayDate = date ? new Date(date + "T00:00:00") : new Date();
  const [calOpen, setCalOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!calOpen) return;
    const onDoc = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setCalOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [calOpen]);

  const niceDate = displayDate.toLocaleDateString(undefined, {
    weekday: isMobile ? undefined : "short",
    day: "numeric",
    month: "short",
    year: isMobile ? undefined : "numeric",
  });

  // Mirrors the dashboard header date control exactly:
  //   ‹  📅 <date>  ›    (in a thin bordered pill)
  // The "Today" affordance is rendered as a separate button alongside.
  return (
    <div
      ref={wrapRef}
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
          whiteSpace: "nowrap",
        }}
      >
        📅 {niceDate}
      </button>
      <button
        type="button"
        onClick={() => {
          const d = new Date(displayDate);
          d.setDate(d.getDate() + 1);
          onDateChange(toLocalIso(d));
        }}
        title="Next day"
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
        ›
      </button>
      {calOpen && (
        <CustomCalendar
          value={date || todayIso}
          onSelect={(v) => onDateChange(v)}
          onClose={() => setCalOpen(false)}
        />
      )}
    </div>
  );
}

// "Today" pill button — always rendered, faded when already on today, so the
// neighbouring controls don't shift on date change.
function TodayButton({ isToday, onClick }) {
  return (
    <button
      type="button"
      onClick={() => !isToday && onClick()}
      disabled={isToday}
      aria-disabled={isToday}
      title={isToday ? "Already on today" : "Jump to today"}
      style={{
        background: TL,
        border: `1px solid ${TB}`,
        color: T,
        borderRadius: 6,
        padding: "5px 11px",
        fontSize: 11,
        fontWeight: 600,
        cursor: isToday ? "default" : "pointer",
        opacity: isToday ? 0.45 : 1,
        fontFamily: FB,
        whiteSpace: "nowrap",
        transition: "opacity .15s",
      }}
    >
      Today
    </button>
  );
}

// ── View toggle (By Category / By Assignment) ──
// Same visual idiom as the date pill: thin bordered container with two
// segments separated by a hairline divider. Active segment uses the brand
// teal background; inactive segments stay transparent.
function ViewToggle({ value, onChange }) {
  const opts = [
    { id: "category", label: "Category" },
    { id: "assign", label: "Assignment" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Triage view"
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: WH,
        border: `1px solid ${BD}`,
        borderRadius: 6,
        padding: 2,
      }}
    >
      {opts.map((o, i) => {
        const active = value === o.id;
        return (
          <button
            key={o.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.id)}
            style={{
              padding: "4px 11px",
              fontSize: 11,
              fontWeight: active ? 700 : 600,
              cursor: active ? "default" : "pointer",
              border: "none",
              borderRadius: 4,
              background: active ? T : "transparent",
              color: active ? WH : INK2,
              fontFamily: FB,
              transition: "all .12s",
              whiteSpace: "nowrap",
              marginLeft: i === 0 ? 0 : 2,
            }}
            onMouseEnter={(e) => {
              if (!active) e.currentTarget.style.background = TL;
            }}
            onMouseLeave={(e) => {
              if (!active) e.currentTarget.style.background = "transparent";
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Assignment modal ──
function AssignDoctorModal({ appt, doctors, allAppts, currentDoctor, onClose, onConfirm }) {
  const [picked, setPicked] = useState(currentDoctor || "");
  const loadByName = useMemo(() => {
    const m = new Map();
    for (const a of allAppts) {
      if (!a.doctor_name) continue;
      m.set(a.doctor_name, (m.get(a.doctor_name) || 0) + 1);
    }
    return m;
  }, [allAppts]);
  const total = Math.max(1, allAppts.length);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(14,34,64,.45)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 14,
        fontFamily: FB,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: WH,
          borderRadius: 12,
          width: 460,
          maxWidth: "100%",
          maxHeight: "90vh",
          boxShadow: "0 12px 40px rgba(14,34,64,.25)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          style={{
            padding: "14px 18px",
            borderBottom: `1px solid ${BD}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: FD, fontSize: 18, color: INK }}>
              {currentDoctor ? "Reassign doctor" : "Assign doctor"}
            </div>
            <div
              style={{
                fontSize: 11,
                color: INK3,
                marginTop: 2,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {appt.patient_name} · choose a doctor
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              fontSize: 22,
              color: INK3,
              cursor: "pointer",
              padding: 4,
              lineHeight: 1,
              flexShrink: 0,
            }}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div style={{ padding: 14, overflowY: "auto", flex: 1 }}>
          {doctors.length === 0 && (
            <div style={{ fontSize: 12, color: INK3, padding: 18, textAlign: "center" }}>
              No doctors available.
            </div>
          )}
          {doctors.map((d) => {
            const load = loadByName.get(d.name) || 0;
            const pct = Math.min(100, Math.round((load / total) * 100));
            const selected = picked === d.name;
            return (
              <div
                key={d.id || d.name}
                onClick={() => setPicked(d.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 12px",
                  borderRadius: 8,
                  border: `1px solid ${selected ? T : BD}`,
                  background: selected ? TL : WH,
                  marginBottom: 6,
                  cursor: "pointer",
                  transition: "all .12s",
                }}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: selected ? T : BG,
                    color: selected ? WH : INK2,
                    fontSize: 11,
                    fontWeight: 700,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  {(d.short_name || d.name || "?")
                    .replace(/^Dr\.?\s*/i, "")
                    .substring(0, 2)
                    .toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: INK,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {d.name}
                  </div>
                  <div style={{ fontSize: 10, color: INK3, marginTop: 1 }}>
                    {load} patient{load === 1 ? "" : "s"} today
                    {d.role ? ` · ${d.role}` : ""}
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: BD,
                      borderRadius: 3,
                      marginTop: 5,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${pct}%`,
                        background: T,
                        borderRadius: 3,
                        transition: "width .4s",
                      }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: "12px 14px",
            borderTop: `1px solid ${BD}`,
            display: "flex",
            gap: 8,
            background: BG,
          }}
        >
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: "9px 12px",
              borderRadius: 7,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              border: `1px solid ${BD}`,
              background: WH,
              color: INK2,
              fontFamily: FB,
            }}
          >
            Cancel
          </button>
          <button
            disabled={!picked || picked === currentDoctor}
            onClick={() => onConfirm(picked)}
            style={{
              flex: 1,
              padding: "9px 12px",
              borderRadius: 7,
              fontSize: 12,
              fontWeight: 700,
              cursor: !picked || picked === currentDoctor ? "not-allowed" : "pointer",
              border: `1px solid ${T}`,
              background: !picked || picked === currentDoctor ? "#9ed4cd" : T,
              color: WH,
              fontFamily: FB,
            }}
          >
            {currentDoctor ? "Confirm reassignment" : "Confirm assignment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Patient row ──
// Trend chip — small badge that explains *why* the patient is in this tier
// (matches the Live Dashboard's outcome buckets).
const OUTCOME_CHIP = {
  worse: { label: "↑ Worse", fg: RE, bg: REL },
  mixed: { label: "⚠ Mixed", fg: AM, bg: AML },
  better: { label: "↓ Better", fg: GN, bg: GNL },
  stable: { label: "→ Stable", fg: INK2, bg: BG },
  single: { label: "★ First", fg: SK, bg: SKL },
  partial: { label: "★ First", fg: SK, bg: SKL },
};

function PatientRow({ appt, tier, noReports, onAssign, onOpen }) {
  const chips = bioChips(appt);
  const assigned = !!appt.doctor_name;
  const tierColor = tier === "red" ? RE : tier === "amber" ? AM : GN;
  const tierBg = tier === "red" ? REL : tier === "amber" ? AML : GNL;
  const tierLabel = tier === "red" ? "🔴 Red" : tier === "amber" ? "🟡 Amber" : "✅ Green";
  const outcomeChip = OUTCOME_CHIP[appt.__outcome] || null;
  const status = appt.status || "pending";
  const ss = statusOf(status);
  // Dim cards that are out of the active workflow (mirrors OPD.jsx:436).
  const cardOpacity =
    status === "seen" || status === "completed"
      ? 0.65
      : status === "in_visit"
        ? 0.9
        : status === "no_show" || status === "cancelled"
          ? 0.55
          : 1;

  return (
    <div
      className="ld-row"
      onClick={() => onOpen && onOpen(appt)}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px",
        borderTop: `1px solid ${BD}`,
        borderLeft: `3px solid ${tierColor}`,
        background: WH,
        opacity: cardOpacity,
        transition: "opacity .15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              color: INK,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {appt.patient_name || "Unnamed"}
          </div>
          <div style={{ fontSize: 10, color: INK3, marginTop: 1 }}>{metaText(appt)}</div>
        </div>
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-end",
            gap: 4,
          }}
        >
          {appt.time_slot && (
            <div style={{ fontFamily: FM, fontSize: 11, fontWeight: 500, color: INK2 }}>
              {appt.time_slot}
            </div>
          )}
          <div
            style={{
              display: "flex",
              gap: 4,
              alignItems: "center",
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            <span
              title={`Appointment status: ${ss.label}`}
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 7px",
                borderRadius: 10,
                background: ss.bg,
                color: ss.fg,
                border: `1px solid ${ss.fg}33`,
                whiteSpace: "nowrap",
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <span
                className={ss.pulse ? "ld-dot" : undefined}
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: "50%",
                  background: ss.fg,
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              {ss.label}
            </span>
            {outcomeChip && (
              <span
                title="Trend vs previous visit"
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "1px 6px",
                  borderRadius: 10,
                  background: outcomeChip.bg,
                  color: outcomeChip.fg,
                  border: `1px solid ${outcomeChip.fg}33`,
                  whiteSpace: "nowrap",
                  fontFamily: FM,
                }}
              >
                {outcomeChip.label}
              </span>
            )}
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: "1px 7px",
                borderRadius: 10,
                background: tierBg,
                color: tierColor,
                border: `1px solid ${tierColor}33`,
                whiteSpace: "nowrap",
              }}
            >
              {tierLabel}
            </span>
          </div>
        </div>
      </div>

      {noReports && (
        <div
          style={{
            background: REL,
            border: `1px solid ${RE}22`,
            borderRadius: 6,
            padding: "4px 8px",
            fontSize: 10,
            fontWeight: 600,
            color: RE,
          }}
        >
          ⚠ No recent reports — route to SD first for test prescription
        </div>
      )}

      {chips.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {chips.map((c) => (
            <ParamChip key={c.key} label={c.label} value={c.value} status={c.status} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            padding: "2px 8px",
            borderRadius: 10,
            background: assigned ? GNL : AML,
            color: assigned ? GN : AM,
            border: `1px solid ${assigned ? GN : AM}22`,
            whiteSpace: "nowrap",
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={assigned ? appt.doctor_name : "Unassigned"}
        >
          {assigned ? `→ ${appt.doctor_name}` : "⏳ Unassigned"}
        </span>
        <div style={{ display: "flex", gap: 5, marginLeft: "auto" }}>
          {/* Hide Assign/Reassign for terminal statuses — visit is over,
              changing the doctor no longer makes sense. */}
          {!["seen", "completed", "no_show", "cancelled"].includes(status) && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onAssign(appt);
              }}
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "4px 10px",
                borderRadius: 5,
                border: `1px solid ${assigned ? TB : T}`,
                background: assigned ? WH : T,
                color: assigned ? T : WH,
                cursor: "pointer",
                fontFamily: FB,
                transition: "all .12s",
              }}
            >
              {assigned ? "↺ Reassign" : "+ Assign"}
            </button>
          )}
          {onOpen && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onOpen(appt);
              }}
              style={{
                fontSize: 10,
                fontWeight: 600,
                padding: "4px 10px",
                borderRadius: 5,
                border: `1px solid ${BD}`,
                background: WH,
                color: INK2,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              ↗ Open
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Column ──
function TriageColumn({ tier, title, hint, items, onAssign, onOpen }) {
  const accent = tier === "red" ? RE : tier === "amber" ? AM : GN;
  const accentBg = tier === "red" ? REL : tier === "amber" ? AML : GNL;
  const icon = tier === "red" ? "🔴" : tier === "amber" ? "🟡" : "✅";
  return (
    <Card style={{ padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 3, background: accent }} />
      <div style={{ padding: "12px 14px 6px" }}>
        <SectionTitle
          right={
            <span
              style={{
                fontFamily: FM,
                fontSize: 12,
                fontWeight: 600,
                color: accent,
                background: accentBg,
                padding: "1px 9px",
                borderRadius: 11,
                border: `1px solid ${accent}33`,
              }}
            >
              {items.length}
            </span>
          }
        >
          <span style={{ marginRight: 5 }}>{icon}</span>
          {title}
        </SectionTitle>
        {hint && (
          <div style={{ fontSize: 10.5, color: INK3, marginTop: -4, marginBottom: 8 }}>{hint}</div>
        )}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {items.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              fontSize: 11,
              color: INK3,
              fontStyle: "italic",
              borderTop: `1px solid ${BD}`,
            }}
          >
            No patients
          </div>
        ) : (
          items.map((a) => (
            <PatientRow
              key={a.id}
              appt={a}
              tier={tier}
              noReports={a.__noReports}
              onAssign={onAssign}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </Card>
  );
}

// ── Assignment column (used in "By assignment" view) ──
function AssignColumn({ accent, title, hint, items, onAssign, onOpen, getTier }) {
  return (
    <Card style={{ padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ height: 3, background: accent }} />
      <div style={{ padding: "12px 14px 6px" }}>
        <SectionTitle
          right={
            <span
              style={{
                fontFamily: FM,
                fontSize: 12,
                fontWeight: 600,
                color: accent,
                padding: "1px 9px",
                borderRadius: 11,
                border: `1px solid ${accent}33`,
                background: `${accent}11`,
              }}
            >
              {items.length}
            </span>
          }
        >
          {title}
        </SectionTitle>
        {hint && (
          <div style={{ fontSize: 10.5, color: INK3, marginTop: -4, marginBottom: 8 }}>{hint}</div>
        )}
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        {items.length === 0 ? (
          <div
            style={{
              padding: "24px 16px",
              textAlign: "center",
              fontSize: 11,
              color: INK3,
              fontStyle: "italic",
              borderTop: `1px solid ${BD}`,
            }}
          >
            None
          </div>
        ) : (
          items.map((a) => (
            <PatientRow
              key={a.id}
              appt={a}
              tier={getTier(a)}
              noReports={a.__noReports}
              onAssign={onAssign}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </Card>
  );
}

// ── Main view ──
export default function TriageView({
  appointments = [],
  doctors = [],
  date,
  onDateChange,
  onRefresh,
  isFetching,
  isPending,
  updatedAt,
  onUpdateAppt,
  onSelectAppt,
}) {
  const [modalAppt, setModalAppt] = useState(null);
  const [view, setView] = useState("category"); // "category" | "assign"
  const [query, setQuery] = useState("");
  const isMobile = useIsMobile(); // < 768
  const isSmall = useIsMobile(480);

  const sortByTime = (a, b) =>
    (a.time_slot || "").toString().localeCompare((b.time_slot || "").toString());

  const tierByApptId = useMemo(() => {
    const m = new Map();
    for (const a of appointments) m.set(a.id, triageTier(a));
    return m;
  }, [appointments]);

  const filteredAppointments = useMemo(() => {
    const q = (query || "").trim().toLowerCase();
    if (!q) return appointments;
    const fuzzy = (text) => {
      const t = (text || "").toLowerCase();
      if (!t) return false;
      if (t.includes(q)) return true;
      let i = 0;
      for (let j = 0; j < t.length && i < q.length; j++) {
        if (t[j] === q[i]) i++;
      }
      return i === q.length;
    };
    return appointments.filter((a) => {
      const name = a.patient_name || "";
      const fileNo = a.file_no || (a.patient_id ? `P_${a.patient_id}` : "");
      return fuzzy(name) || fuzzy(fileNo);
    });
  }, [appointments, query]);

  const { red, amber, green, assignedItems, unassignedItems, counts } = useMemo(() => {
    const r = [];
    const am = [];
    const g = [];
    const ai = [];
    const ui = [];
    for (const a of filteredAppointments) {
      const t = tierByApptId.get(a.id) || { tier: "amber", noReports: false, outcome: "partial" };
      const enriched = { ...a, __noReports: t.noReports, __outcome: t.outcome };
      if (t.tier === "red") r.push(enriched);
      else if (t.tier === "amber") am.push(enriched);
      else g.push(enriched);
      if (a.doctor_name) ai.push(enriched);
      else ui.push(enriched);
    }
    const tierRank = (a) => {
      const s = a.status || "pending";
      if (s === "cancelled") return 4;
      if (s === "no_show") return 3;
      if (s === "seen" || s === "completed") return 2;
      if (a.doctor_name) return 1;
      return 0;
    };
    [r, am, g].forEach((arr) =>
      arr.sort((a, b) => {
        const ra = tierRank(a);
        const rb = tierRank(b);
        if (ra !== rb) return ra - rb;
        return sortByTime(a, b);
      }),
    );
    const unassignedRank = (a) => {
      const s = a.status || "pending";
      if (s === "no_show" || s === "cancelled") return 1;
      return 0;
    };
    ui.sort((a, b) => {
      const ra = unassignedRank(a);
      const rb = unassignedRank(b);
      if (ra !== rb) return ra - rb;
      return sortByTime(a, b);
    });
    const assignedRank = (a) => {
      const s = a.status || "pending";
      if (s === "in_visit") return 0;
      if (s === "checkedin") return 1;
      if (s === "pending") return 2;
      if (s === "seen" || s === "completed") return 3;
      if (s === "no_show" || s === "cancelled") return 4;
      return 5;
    };
    ai.sort((a, b) => {
      const ra = assignedRank(a);
      const rb = assignedRank(b);
      if (ra !== rb) return ra - rb;
      return sortByTime(a, b);
    });
    const noReports = filteredAppointments.filter((a) => tierByApptId.get(a.id)?.noReports).length;
    const byStatus = (s) =>
      filteredAppointments.filter((a) => (a.status || "pending") === s).length;
    const checkedIn = byStatus("checkedin");
    const inVisit = byStatus("in_visit");
    const seen = byStatus("seen") + byStatus("completed");
    const noShow = byStatus("no_show") + byStatus("cancelled");
    return {
      red: r,
      amber: am,
      green: g,
      assignedItems: ai,
      unassignedItems: ui,
      counts: {
        total: filteredAppointments.length,
        red: r.length,
        amber: am.length,
        green: g.length,
        assigned: ai.length,
        unassigned: ui.length,
        noReports,
        checkedIn,
        inVisit,
        seen,
        noShow,
      },
    };
  }, [filteredAppointments, appointments, tierByApptId]);

  const handleConfirm = (doctor_name) => {
    if (!modalAppt) return;
    Promise.resolve(onUpdateAppt(modalAppt.id, { doctor_name })).finally(() => setModalAppt(null));
  };

  const todayIso = toLocalIso(new Date());
  const isToday = !date || date === todayIso;
  const niceDate = (() => {
    if (!date) return "";
    const d = new Date(date + "T00:00:00");
    if (isNaN(d.getTime())) return date;
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  })();

  // Responsive grids
  const statGrid = isSmall
    ? "1fr 1fr"
    : isMobile
      ? "1fr 1fr 1fr"
      : "repeat(auto-fit,minmax(140px,1fr))";
  const colGrid = isMobile ? "1fr" : "repeat(auto-fit,minmax(300px,1fr))";

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
        background: BG,
        minHeight: 0,
      }}
    >
      {/* Header — single row, mirrors /opd?tab=dashboard */}
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
          <div style={{ fontFamily: FD, fontSize: isMobile ? 19 : 22, color: INK }}>
            {isToday ? "Today's Patient Triage" : "Patient Triage"}
          </div>
          <div style={{ fontSize: 11, color: INK3 }}>
            {niceDate} · {counts.total} patient{counts.total === 1 ? "" : "s"}
            {!isMobile && " · grouped by trend vs last visit"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          {(() => {
            const isFuture = !isToday && (date || todayIso) > todayIso;
            const tone = isToday
              ? { fg: GN, bg: GNL }
              : isFuture
                ? { fg: SK, bg: SKL }
                : { fg: AM, bg: AML };
            const label = isToday
              ? `Live · Updated ${fmtTime(updatedAt)}`
              : isFuture
                ? "Upcoming view"
                : "Historical view";
            return (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  background: tone.bg,
                  border: `1px solid ${tone.fg}22`,
                  borderRadius: 16,
                  padding: "4px 11px",
                  fontSize: 11,
                  color: tone.fg,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                <span
                  className="ld-dot"
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: tone.fg,
                    display: "inline-block",
                    opacity: isFetching ? 1 : 0.85,
                  }}
                />
                {label}
              </div>
            );
          })()}
          {onDateChange && <TodayButton isToday={isToday} onClick={() => onDateChange(todayIso)} />}
          {onDateChange && (
            <DatePicker date={date} onDateChange={onDateChange} isMobile={isMobile} />
          )}
          <ViewToggle value={view} onChange={setView} />
          <div style={{ position: "relative", display: "inline-block" }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or file no…"
              style={{
                background: WH,
                border: `1px solid ${BD}`,
                color: INK,
                borderRadius: 6,
                padding: "5px 26px 5px 9px",
                fontSize: 11,
                fontWeight: 500,
                fontFamily: FB,
                outline: "none",
                width: isMobile ? 140 : 200,
              }}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                title="Clear"
                style={{
                  position: "absolute",
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "transparent",
                  border: "none",
                  color: INK3,
                  cursor: "pointer",
                  fontSize: 12,
                  lineHeight: 1,
                  padding: "2px 5px",
                }}
              >
                ×
              </button>
            )}
          </div>
          {onRefresh && (
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
                whiteSpace: "nowrap",
              }}
            >
              {isFetching ? "… refreshing" : "⟳ Refresh"}
            </button>
          )}
        </div>
      </div>

      {isPending ? (
        <>
          {/* Stat skeleton */}
          <div style={{ display: "grid", gridTemplateColumns: statGrid, gap: 10 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} style={{ padding: isMobile ? "10px 11px" : "14px 14px" }}>
                <Shim w="55%" h={isMobile ? 20 : 24} r={4} />
                <div style={{ height: 8 }} />
                <Shim w="80%" h={9} r={3} />
              </Card>
            ))}
          </div>

          {/* Columns skeleton — match the active view shape */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: view === "assign" ? (isMobile ? "1fr" : "1fr 1fr") : colGrid,
              gap: 10,
              alignItems: "start",
            }}
          >
            {Array.from({ length: view === "assign" ? 2 : 3 }).map((_, c) => (
              <Card
                key={c}
                style={{
                  padding: 0,
                  display: "flex",
                  flexDirection: "column",
                  overflow: "hidden",
                }}
              >
                <div style={{ height: 3, background: BD }} />
                <div style={{ padding: "12px 14px 10px" }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <Shim w="55%" h={11} r={3} />
                    <Shim w={32} h={16} r={11} />
                  </div>
                  <Shim w="40%" h={9} r={3} />
                </div>
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "10px 12px",
                      borderTop: `1px solid ${BD}`,
                      borderLeft: `3px solid ${BD}`,
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 10,
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Shim w="70%" h={13} r={3} />
                        <div style={{ height: 5 }} />
                        <Shim w="50%" h={9} r={3} />
                      </div>
                      <div
                        style={{
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "flex-end",
                          gap: 5,
                        }}
                      >
                        <Shim w={42} h={11} r={3} />
                        <Shim w={50} h={14} r={10} />
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                      <Shim w={56} h={14} r={8} />
                      <Shim w={64} h={14} r={8} />
                      <Shim w={48} h={14} r={8} />
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        flexWrap: "wrap",
                      }}
                    >
                      <Shim w={110} h={16} r={10} />
                      <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
                        <Shim w={68} h={20} r={5} />
                        <Shim w={56} h={20} r={5} />
                      </div>
                    </div>
                  </div>
                ))}
              </Card>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Stat row */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: statGrid,
              gap: 10,
            }}
          >
            <Stat compact={isMobile} val={counts.total} label="Total" />
            <Stat
              compact={isMobile}
              val={counts.red}
              label="🔴 Getting worse"
              valColor={counts.red ? RE : INK3}
              bg={counts.red ? REL : WH}
              labelColor={counts.red ? RE : INK3}
            />
            <Stat
              compact={isMobile}
              val={counts.amber}
              label="🟡 Flag for review"
              valColor={counts.amber ? AM : INK3}
              bg={counts.amber ? AML : WH}
              labelColor={counts.amber ? AM : INK3}
            />
            <Stat
              compact={isMobile}
              val={counts.green}
              label="✅ Stable / Better"
              valColor={counts.green ? GN : INK3}
              bg={counts.green ? GNL : WH}
              labelColor={counts.green ? GN : INK3}
            />
            <Stat
              compact={isMobile}
              val={counts.assigned}
              label="Assigned"
              valColor={counts.assigned ? GN : INK3}
            />
            <Stat
              compact={isMobile}
              val={counts.unassigned}
              label="Unassigned"
              valColor={counts.unassigned ? AM : INK3}
            />
          </div>

          {/* Workflow row — live appointment status counts (mirrors /opd top bar). */}
          {!isSmall && counts.total > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile
                  ? "1fr 1fr 1fr 1fr"
                  : "repeat(auto-fit,minmax(140px,1fr))",
                gap: 10,
              }}
            >
              <Stat
                compact={isMobile}
                val={counts.checkedIn}
                label="🔵 Checked In"
                valColor={counts.checkedIn ? SK : INK3}
                bg={counts.checkedIn ? SKL : WH}
                labelColor={counts.checkedIn ? SK : INK3}
              />
              <Stat
                compact={isMobile}
                val={counts.inVisit}
                label="🟣 In Visit"
                valColor={counts.inVisit ? LV : INK3}
                bg={counts.inVisit ? LVL : WH}
                labelColor={counts.inVisit ? LV : INK3}
              />
              <Stat
                compact={isMobile}
                val={counts.seen}
                label="✅ Seen"
                valColor={counts.seen ? GN : INK3}
                bg={counts.seen ? GNL : WH}
                labelColor={counts.seen ? GN : INK3}
              />
              <Stat
                compact={isMobile}
                val={counts.noShow}
                label="◌ No-show / Cancel"
                valColor={INK3}
              />
            </div>
          )}

          {/* Body */}
          {view === "category" ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: colGrid,
                gap: 10,
                alignItems: "start",
              }}
            >
              <TriageColumn
                tier="red"
                title="Getting worse"
                hint="Tier-1 deteriorating or chronically off-target · expert help"
                items={red}
                onAssign={(a) => setModalAppt(a)}
                onOpen={onSelectAppt}
              />
              <TriageColumn
                tier="amber"
                title="Flag for review"
                hint="Mixed signals or borderline · SD validates"
                items={amber}
                onAssign={(a) => setModalAppt(a)}
                onOpen={onSelectAppt}
              />
              <TriageColumn
                tier="green"
                title="Stable & improving"
                hint="At target or trending better · SD closes"
                items={green}
                onAssign={(a) => setModalAppt(a)}
                onOpen={onSelectAppt}
              />
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                gap: 10,
                alignItems: "start",
              }}
            >
              <AssignColumn
                accent={GN}
                title={`✓ Assigned (${assignedItems.length})`}
                hint="Ready for OPD · click ↺ to reassign"
                items={assignedItems}
                onAssign={(a) => setModalAppt(a)}
                onOpen={onSelectAppt}
                getTier={(a) => tierByApptId.get(a.id)?.tier || "amber"}
              />
              <AssignColumn
                accent={AM}
                title={`⏳ Not yet assigned (${unassignedItems.length})`}
                hint="Action needed before OPD"
                items={unassignedItems}
                onAssign={(a) => setModalAppt(a)}
                onOpen={onSelectAppt}
                getTier={(a) => tierByApptId.get(a.id)?.tier || "amber"}
              />
            </div>
          )}

          {appointments.length === 0 && (
            <Card>
              <div
                style={{
                  padding: "16px 4px",
                  textAlign: "center",
                  fontSize: 12,
                  color: INK3,
                }}
              >
                No appointments for {niceDate}. Add appointments from the Schedule tab.
              </div>
            </Card>
          )}
        </>
      )}

      {modalAppt && (
        <AssignDoctorModal
          appt={modalAppt}
          doctors={doctors}
          allAppts={appointments}
          currentDoctor={modalAppt.doctor_name || ""}
          onClose={() => setModalAppt(null)}
          onConfirm={handleConfirm}
        />
      )}
    </div>
  );
}
