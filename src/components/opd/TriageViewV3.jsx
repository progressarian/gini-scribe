import React, { useEffect, useMemo, useRef, useState } from "react";
import api from "../../services/api";
import { toast } from "../../stores/uiStore";
import { targetStatus, BIO_TIER } from "../../utils/biomarkerClassify.js";
import { triageTier } from "./TriageView.jsx";
import { useIsMobile } from "../../hooks/useIsMobile.js";

// ── Design tokens ──
const T = "#009e8c";
const TL = "#e6f6f4";
const TB = "rgba(0,158,140,.22)";
const NV = "#0e2240";
const BG = "#f0f4f7";
const WH = "#fff";
const INK = "#1a2332";
const INK2 = "#3d4f63";
const INK3 = "#6b7d90";
const INK4 = "#8fa0b0";
const BD = "#dde3ea";
const RE = "#b91c1c";
const REL = "#fef2f2";
const AM = "#b45309";
const AML = "#fffbeb";
const GN = "#166534";
const GNL = "#f0fdf4";
const MG = "#15803d";
const SK = "#1d4ed8";
const SKL = "#eff6ff";
const LV = "#6d28d9";
const LVL = "#f5f3ff";
const SH = "0 1px 3px rgba(0,0,0,.07)";

const FB = "'Inter',system-ui,sans-serif";
const FD = "'Instrument Serif',serif";
const FM = "'DM Mono',monospace";

// Shimmer keyframes — shared id with TriageView so we only inject once even
// when both pages are mounted in a session.
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
@keyframes ldPulse {
  0%   { transform: scale(1);   opacity: 1; }
  70%  { transform: scale(2.4); opacity: 0; }
  100% { transform: scale(2.4); opacity: 0; }
}
.ld-dot::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: currentColor;
  animation: ldPulse 1.8s ease-out infinite;
}
.ld-dot { position: relative; }
@keyframes triUploadSpin { to { transform: rotate(360deg); } }
`;
  document.head.appendChild(s);
}

function Shim({ w = "100%", h = 12, r = 6, style }) {
  return <div className="tri-shim" style={{ width: w, height: h, borderRadius: r, ...style }} />;
}

function SkeletonCard() {
  return (
    <div
      style={{
        background: WH,
        border: `1px solid ${BD}`,
        borderLeft: `3px solid ${BD}`,
        borderRadius: 9,
        padding: "10px 11px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Shim w="65%" h={12} r={3} />
          <div style={{ height: 5 }} />
          <Shim w="40%" h={9} r={3} />
        </div>
        <Shim w={42} h={11} r={3} />
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <Shim w={70} h={14} r={5} />
        <Shim w={50} h={14} r={5} />
      </div>
      <Shim w="100%" h={22} r={7} />
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        <Shim w={64} h={18} r={6} />
        <Shim w={58} h={18} r={6} />
        <Shim w={70} h={18} r={6} />
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <Shim w={34} h={10} r={3} />
        <Shim w="60%" h={5} r={3} />
      </div>
      <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <Shim w={110} h={16} r={10} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 5 }}>
          <Shim w={60} h={20} r={5} />
          <Shim w={56} h={20} r={5} />
        </div>
      </div>
    </div>
  );
}

function SkeletonPipelinePill() {
  return (
    <div
      style={{
        flex: 1,
        minWidth: 110,
        padding: "8px 10px",
        textAlign: "center",
        background: WH,
        border: `1px solid ${BD}`,
        borderRadius: 9,
      }}
    >
      <Shim w="40%" h={20} r={4} style={{ margin: "0 auto" }} />
      <div style={{ height: 6 }} />
      <Shim w="65%" h={9} r={3} style={{ margin: "0 auto" }} />
      <div style={{ height: 4 }} />
      <Shim w="80%" h={8} r={3} style={{ margin: "0 auto" }} />
    </div>
  );
}

function SkeletonColumn({ accent }) {
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 260,
        display: "flex",
        flexDirection: "column",
        borderRadius: 11,
        overflow: "hidden",
        border: `1.5px solid ${accent}33`,
        background: WH,
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          background: accent,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div style={{ flex: 1 }}>
          <Shim w="55%" h={11} r={3} style={{ background: "rgba(255,255,255,.35)" }} />
          <div style={{ height: 6 }} />
          <Shim w="35%" h={8} r={3} style={{ background: "rgba(255,255,255,.25)" }} />
        </div>
        <Shim w={26} h={18} r={5} style={{ background: "rgba(255,255,255,.35)" }} />
      </div>
      <div
        style={{
          padding: 6,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          background: "rgba(255,255,255,.55)",
        }}
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

const KEY_LABEL = {
  hba1c: "HbA1c",
  sbp: "BP",
  dbp: "DBP",
  fg: "FBS",
  ppbs: "PPBS",
  ldl: "LDL",
  hdl: "HDL",
  tg: "TG",
  total_chol: "Total Chol",
  uacr: "UACR",
  egfr: "eGFR",
  creatinine: "Creatinine",
  tsh: "TSH",
  hb: "Hb",
  wbc: "WBC",
  alt: "ALT",
  ast: "AST",
  weight: "Weight",
  bmi: "BMI",
};

// Panels we expect on a "full" lab work-up. Used to render the missing-panel banner.
const REQUIRED_PANELS = [
  { name: "HbA1c", keys: ["hba1c"] },
  { name: "FBS", keys: ["fg", "fbs"] },
  { name: "Lipid", keys: ["ldl", "tg", "hdl", "total_chol"] },
  { name: "Renal", keys: ["egfr", "creatinine"] },
  { name: "UACR", keys: ["uacr", "acr"] },
];

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

const num = (v) => {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};

const bioOf = (appt) => appt.biomarkers || {};
const prevOf = (appt) => appt.prev_biomarkers || {};

function hasAnyTier1Biomarker(appt) {
  const b = bioOf(appt);
  return Object.keys(BIO_TIER).some(
    (k) => (BIO_TIER[k] === 1 || BIO_TIER[k] === 2) && num(b[k]) != null,
  );
}

// 5-bucket triage classifier.
//   no_reports     → triageTier flagged noReports
//   worse_out      → currently off-target on a Tier-1 marker
//   worse_in       → trend worsening but still in range / mixed signals
//   getting_better → improving but not at all targets yet
//   in_control     → all Tier-1 markers at target
function triageTierV3(appt) {
  const t1 = triageTier(appt);
  if (t1.noReports) return "no_reports";
  const b = bioOf(appt);
  const tier1Keys = Object.keys(BIO_TIER).filter((k) => BIO_TIER[k] === 1);
  const present1 = tier1Keys.filter((k) => num(b[k]) != null);
  const anyBad = present1.some((k) => targetStatus(k, num(b[k])) === "bad");
  const allAtTarget =
    present1.length > 0 && present1.every((k) => targetStatus(k, num(b[k])) === "ok");

  if (t1.tier === "red" && anyBad) return "worse_out";
  if (t1.tier === "red") return "worse_in";
  if (t1.tier === "amber") return "worse_in";
  if (t1.tier === "green" && allAtTarget) return "in_control";
  if (t1.tier === "green" && t1.outcome === "better") return "getting_better";
  if (t1.tier === "green") return "in_control";
  return "worse_in";
}

// Build a one-line plain-English explanation of why this appointment sits
// in the bucket it does. Used by the card's "Why" line so coordinators can
// audit the triage decision at a glance.
function bucketReason(appt, bucket) {
  const b = bioOf(appt);
  const p = prevOf(appt);
  const tier1Keys = Object.keys(BIO_TIER).filter((k) => BIO_TIER[k] === 1);
  const present1 = tier1Keys.filter((k) => num(b[k]) != null);
  const badMarkers = present1
    .filter((k) => targetStatus(k, num(b[k])) === "bad")
    .map((k) => KEY_LABEL[k] || k);
  const warnMarkers = present1
    .filter((k) => targetStatus(k, num(b[k])) === "warn")
    .map((k) => KEY_LABEL[k] || k);

  // Compare cur vs prev for the markers we have on both sides — gives us a
  // human-readable "improved on …, worsened on …" picture.
  const improved = [];
  const worsened = [];
  for (const k of present1) {
    const cur = num(b[k]);
    const prev = num(p[k]);
    if (cur == null || prev == null) continue;
    const lowerBetter = !["egfr", "hdl"].includes(k);
    const delta = cur - prev;
    if (Math.abs(delta) < 0.001) continue;
    const better = lowerBetter ? delta < 0 : delta > 0;
    (better ? improved : worsened).push(KEY_LABEL[k] || k);
  }

  switch (bucket) {
    case "worse_out":
      return badMarkers.length
        ? `Out of range on ${badMarkers.slice(0, 3).join(", ")}`
        : "Tier-1 marker in red zone";
    case "worse_in":
      if (worsened.length)
        return `In range but trending up on ${worsened.slice(0, 3).join(", ")}`;
      if (warnMarkers.length)
        return `Borderline on ${warnMarkers.slice(0, 3).join(", ")}`;
      return "Mixed signals — borderline trend";
    case "getting_better":
      return improved.length
        ? `Improving on ${improved.slice(0, 3).join(", ")} (not at target yet)`
        : "Trending toward target, not there yet";
    case "in_control":
      return present1.length > 0
        ? `All ${present1.length} Tier-1 marker${present1.length > 1 ? "s" : ""} at target`
        : "Stable — values at clinical goal";
    case "lab_processing": {
      const pend = Number(appt.pending_labs) || 0;
      const partial = Number(appt.partial_labs) || 0;
      const bits = [];
      if (pend > 0) bits.push(`${pend} pending`);
      if (partial > 0) bits.push(`${partial} partial`);
      return `Gini-Lab order(s) open: ${bits.join(", ") || "in progress"}`;
    }
    case "review": {
      const recent = Number(appt.recent_labs) || 0;
      const uploaded = Number(appt.uploaded_labs) || 0;
      if (recent > 0 && uploaded > 0)
        return "Gini-Lab synced & document uploaded · no canonical value extracted";
      if (recent > 0)
        return "Gini-Lab synced · no canonical value extracted";
      return "Document uploaded · no canonical value extracted";
    }
    case "no_reports": {
      const last = appt.uploaded_labs_date;
      if (last) {
        const lv = appt.last_visit_date;
        if (lv && new Date(last) <= new Date(lv))
          return "Last upload is older than the previous visit";
        return "Last upload doesn't cover today's visit window";
      }
      return "No report uploaded or received for today's visit";
    }
    default:
      return "";
  }
}

// Determine which required panels are missing from this appointment.
function missingPanels(appt) {
  const b = bioOf(appt);
  return REQUIRED_PANELS.filter((p) => !p.keys.some((k) => num(b[k]) != null)).map((p) => p.name);
}

// Lifestyle concern signals from coordinator-captured compliance fields.
function lifestyleConcerns(appt) {
  const c = appt.compliance || {};
  const flagged = [];
  if (typeof c.diet === "string" && /poor|bad/i.test(c.diet)) flagged.push("diet");
  if (typeof c.exercise === "string" && /poor|none|bad/i.test(c.exercise)) flagged.push("exercise");
  if (typeof c.stress === "string" && /high|bad/i.test(c.stress)) flagged.push("stress");
  return flagged;
}

// Read-only routing hint based on complication diagnoses.
function autoRouteHint(appt) {
  const dx = appt.healthray_diagnoses;
  const joined = Array.isArray(dx)
    ? dx.map((d) => (typeof d === "string" ? d : d?.name || "")).join(" ")
    : String(dx || "");
  if (/foot|ulcer|neuropath/i.test(joined)) return "🦶 Podiatry / Dr. Beant Sidhu";
  if (/retin/i.test(joined)) return "👁 Ophthalmology referral";
  if (/nephro|kidney/i.test(joined)) return "🩺 Nephrology review";
  return null;
}

// Derive 8 pipeline funnel buckets from the appointment list.
function derivePipeline(appts) {
  const buckets = {
    total: [],
    labReceived: [],
    labProcessing: [],
    uploaded: [],
    dataComplete: [],
    categorised: [],
    assigned: [],
    checkedIn: [],
    noShowCancel: [],
  };
  for (const a of appts) {
    buckets.total.push(a);
    const pending = Number(a.pending_labs) || 0;
    const partial = Number(a.partial_labs) || 0;
    const recent = Number(a.recent_labs) || 0;
    const uploaded = Number(a.uploaded_labs) || 0;
    // Lab received: only counts a report that landed in our system **between
    // the previous visit and today's visit** — the freshness flag is computed
    // upstream in `enriched`. This keeps the pill aligned with the freshness
    // rule that decides whether a patient moves out of No Reports.
    if (a.__freshReport) buckets.labReceived.push(a);
    // Lab processing: orders pending / partial AND no results received yet.
    if (recent === 0 && (pending > 0 || partial > 0)) buckets.labProcessing.push(a);
    if (uploaded > 0 || (a.patient_report_count || 0) > 0) buckets.uploaded.push(a);
    if (hasAnyTier1Biomarker(a)) buckets.dataComplete.push(a);
    if (a.category) buckets.categorised.push(a);
    if (a.doctor_name) buckets.assigned.push(a);
    const s = a.status || "";
    if (["checkedin", "in_visit", "seen", "completed"].includes(s)) buckets.checkedIn.push(a);
    if (["no_show", "cancelled"].includes(s)) buckets.noShowCancel.push(a);
  }
  return buckets;
}

// ── Pipeline pill ──
function PipelinePill({ label, sub, count, tone }) {
  const fg =
    tone === "ok" ? MG : tone === "warn" ? AM : tone === "crit" ? RE : tone === "lv" ? LV : INK3;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 110,
        padding: "8px 10px",
        textAlign: "center",
        background: WH,
        border: `1.5px solid ${BD}`,
        borderRadius: 9,
        fontFamily: FB,
        position: "relative",
      }}
    >
      <div style={{ fontFamily: FM, fontSize: 20, fontWeight: 500, color: fg, lineHeight: 1 }}>
        {count}
      </div>
      <div
        style={{
          fontSize: 9,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: ".07em",
          color: INK3,
          marginTop: 4,
        }}
      >
        {label}
      </div>
      {sub && <div style={{ fontSize: 9, color: INK4, marginTop: 1, lineHeight: 1.3 }}>{sub}</div>}
    </div>
  );
}

function Chip({ children, tone = "default", active, onClick, title }) {
  const map = {
    default: { bg: WH, fg: INK2, bd: BD },
    red: { bg: REL, fg: RE, bd: `${RE}33` },
    amb: { bg: AML, fg: AM, bd: `${AM}33` },
    grn: { bg: GNL, fg: MG, bd: `${MG}33` },
    pu: { bg: LVL, fg: LV, bd: `${LV}33` },
    all: { bg: NV, fg: WH, bd: NV },
    doc: { bg: WH, fg: INK2, bd: BD },
    upload: { bg: LVL, fg: LV, bd: `${LV}33` },
  };
  const p = map[tone] || map.default;
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: "4px 11px",
        borderRadius: 18,
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        border: `1px solid ${active ? p.fg : p.bd}`,
        background: active ? p.fg : p.bg,
        color: active ? WH : p.fg,
        fontFamily: FB,
        whiteSpace: "nowrap",
        transition: "all .15s",
      }}
    >
      {children}
    </button>
  );
}

// ── Patient card ──
function PatientCard({ appt, bucket, onAssign, onOpen, onUpload }) {
  const b = bioOf(appt);
  const p = prevOf(appt);
  const missing = missingPanels(appt);
  const lifestyle = lifestyleConcerns(appt);
  // eslint-disable-next-line no-unused-vars
  const route = autoRouteHint(appt);
  const compPct = num(appt.compliance?.medPct);
  const assigned = !!appt.doctor_name;
  const status = appt.status || "";
  const isCheckedIn = ["checkedin", "in_visit", "seen", "completed"].includes(status);

  const bucketAccent =
    bucket === "worse_out"
      ? RE
      : bucket === "worse_in"
        ? AM
        : bucket === "getting_better"
          ? "#2d9a42"
          : bucket === "in_control"
            ? MG
            : bucket === "lab_processing"
              ? SK
              : bucket === "review"
                ? AM
                : LV;

  // Append prev_hba1c as a fallback for the legacy field.
  const prevHba1c = num(p.hba1c) ?? num(appt.prev_hba1c);

  // Bio chips — always compare the two most recent readings we have.
  //   - If a value exists for the current visit, chip shows prev → cur.
  //   - If only historical readings exist, chip shows the older one → the more
  //     recent one (treating the latest historical as the "right side" so the
  //     trend arrow always reads oldest → newest).
  // The chip's colour tone is driven by the rightmost (most recent) value.
  const DEFAULT_CHIP_KEYS = ["hba1c", "fg", "ldl", "tg", "uacr", "egfr"];
  const bioRows = [];
  const pushChip = (k) => {
    const curRaw = num(b[k]);
    const prevRaw = k === "hba1c" ? prevHba1c : num(p[k]);
    let cur = null;
    let prev = null;
    if (curRaw != null) {
      cur = curRaw;
      prev = prevRaw;
    } else if (prevRaw != null) {
      // No current reading — use the latest historical as "cur" so the chip
      // still shows the most recent value. We don't have a third reading to
      // fill `prev` with, so the chip renders as a single value.
      cur = prevRaw;
      prev = null;
    } else {
      return;
    }
    const tone = targetStatus(k, cur);
    bioRows.push({ k, label: KEY_LABEL[k] || k, cur, prev, tone });
  };
  for (const k of DEFAULT_CHIP_KEYS) pushChip(k);
  // Also surface ANY other biomarker whose current value is out of range —
  // even non-standard markers (BP, HDL, TSH, Hb, ALT…) — so the clinician
  // never misses a bad reading just because it isn't in the default chip set.
  const seen = new Set(bioRows.map((r) => r.k));
  for (const k of Object.keys(b)) {
    if (k.startsWith("_")) continue;
    if (seen.has(k)) continue;
    const cur = num(b[k]);
    if (cur == null) continue;
    const tone = targetStatus(k, cur);
    if (tone !== "bad") continue;
    const prev = num(p[k]);
    bioRows.push({ k, label: KEY_LABEL[k] || k.toUpperCase(), cur, prev, tone });
    seen.add(k);
  }

  const chipPal = (tone) =>
    tone === "bad"
      ? { bg: REL, fg: RE }
      : tone === "warn"
        ? { bg: AML, fg: AM }
        : tone === "ok"
          ? { bg: GNL, fg: MG }
          : { bg: BG, fg: INK3 };

  // Report banner: missing 0 = ok, missing some = partial, missing all = missing.
  // "review" bucket gets its own tone — Gini-Lab synced but no canonical value
  // extracted, so the action is "review the document", not "chase a report".
  const reportTone =
    bucket === "review"
      ? "review"
      : bucket === "no_reports" || missing.length === REQUIRED_PANELS.length
        ? "missing"
        : missing.length === 0
          ? "ok"
          : "partial";
  const reportPal =
    reportTone === "review"
      ? {
          bg: AML,
          fg: AM,
          txt:
            (Number(appt.uploaded_labs) || 0) > 0 && (Number(appt.recent_labs) || 0) === 0
              ? "Report uploaded · review document, no canonical value extracted"
              : "Gini-Lab synced · review document, no canonical value extracted",
        }
      : reportTone === "missing"
        ? { bg: LVL, fg: LV, txt: "No reports uploaded or received" }
        : reportTone === "partial"
          ? { bg: AML, fg: AM, txt: `Missing: ${missing.join(" · ")}` }
          : { bg: GNL, fg: MG, txt: "All required panels present" };

  return (
    <div
      onClick={() => onOpen && onOpen(appt)}
      style={{
        background: WH,
        border: `1px solid ${BD}`,
        borderLeft: `3px solid ${bucketAccent}`,
        borderRadius: 9,
        padding: "10px 11px",
        cursor: "pointer",
        boxShadow: SH,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      {/* Top row */}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 800, color: INK }}>
            {appt.patient_name || "Unnamed"}
          </div>
          <div style={{ fontSize: 9, color: INK4, marginTop: 1, fontFamily: FM }}>
            {[
              appt.age != null ? `${appt.age}${(appt.sex || "").slice(0, 1).toUpperCase()}` : null,
              appt.file_no || (appt.patient_id ? `P_${appt.patient_id}` : null),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {appt.time_slot && (
          <div style={{ fontFamily: FM, fontSize: 11, fontWeight: 500, color: INK2 }}>
            {appt.time_slot}
          </div>
        )}
      </div>

      {/* Status row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {isCheckedIn ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 5,
              background: SKL,
              color: SK,
              border: `1px solid ${SK}33`,
            }}
          >
            ✓ Checked in
          </span>
        ) : status === "no_show" || status === "cancelled" ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 5,
              background: BG,
              color: INK3,
              border: `1px solid ${BD}`,
            }}
          >
            {status === "no_show" ? "No-show" : "Cancelled"}
          </span>
        ) : (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 5,
              background: GNL,
              color: MG,
              border: `1px solid ${MG}33`,
            }}
          >
            Appt: Booked
          </span>
        )}
        {appt.visit_count != null && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              padding: "2px 7px",
              borderRadius: 5,
              background: "#f1f5f9",
              color: "#475569",
              border: "1px solid #cbd5e1",
            }}
          >
            Visit {appt.visit_count}
          </span>
        )}
        {(() => {
          const pend = Number(appt.pending_labs) || 0;
          const recent = Number(appt.recent_labs) || 0;
          const partial = Number(appt.partial_labs) || 0;
          const uploaded = Number(appt.uploaded_labs) || 0;
          // Has the sync actually surfaced biomarker values? If Gini-Lab says
          // "received" but no canonical value made it into our lab_results,
          // there's nothing for the clinician to read — flag that distinctly.
          const hasValues = hasAnyTier1Biomarker(appt);
          const chips = [];
          if (recent > 0 && hasValues) {
            chips.push({
              key: "received",
              bg: GNL,
              fg: MG,
              label: `🧪 Gini-Lab received${recent > 1 ? ` (${recent})` : ""}`,
              title: "Results received from Gini-Lab",
            });
          } else if (recent > 0 && !hasValues) {
            chips.push({
              key: "syncedNoValues",
              bg: AML,
              fg: AM,
              label: "🧪 Gini-Lab synced · no values yet",
              title: "Gini-Lab marked the case received, but no canonical values were extracted",
            });
          } else if (uploaded > 0 && !hasValues) {
            chips.push({
              key: "uploadedNoValues",
              bg: AML,
              fg: AM,
              label: "⬆ Uploaded · no values yet",
              title:
                "Report was uploaded but no canonical biomarker value has been extracted yet",
            });
          } else if (pend > 0) {
            chips.push({
              key: "pending",
              bg: AML,
              fg: AM,
              label: `🧪 Gini-Lab: ${pend} pending`,
              title: "Lab orders awaiting results",
            });
          } else if (partial > 0) {
            chips.push({
              key: "partial",
              bg: AML,
              fg: AM,
              label: `🧪 Gini-Lab: ${partial} partial`,
              title: "Partial results received",
            });
          }
          if (uploaded > 0) {
            chips.push({
              key: "uploaded",
              bg: "#eef2ff",
              fg: "#4338ca",
              label: "⬆ Lab uploaded",
              title: "Lab report uploaded manually",
            });
          }
          return chips.map((c) => (
            <span
              key={c.key}
              title={c.title}
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: "2px 7px",
                borderRadius: 5,
                background: c.bg,
                color: c.fg,
                border: `1px solid ${c.fg}33`,
              }}
            >
              {c.label}
            </span>
          ));
        })()}
      </div>

      {/* Dates */}
      <div style={{ fontSize: 9, color: INK4, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {appt.uploaded_labs_date ? (
          <span>
            📅 Last report:{" "}
            <strong style={{ color: INK3 }}>
              {new Date(appt.uploaded_labs_date).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </strong>{" "}
            <span style={{ color: INK4 }}>
              · via{" "}
              {(Number(appt.recent_labs) || 0) > 0 && (Number(appt.uploaded_labs) || 0) > 0
                ? "Gini-Lab + Upload"
                : (Number(appt.recent_labs) || 0) > 0
                  ? "Gini-Lab"
                  : "Upload"}
            </span>
          </span>
        ) : (Number(appt.recent_labs) || 0) > 0 ? (
          hasAnyTier1Biomarker(appt) ? (
            <span>
              📅 Last report: <strong style={{ color: INK3 }}>Received today</strong>{" "}
              <span style={{ color: INK4 }}>· via Gini-Lab</span>
            </span>
          ) : (
            <span>
              📅 Gini-Lab synced today <span style={{ color: INK4 }}>· no values extracted yet</span>
            </span>
          )
        ) : null}
        {(() => {
          // Drop the "Last visit" stamp when the recorded date is the same as
          // (or after) today's appointment — that's the current slot, not a
          // prior visit, and showing it confuses the clinician.
          if (!appt.last_visit_date) return null;
          const lv = new Date(appt.last_visit_date).getTime();
          const apptMs = appt.appointment_date
            ? new Date(appt.appointment_date).getTime()
            : Date.now();
          if (!isFinite(lv) || lv >= apptMs) return null;
          return (
            <span>
              🩺 Last visit:{" "}
              <strong style={{ color: INK3 }}>
                {new Date(lv).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </strong>
            </span>
          );
        })()}
      </div>

      {/* Report banner */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 8px",
          borderRadius: 7,
          background: reportPal.bg,
          color: reportPal.fg,
          fontSize: 10,
          fontWeight: 600,
          border: `1px solid ${reportPal.fg}22`,
        }}
      >
        <span>{reportTone === "ok" ? "📊" : "⚠"}</span>
        <span style={{ flex: 1 }}>{reportPal.txt}</span>
        {reportTone === "missing" && onUpload && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onUpload(appt);
            }}
            style={{
              fontSize: 9,
              fontWeight: 800,
              padding: "2px 8px",
              borderRadius: 4,
              background: LV,
              color: WH,
              border: "none",
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            Upload now
          </button>
        )}
      </div>

      {/* Why this bucket — short audit line so coordinators can see at a
          glance which signal put this patient in their current column. */}
      {(() => {
        const reason = bucketReason(appt, bucket);
        if (!reason) return null;
        return (
          <div
            style={{
              fontSize: 9,
              color: bucketAccent,
              display: "flex",
              gap: 4,
              alignItems: "flex-start",
              lineHeight: 1.35,
            }}
          >
            <span style={{ fontWeight: 800 }}>Why:</span>
            <span style={{ color: INK3, fontWeight: 500 }}>{reason}</span>
          </div>
        );
      })()}

      {/* Underlying condition badge — shown on no-reports cards so the
          clinician still sees how the patient was trending on their last fresh
          set of labs. */}
      {bucket === "no_reports" &&
        appt.__conditionBucket &&
        appt.__conditionBucket !== "no_reports" && (
          (() => {
            const cb = appt.__conditionBucket;
            const cond =
              cb === "worse_out"
                ? { bg: REL, fg: RE, icon: "🔴", label: "Last labs: Out of range" }
                : cb === "worse_in"
                  ? { bg: AML, fg: AM, icon: "🟡", label: "Last labs: Trending up" }
                  : cb === "getting_better"
                    ? { bg: GNL, fg: "#2d9a42", icon: "↑", label: "Last labs: Improving" }
                    : { bg: GNL, fg: MG, icon: "✅", label: "Last labs: In control" };
            return (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 8px",
                  borderRadius: 7,
                  background: cond.bg,
                  color: cond.fg,
                  fontSize: 10,
                  fontWeight: 600,
                  border: `1px solid ${cond.fg}22`,
                }}
              >
                <span>{cond.icon}</span>
                <span style={{ flex: 1 }}>{cond.label}</span>
              </div>
            );
          })()
        )}

      {/* Stale-data stamp — when this card lives in No Reports but still has
          biomarker values, tell the clinician when those values entered our
          system. The truth is per-biomarker (biomarkers._lab_dates), so we
          surface the most recent test_date across the chips we're showing,
          and fall back to prev_biomarkers when the latest entry has no date. */}
      {bucket === "no_reports" && bioRows.length > 0 && (
        (() => {
          const labDates = (appt.biomarkers && appt.biomarkers._lab_dates) || {};
          const prevLabDates =
            (appt.prev_biomarkers && appt.prev_biomarkers._lab_dates) || {};
          let latestMs = null;
          for (const r of bioRows) {
            const d = labDates[r.k] || prevLabDates[r.k];
            if (!d) continue;
            const t = new Date(d).getTime();
            if (!isNaN(t) && (latestMs == null || t > latestMs)) latestMs = t;
          }
          const stamp =
            latestMs != null
              ? new Date(latestMs).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })
              : "date unknown";
          return (
            <div
              style={{
                fontSize: 9,
                color: INK4,
                fontStyle: "italic",
                display: "flex",
                gap: 4,
                flexWrap: "wrap",
              }}
            >
              <span>📥 Values recorded in system:</span>
              <strong style={{ color: INK3, fontStyle: "normal" }}>{stamp}</strong>
            </div>
          );
        })()
      )}

      {/* Bio chips — prev → cur */}
      {bioRows.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
          {bioRows.map((r) => {
            const pal = chipPal(r.tone);
            return (
              <span
                key={r.k}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  fontFamily: FM,
                  padding: "3px 7px",
                  borderRadius: 6,
                  background: pal.bg,
                  color: pal.fg,
                  border: `1px solid ${pal.fg}22`,
                  whiteSpace: "nowrap",
                }}
              >
                <span style={{ fontWeight: 600, marginRight: 4 }}>{r.label}</span>
                {r.prev != null && (
                  <>
                    <span style={{ opacity: 0.6, fontSize: 9 }}>{r.prev}</span>
                    <span style={{ opacity: 0.55, fontSize: 9, margin: "0 2px" }}>→</span>
                  </>
                )}
                <span style={{ fontWeight: 800 }}>{r.cur}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* Compliance bar */}
      {compPct != null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: INK3 }}>
          <span style={{ fontSize: 9 }}>💊</span>
          <span
            style={{
              fontFamily: FM,
              fontWeight: 700,
              minWidth: 32,
              color: compPct < 60 ? RE : compPct < 80 ? AM : MG,
            }}
          >
            {compPct}%
          </span>
          <div
            style={{
              flex: 1,
              height: 5,
              background: BG,
              borderRadius: 3,
              overflow: "hidden",
              border: `1px solid ${BD}`,
            }}
          >
            <div
              style={{
                width: `${Math.max(0, Math.min(100, compPct))}%`,
                height: "100%",
                background: compPct < 60 ? RE : compPct < 80 ? AM : MG,
              }}
            />
          </div>
          <span style={{ fontSize: 9, color: INK4, fontWeight: 500 }}>
            {compPct >= 90
              ? "Excellent"
              : compPct >= 80
                ? "Good"
                : compPct >= 60
                  ? "Moderate"
                  : "Low"}
          </span>
        </div>
      ) : (appt.visit_count || 0) <= 1 ? (
        <div style={{ fontSize: 9, color: INK4 }}>💊 New patient — no compliance history</div>
      ) : null}

      {/* Pre-visit question */}
      {appt.pre_visit_notes && (
        <div
          style={{
            background: SKL,
            borderLeft: `3px solid ${SK}`,
            borderRadius: "0 7px 7px 0",
            padding: "5px 8px",
            fontSize: 10,
            color: "#1e3a8a",
            fontWeight: 500,
            lineHeight: 1.4,
          }}
        >
          ❓ {appt.pre_visit_notes}
        </div>
      )}

      {/* Pre-visit symptoms */}
      {Array.isArray(appt.pre_visit_symptoms) && appt.pre_visit_symptoms.length > 0 && (
        <div
          style={{
            background: AML,
            borderLeft: `3px solid ${AM}`,
            borderRadius: "0 7px 7px 0",
            padding: "5px 8px",
            fontSize: 10,
            color: "#78350f",
            fontWeight: 500,
            lineHeight: 1.4,
          }}
        >
          🔴 Pre-visit symptoms: {appt.pre_visit_symptoms.join(" · ")}
        </div>
      )}

      {/* Lifestyle row */}
      {lifestyle.length > 0 && (
        <div
          style={{
            background: AML,
            borderLeft: `2px solid ${AM}`,
            padding: "4px 7px",
            borderRadius: "0 6px 6px 0",
            fontSize: 10,
            color: AM,
            fontWeight: 700,
          }}
        >
          🥗 Lifestyle concern: {lifestyle.join(", ")}
        </div>
      )}

      {/* Route hint — temporarily disabled per product request.
      {route && (
        <div style={{ fontSize: 10, color: INK3, display: "flex", gap: 5 }}>
          <span>{route}</span>
        </div>
      )}
      */}

      {/* Actions */}
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: "3px 8px",
            borderRadius: 5,
            background: assigned ? GNL : AML,
            color: assigned ? MG : AM,
            border: `1px solid ${assigned ? MG : AM}22`,
          }}
          title={assigned ? appt.doctor_name : "Unassigned"}
        >
          {assigned ? `→ ${appt.doctor_name}` : "⏳ Unassigned"}
        </span>
        <div style={{ display: "flex", gap: 5, marginLeft: "auto" }}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAssign(appt);
            }}
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "4px 9px",
              borderRadius: 6,
              border: `1px solid ${assigned ? BD : T}`,
              background: assigned ? WH : T,
              color: assigned ? INK3 : WH,
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            {assigned ? "↺ Reassign" : "+ Assign"}
          </button>
          {onUpload && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUpload(appt);
              }}
              title={bucket === "no_reports" ? "Upload report" : "Upload / update report"}
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "4px 9px",
                borderRadius: 6,
                border: `1px solid ${bucket === "no_reports" ? LV : BD}`,
                background: bucket === "no_reports" ? LV : WH,
                color: bucket === "no_reports" ? WH : INK2,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              ⬆ {bucket === "no_reports" ? "Upload" : "Update"}
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpen && onOpen(appt);
            }}
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "4px 9px",
              borderRadius: 6,
              border: `1px solid ${BD}`,
              background: WH,
              color: INK2,
              cursor: "pointer",
              fontFamily: FB,
            }}
          >
            ↗ Open
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Kanban column ──
function Column({ accent, icon, title, hint, items, onAssign, onOpen, onUpload }) {
  return (
    <div
      style={{
        flex: "1 1 0",
        minWidth: 260,
        display: "flex",
        flexDirection: "column",
        borderRadius: 11,
        overflow: "hidden",
        border: `1.5px solid ${accent}33`,
        background: WH,
      }}
    >
      <div
        style={{
          padding: "10px 12px",
          background: accent,
          color: WH,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              textTransform: "uppercase",
              letterSpacing: ".05em",
            }}
          >
            {icon} {title}
          </div>
          {hint && (
            <div style={{ fontSize: 9, opacity: 0.85, marginTop: 3, fontWeight: 500 }}>{hint}</div>
          )}
        </div>
        <div style={{ fontFamily: FM, fontSize: 20, fontWeight: 500, lineHeight: 1 }}>
          {items.length}
        </div>
      </div>
      <div
        style={{
          padding: 6,
          display: "flex",
          flexDirection: "column",
          gap: 6,
          background: "rgba(255,255,255,.55)",
          minHeight: 80,
          maxHeight: "calc(100vh - 320px)",
          overflowY: "auto",
        }}
      >
        {items.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: 12,
              border: `1.5px dashed ${BD}`,
              borderRadius: 9,
              fontSize: 10,
              color: INK4,
            }}
          >
            No patients
          </div>
        ) : (
          items.map((a) => (
            <PatientCard
              key={a.id}
              appt={a}
              bucket={a.__bucket}
              onAssign={onAssign}
              onOpen={onOpen}
              onUpload={onUpload}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── Simple inline patient picker (used by global Upload Reports flow) ──
function PatientPickerModal({ appointments, onPick, onClose }) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return appointments;
    return appointments.filter(
      (a) =>
        (a.patient_name || "").toLowerCase().includes(needle) ||
        String(a.file_no || a.patient_id || "")
          .toLowerCase()
          .includes(needle),
    );
  }, [q, appointments]);
  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: WH,
          borderRadius: 14,
          padding: 18,
          width: 420,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 50px rgba(0,0,0,.22)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 800, color: INK, marginBottom: 4 }}>
          Pick patient for upload
        </div>
        <div style={{ fontSize: 11, color: INK3, marginBottom: 10 }}>
          Choose the patient this report belongs to.
        </div>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search by name or file no…"
          style={{
            padding: "7px 10px",
            border: `1px solid ${BD}`,
            borderRadius: 7,
            fontSize: 12,
            fontFamily: FB,
            outline: "none",
            marginBottom: 10,
          }}
        />
        <div
          style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}
        >
          {filtered.length === 0 ? (
            <div style={{ fontSize: 11, color: INK4, textAlign: "center", padding: 20 }}>
              No matching patients in today's schedule.
            </div>
          ) : (
            filtered.map((a) => (
              <button
                key={a.id}
                onClick={() => onPick(a)}
                style={{
                  textAlign: "left",
                  padding: "8px 10px",
                  border: `1px solid ${BD}`,
                  borderRadius: 7,
                  background: WH,
                  cursor: "pointer",
                  fontFamily: FB,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 700, color: INK }}>{a.patient_name}</div>
                <div style={{ fontSize: 10, color: INK3, marginTop: 1, fontFamily: FM }}>
                  {a.file_no || `P_${a.patient_id}`} · {a.time_slot || ""}
                </div>
              </button>
            ))
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <button
            onClick={onClose}
            style={{
              padding: "7px 14px",
              border: `1px solid ${BD}`,
              borderRadius: 7,
              background: WH,
              color: INK2,
              cursor: "pointer",
              fontFamily: FB,
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Lightweight assign modal ──
function AssignModal({ appt, doctors, onClose, onConfirm }) {
  const [sel, setSel] = useState(appt.doctor_name || "");
  const [q, setQ] = useState("");
  const baseList = (
    doctors && doctors.length > 0 ? doctors : ["Dr. Bhansali", "Dr. Beant Sidhu", "Dr. Simranpreet"]
  ).slice();
  const needle = q.trim().toLowerCase();
  const list = needle
    ? baseList.filter((d) => String(d).toLowerCase().includes(needle))
    : baseList;
  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          background: WH,
          borderRadius: 14,
          padding: 18,
          width: 360,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "0 20px 50px rgba(0,0,0,.22)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>
          Assign — {appt.patient_name}
        </div>
        <div style={{ fontSize: 11, color: INK3, marginTop: 3, marginBottom: 10 }}>
          Select the doctor responsible for this patient.
        </div>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search doctor…"
          style={{
            padding: "7px 10px",
            border: `1px solid ${BD}`,
            borderRadius: 7,
            fontSize: 12,
            fontFamily: FB,
            outline: "none",
            marginBottom: 10,
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            overflowY: "auto",
            flex: 1,
            minHeight: 0,
            paddingRight: 4,
          }}
        >
          {list.length === 0 ? (
            <div style={{ fontSize: 11, color: INK4, textAlign: "center", padding: 16 }}>
              No matching doctors
            </div>
          ) : list.map((d) => (
            <button
              key={d}
              onClick={() => setSel(d)}
              style={{
                padding: "8px 12px",
                border: `1px solid ${sel === d ? T : BD}`,
                borderRadius: 8,
                background: sel === d ? TL : WH,
                cursor: "pointer",
                fontFamily: FB,
                textAlign: "left",
                fontSize: 12,
                fontWeight: 700,
                color: INK,
              }}
            >
              {d}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1,
              padding: "9px",
              border: `1px solid ${BD}`,
              borderRadius: 7,
              background: WH,
              color: INK3,
              cursor: "pointer",
              fontFamily: FB,
              fontWeight: 700,
            }}
          >
            Cancel
          </button>
          <button
            disabled={!sel}
            onClick={() => onConfirm(sel)}
            style={{
              flex: 2,
              padding: "9px",
              border: "none",
              borderRadius: 7,
              background: sel ? T : BD,
              color: WH,
              cursor: sel ? "pointer" : "default",
              fontFamily: FB,
              fontWeight: 700,
            }}
          >
            ✓ Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Upload modal (styled to match OPD, not Visit) ──
const REPORT_TYPES = [
  { value: "lab_report", label: "Blood Report (HbA1c, Lipids, TFT, KFT)" },
  { value: "imaging", label: "Radiology (X-Ray, USG, Echo, MRI, CT)" },
  { value: "abi", label: "ABI (Ankle-Brachial Index)" },
  { value: "vpt", label: "VPT (Vibration Perception Threshold)" },
  { value: "ecg", label: "ECG / Holter" },
  { value: "urine", label: "Urine Report" },
  { value: "other", label: "Other" },
];

function UploadModal({ patient, onClose, onSubmit }) {
  const [form, setForm] = useState({
    doc_type: "lab_report",
    doc_date: "",
    source: "",
    notes: "",
  });
  const [file, setFile] = useState(null);
  const [fileName, setFileName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const handleFile = (f) => {
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) {
      alert("File too large (max 10MB)");
      return;
    }
    setFileName(f.name);
    const reader = new FileReader();
    reader.onload = () => setFile(reader.result.split(",")[1]);
    reader.readAsDataURL(f);
  };

  const handleSubmit = async () => {
    if (uploading) return;
    setUploading(true);
    try {
      await onSubmit({ ...form, base64: file, fileName });
    } finally {
      setUploading(false);
    }
  };

  const labelStyle = {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: INK2,
    marginBottom: 5,
  };
  const fieldStyle = {
    width: "100%",
    padding: "7px 10px",
    border: `1px solid ${BD}`,
    borderRadius: 6,
    background: WH,
    fontSize: 12,
    fontFamily: FB,
    color: INK,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      onClick={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.4)",
        zIndex: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        style={{
          background: WH,
          borderRadius: 14,
          padding: 20,
          width: 460,
          maxWidth: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 20px 50px rgba(0,0,0,.22)",
          fontFamily: FB,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 800, color: INK, marginBottom: 4 }}>
          📎 Upload Lab / Radiology Report
        </div>
        {patient && (
          <div
            style={{
              marginTop: 6,
              marginBottom: 12,
              padding: "8px 11px",
              background: GNL,
              border: `1px solid ${MG}33`,
              borderRadius: 7,
              fontSize: 11,
              color: MG,
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: 7,
            }}
          >
            ✓ Uploading for: <strong style={{ color: INK }}>{patient.patient_name}</strong>
            <span style={{ fontFamily: FM, color: INK3, fontWeight: 500 }}>
              · {patient.file_no || `P_${patient.patient_id}`}
            </span>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Report Type *</label>
          <select
            style={fieldStyle}
            value={form.doc_type}
            onChange={(e) => set("doc_type", e.target.value)}
          >
            {REPORT_TYPES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>Lab / Report Date *</label>
            <input
              style={fieldStyle}
              type="date"
              value={form.doc_date}
              onChange={(e) => set("doc_date", e.target.value)}
            />
          </div>
          <div>
            <label style={labelStyle}>Lab / Hospital Name</label>
            <input
              style={fieldStyle}
              placeholder="e.g. SRL Diagnostics"
              value={form.source}
              onChange={(e) => set("source", e.target.value)}
            />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Notes (optional)</label>
          <textarea
            style={{ ...fieldStyle, minHeight: 56, resize: "vertical", fontFamily: FB }}
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
          />
        </div>

        <div
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFile(e.dataTransfer.files?.[0]);
          }}
          style={{
            border: `2px dashed ${dragging ? T : BD}`,
            borderRadius: 9,
            padding: "20px 14px",
            textAlign: "center",
            cursor: "pointer",
            transition: "all .15s",
            marginBottom: 14,
            background: dragging ? TL : BG,
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            style={{ display: "none" }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
          {fileName ? (
            <div style={{ fontSize: 12, fontWeight: 700, color: T }}>📄 {fileName}</div>
          ) : (
            <>
              <div style={{ fontSize: 22, marginBottom: 5 }}>📂</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: INK2 }}>
                Drop file here or click to browse
              </div>
              <div style={{ fontSize: 10, color: INK3, marginTop: 3 }}>
                PDF, JPG, PNG · Max 10 MB
              </div>
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onClose}
            disabled={uploading}
            style={{
              flex: 1,
              padding: "9px 12px",
              border: `1px solid ${BD}`,
              borderRadius: 7,
              background: WH,
              color: INK3,
              fontSize: 12,
              fontWeight: 700,
              cursor: uploading ? "default" : "pointer",
              fontFamily: FB,
              opacity: uploading ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!form.doc_type || uploading}
            style={{
              flex: 2,
              padding: "9px 12px",
              border: "none",
              borderRadius: 7,
              background: !form.doc_type || uploading ? BD : T,
              color: WH,
              fontSize: 12,
              fontWeight: 700,
              cursor: !form.doc_type || uploading ? "default" : "pointer",
              fontFamily: FB,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            {uploading ? (
              <>
                <span
                  style={{
                    width: 12,
                    height: 12,
                    border: "2px solid currentColor",
                    borderTopColor: "transparent",
                    borderRadius: "50%",
                    display: "inline-block",
                    animation: "triUploadSpin 0.7s linear infinite",
                  }}
                />
                Uploading…
              </>
            ) : (
              "⬆ Upload Report"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main view ──
export default function TriageViewV3({
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
  const isMobile = useIsMobile();
  const [view, setView] = useState("category"); // "category" | "assign"
  const [categoryFilter, setCategoryFilter] = useState("all"); // "all" | bucket id
  const [doctorFilter, setDoctorFilter] = useState(() => new Set()); // Set of selected names
  const [doctorMenuOpen, setDoctorMenuOpen] = useState(false);
  const doctorMenuRef = useRef(null);

  useEffect(() => {
    if (!doctorMenuOpen) return;
    const onDoc = (e) => {
      if (doctorMenuRef.current && !doctorMenuRef.current.contains(e.target)) {
        setDoctorMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [doctorMenuOpen]);
  const [searchQ, setSearchQ] = useState("");
  const [uploadState, setUploadState] = useState({ open: false, lockedAppt: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [assignAppt, setAssignAppt] = useState(null);

  const todayIso = toLocalIso(new Date());
  const isToday = !date || date === todayIso;
  const displayDate = date ? new Date(date + "T00:00:00") : new Date();
  const niceDate = displayDate.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  // Annotate appointments with their v3 bucket so child components can read it.
  const enriched = useMemo(() => {
    // Report-freshness rule: a report counts as fresh for this visit when it
    // was uploaded **after the previous visit** and **on or before the current
    // visit**. Anything outside that window (or missing) → no_reports.
    // For first-visit patients (no last_visit_date) we accept any upload dated
    // on or before today as fresh.
    const visitMs = date ? new Date(date).getTime() : Date.now();
    return appointments.map((a) => {
      const conditionBucket = triageTierV3(a);
      const uploadedAt = a.uploaded_labs_date ? new Date(a.uploaded_labs_date).getTime() : null;
      const lastVisitAt = a.last_visit_date ? new Date(a.last_visit_date).getTime() : null;
      const pending = Number(a.pending_labs) || 0;
      const partial = Number(a.partial_labs) || 0;
      const recent = Number(a.recent_labs) || 0;
      // Gini-Lab "received" — results synced AND at least one canonical
      // biomarker value made it through extraction. A sync without any values
      // is no better than no report at all (clinician has nothing to read).
      const hasValues = hasAnyTier1Biomarker(a);
      const giniReceived = recent > 0 && hasValues;
      // Report present in the system (Gini-Lab synced OR a document was
      // uploaded) but the canonical-tag biomarkers triageTier classifies on
      // (hba1c/sbp/fg/ldl/tg/uacr/egfr…) are absent. Either no canonical
      // value was extracted, or the values that came through don't map to
      // the triage keys. Either way, a human needs to review the document.
      const reportPresent = recent > 0 || (Number(a.uploaded_labs) || 0) > 0;
      const needsReview =
        reportPresent && (!hasValues || conditionBucket === "no_reports");
      let fresh = false;
      if (uploadedAt != null) {
        const afterLastVisit = lastVisitAt == null || uploadedAt > lastVisitAt;
        const beforeOrOnVisit = uploadedAt <= visitMs;
        fresh = afterLastVisit && beforeOrOnVisit;
      }
      // If Gini-Lab has reported results, count this patient as having a
      // fresh report for today's visit even if there's no uploaded-labs date.
      if (giniReceived) fresh = true;
      // Lab Processing: pending or partial orders AND no results yet received.
      const labInProgress = !giniReceived && !needsReview && (pending > 0 || partial > 0);
      let bucket;
      if (needsReview) bucket = "review";
      else if (labInProgress) bucket = "lab_processing";
      else if (!fresh) bucket = "no_reports";
      else bucket = conditionBucket;
      return {
        ...a,
        __bucket: bucket,
        __conditionBucket: conditionBucket,
        __freshReport: fresh,
      };
    });
  }, [appointments, date]);

  const pipeline = useMemo(() => derivePipeline(enriched), [enriched]);

  // Apply chip filters → produce visible appointment list.
  const visible = useMemo(() => {
    let arr = enriched;
    if (categoryFilter !== "all") arr = arr.filter((a) => a.__bucket === categoryFilter);
    if (doctorFilter.size > 0) arr = arr.filter((a) => doctorFilter.has(a.doctor_name || ""));
    const q = searchQ.trim().toLowerCase();
    if (q) {
      arr = arr.filter(
        (a) =>
          (a.patient_name || "").toLowerCase().includes(q) ||
          String(a.file_no || a.patient_id || "")
            .toLowerCase()
            .includes(q),
      );
    }
    return arr;
  }, [enriched, categoryFilter, doctorFilter, searchQ]);

  const buckets = useMemo(() => {
    const out = {
      worse_out: [],
      worse_in: [],
      getting_better: [],
      in_control: [],
      lab_processing: [],
      review: [],
      no_reports: [],
    };
    for (const a of visible) {
      if (out[a.__bucket]) out[a.__bucket].push(a);
    }
    // Helper: does the patient have any Gini-Lab activity (orders awaiting
    // results, partial results, or recent synced results)?
    const hasLab = (a) =>
      (Number(a.pending_labs) || 0) +
        (Number(a.partial_labs) || 0) +
        (Number(a.recent_labs) || 0) >
      0;
    // Visit-status priority: in_visit → checkedin → seen → everything else.
    // Lower number = higher priority (sorts to top).
    const visitRank = (a) => {
      const s = (a.status || "").toLowerCase();
      if (s === "in_visit") return 0;
      if (s === "checkedin") return 1;
      if (s === "seen") return 2;
      if (s === "completed") return 3;
      return 4;
    };
    // Condition columns: assigned first, then unassigned. Within each group,
    // active-visit patients (in_visit / checkedin / seen) float to the top.
    for (const k of ["worse_out", "worse_in", "getting_better", "in_control"]) {
      out[k] = out[k]
        .map((a, i) => ({ a, i }))
        .sort((x, y) => {
          const xa = x.a.doctor_name ? 0 : 1;
          const ya = y.a.doctor_name ? 0 : 1;
          return xa - ya || visitRank(x.a) - visitRank(y.a) || x.i - y.i;
        })
        .map((x) => x.a);
    }
    // Lab Processing column: assigned first then unassigned, with pending
    // labs surfaced above partial-only labs within each group.
    out.lab_processing = out.lab_processing
      .map((a, i) => ({ a, i }))
      .sort((x, y) => {
        const xa = x.a.doctor_name ? 0 : 1;
        const ya = y.a.doctor_name ? 0 : 1;
        const xp = (Number(x.a.pending_labs) || 0) > 0 ? 0 : 1;
        const yp = (Number(y.a.pending_labs) || 0) > 0 ? 0 : 1;
        return (
          xa - ya || xp - yp || visitRank(x.a) - visitRank(y.a) || x.i - y.i
        );
      })
      .map((x) => x.a);
    // Review column: assigned first, then unassigned; visit-status priority.
    out.review = out.review
      .map((a, i) => ({ a, i }))
      .sort((x, y) => {
        const xa = x.a.doctor_name ? 0 : 1;
        const ya = y.a.doctor_name ? 0 : 1;
        return xa - ya || visitRank(x.a) - visitRank(y.a) || x.i - y.i;
      })
      .map((x) => x.a);
    // No-Reports column: 1) assigned + no gini-lab, 2) assigned + gini-lab
    // processing, 3) unassigned + no gini-lab, 4) unassigned + gini-lab.
    // Within each tier, prioritise by visit status (in_visit → checkedin → seen).
    out.no_reports = out.no_reports
      .map((a, i) => {
        const assignedRank = a.doctor_name ? 0 : 1;
        const labRank = hasLab(a) ? 1 : 0;
        return { a, i, rank: assignedRank * 2 + labRank };
      })
      .sort((x, y) => x.rank - y.rank || visitRank(x.a) - visitRank(y.a) || x.i - y.i)
      .map((x) => x.a);
    return out;
  }, [visible]);

  // Doctors with at least one booking today, plus a per-doctor patient count.
  // Sorted by count (desc) then name (asc) so the busiest doctor is on top.
  const docChoices = useMemo(() => {
    const counts = new Map();
    for (const a of appointments) {
      if (!a.doctor_name) continue;
      counts.set(a.doctor_name, (counts.get(a.doctor_name) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [appointments]);

  const handleUploadSubmit = async (payload) => {
    const appt = uploadState.lockedAppt;
    if (!appt?.patient_id) {
      toast("No patient selected", "error");
      return;
    }
    try {
      await api.post(`/api/visit/${appt.patient_id}/document`, payload);
      toast("Document uploaded · extracting values", "success");
      setUploadState({ open: false, lockedAppt: null });
      onRefresh && onRefresh();
    } catch {
      toast("Failed to upload document", "error");
    }
  };

  const openUploadForAppt = (appt) => setUploadState({ open: true, lockedAppt: appt });
  const openGlobalUpload = () => setPickerOpen(true);

  const handleAssignConfirm = (doctor) => {
    if (!assignAppt) return;
    if (onUpdateAppt) onUpdateAppt(assignAppt.id, { doctor_name: doctor });
    setAssignAppt(null);
  };

  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        background: BG,
        color: INK,
        fontFamily: FB,
        minHeight: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          background: WH,
          borderBottom: `1px solid ${BD}`,
          padding: "10px 16px",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 10,
            flexWrap: "wrap",
            gap: 8,
          }}
        >
          <div>
            <div style={{ fontFamily: FD, fontSize: 18, color: INK }}>
              {isToday ? "Today's Patient Triage" : "Patient Triage"}{" "}
              <span style={{ fontSize: 11, color: INK4 }}>· v3</span>
            </div>
            <div style={{ fontSize: 11, color: INK3, marginTop: 1 }}>
              {niceDate} · {appointments.length} patient{appointments.length === 1 ? "" : "s"}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {(() => {
              const isFuture = !isToday && (date || todayIso) > todayIso;
              const tone = isToday
                ? { fg: MG, bg: GNL }
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
            {onDateChange && (
              <button
                type="button"
                onClick={() => !isToday && onDateChange(todayIso)}
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
                }}
              >
                <button
                  type="button"
                  title="Previous day"
                  onClick={() => {
                    const d = new Date(displayDate);
                    d.setDate(d.getDate() - 1);
                    onDateChange(toLocalIso(d));
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "2px 6px",
                    cursor: "pointer",
                    color: INK2,
                    fontSize: 13,
                    fontFamily: FB,
                  }}
                >
                  ‹
                </button>
                <span
                  style={{
                    fontFamily: FM,
                    fontSize: 11,
                    color: INK,
                    padding: "3px 6px",
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                    whiteSpace: "nowrap",
                  }}
                >
                  📅 {niceDate}
                </span>
                <button
                  type="button"
                  title="Next day"
                  onClick={() => {
                    const d = new Date(displayDate);
                    d.setDate(d.getDate() + 1);
                    onDateChange(toLocalIso(d));
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    padding: "2px 6px",
                    cursor: "pointer",
                    color: INK2,
                    fontSize: 13,
                    fontFamily: FB,
                  }}
                >
                  ›
                </button>
              </div>
            )}
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
              {[
                { id: "category", label: "Category" },
                { id: "assign", label: "Assignment" },
              ].map((o, i) => {
                const active = view === o.id;
                return (
                  <button
                    key={o.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setView(o.id)}
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
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              placeholder="Search by name or file no…"
              style={{
                padding: "5px 11px",
                border: `1px solid ${BD}`,
                borderRadius: 6,
                background: WH,
                fontSize: 11,
                fontFamily: FB,
                outline: "none",
                width: isMobile ? 140 : 200,
              }}
            />
            {/* Doctor multi-select */}
            <div ref={doctorMenuRef} style={{ position: "relative" }}>
              <button
                onClick={() => setDoctorMenuOpen((v) => !v)}
                style={{
                  padding: "5px 11px",
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: "pointer",
                  border: `1px solid ${doctorFilter.size > 0 ? T : BD}`,
                  background: doctorFilter.size > 0 ? TL : WH,
                  color: doctorFilter.size > 0 ? T : INK2,
                  fontFamily: FB,
                  whiteSpace: "nowrap",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {doctorFilter.size === 0
                  ? "All doctors"
                  : doctorFilter.size === 1
                    ? Array.from(doctorFilter)[0]
                    : `${doctorFilter.size} doctors`}
                <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
              </button>
              {doctorMenuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    right: 0,
                    minWidth: 220,
                    maxHeight: 280,
                    overflowY: "auto",
                    background: WH,
                    border: `1px solid ${BD}`,
                    borderRadius: 8,
                    boxShadow: "0 6px 18px rgba(0,0,0,.12)",
                    zIndex: 50,
                    padding: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "4px 6px 6px",
                      borderBottom: `1px solid ${BD}`,
                      marginBottom: 4,
                    }}
                  >
                    <span style={{ fontSize: 10, fontWeight: 700, color: INK3 }}>
                      {doctorFilter.size} selected
                    </span>
                    {doctorFilter.size > 0 && (
                      <button
                        onClick={() => setDoctorFilter(new Set())}
                        style={{
                          background: "none",
                          border: "none",
                          color: T,
                          fontSize: 10,
                          fontWeight: 700,
                          cursor: "pointer",
                          fontFamily: FB,
                        }}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {docChoices.length === 0 ? (
                    <div style={{ fontSize: 11, color: INK4, padding: 10, textAlign: "center" }}>
                      No doctors on today's list
                    </div>
                  ) : (
                    docChoices.map(({ name, count }) => {
                      const checked = doctorFilter.has(name);
                      return (
                        <label
                          key={name}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            borderRadius: 5,
                            cursor: "pointer",
                            fontSize: 12,
                            color: INK,
                            background: checked ? TL : "transparent",
                          }}
                          onMouseEnter={(e) => {
                            if (!checked) e.currentTarget.style.background = BG;
                          }}
                          onMouseLeave={(e) => {
                            if (!checked) e.currentTarget.style.background = "transparent";
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setDoctorFilter((prev) => {
                                const next = new Set(prev);
                                if (next.has(name)) next.delete(name);
                                else next.add(name);
                                return next;
                              });
                            }}
                            style={{ accentColor: T, cursor: "pointer" }}
                          />
                          <span style={{ flex: 1 }}>{name}</span>
                          <span
                            style={{
                              fontFamily: FM,
                              fontSize: 10,
                              fontWeight: 700,
                              color: INK3,
                              background: BG,
                              padding: "1px 7px",
                              borderRadius: 10,
                              border: `1px solid ${BD}`,
                              minWidth: 22,
                              textAlign: "center",
                            }}
                          >
                            {count}
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              )}
            </div>
            {/* Upload reports */}
            <button
              onClick={openGlobalUpload}
              style={{
                padding: "5px 11px",
                border: `1px solid ${LV}33`,
                borderRadius: 6,
                background: LVL,
                color: LV,
                fontSize: 11,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FB,
                whiteSpace: "nowrap",
              }}
            >
              ⬆ Upload reports
            </button>
            {onRefresh && (
              <button
                onClick={onRefresh}
                disabled={isFetching}
                style={{
                  padding: "5px 11px",
                  border: `1px solid ${BD}`,
                  borderRadius: 6,
                  background: WH,
                  color: INK2,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: isFetching ? "default" : "pointer",
                  opacity: isFetching ? 0.6 : 1,
                  fontFamily: FB,
                }}
              >
                ⟳ Refresh
              </button>
            )}
          </div>
        </div>

        {/* Pipeline funnel */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {isPending ? (
            Array.from({ length: 8 }).map((_, i) => <SkeletonPipelinePill key={i} />)
          ) : (
            <>
              <PipelinePill
                label="Total"
                sub="Appointments today"
                count={pipeline.total.length}
                tone="dim"
              />
              <PipelinePill
                label="Lab received"
                sub="From Gini Lab or uploaded"
                count={pipeline.labReceived.length}
                tone="warn"
              />
              <PipelinePill
                label="Lab processing"
                sub="Gini-Lab orders in progress"
                count={pipeline.labProcessing.length}
                tone="dim"
              />
              <PipelinePill
                label="Uploaded"
                sub="Reports uploaded"
                count={pipeline.uploaded.length}
                tone="dim"
              />
              <PipelinePill
                label="Data complete"
                sub="Can be categorised"
                count={pipeline.dataComplete.length}
                tone="ok"
              />
              <PipelinePill
                label="Assigned"
                sub="To a doctor"
                count={pipeline.assigned.length}
                tone="ok"
              />
              <PipelinePill
                label="Checked in"
                sub="In clinic"
                count={pipeline.checkedIn.length}
                tone="lv"
              />
              <PipelinePill
                label="No-show / Cancel"
                sub="Did not attend"
                count={pipeline.noShowCancel.length}
                tone="crit"
              />
            </>
          )}
        </div>
      </div>

      {/* Kanban */}
      <div
        style={{
          flex: 1,
          overflowX: "auto",
          overflowY: "hidden",
          display: "flex",
          padding: "10px 14px",
          gap: 10,
          minHeight: 0,
        }}
      >
        {isPending ? (
          view === "assign" ? (
            <>
              <SkeletonColumn accent={MG} />
              <SkeletonColumn accent={AM} />
            </>
          ) : (
            <>
              <SkeletonColumn accent={RE} />
              <SkeletonColumn accent={AM} />
              <SkeletonColumn accent="#2d9a42" />
              <SkeletonColumn accent={MG} />
              <SkeletonColumn accent={SK} />
              <SkeletonColumn accent={AM} />
              <SkeletonColumn accent={LV} />
            </>
          )
        ) : view === "assign" ? (
          <>
            <Column
              accent={MG}
              icon="✓"
              title="Assigned"
              hint="Ready for OPD"
              items={visible.filter((a) => !!a.doctor_name)}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
            <Column
              accent={AM}
              icon="⏳"
              title="Not yet assigned"
              hint="Action needed before OPD"
              items={visible.filter((a) => !a.doctor_name)}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
          </>
        ) : (
          <>
            <Column
              accent={RE}
              icon="🔴"
              title="Getting Worse"
              hint="Out of range · Dr. Bhansali leads"
              items={buckets.worse_out}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
            <Column
              accent={AM}
              icon="🟡"
              title="Getting Worse"
              hint="In range but trending up · SD leads"
              items={buckets.worse_in}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
            <Column
              accent="#2d9a42"
              icon="↑"
              title="Getting Better"
              hint="Improving · not at target yet"
              items={buckets.getting_better}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
            <Column
              accent={MG}
              icon="✅"
              title="In Control"
              hint="At target · stable regimen"
              items={buckets.in_control}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
            <Column
              accent={SK}
              icon="🧪"
              title="Lab Processing"
              hint="Gini-Lab orders in progress · awaiting / partial results"
              items={buckets.lab_processing}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
            <Column
              accent={AM}
              icon="🔎"
              title="Review"
              hint="Gini-Lab synced · no canonical value extracted yet"
              items={buckets.review}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
            <Column
              accent={LV}
              icon="🔵"
              title="No Reports"
              hint="Chase reports · send phlebotomist"
              items={buckets.no_reports}
              onAssign={(a) => setAssignAppt(a)}
              onOpen={onSelectAppt}
              onUpload={openUploadForAppt}
            />
          </>
        )}
      </div>

      {/* Upload picker (global) */}
      {pickerOpen && (
        <PatientPickerModal
          appointments={appointments}
          onPick={(a) => {
            setPickerOpen(false);
            setUploadState({ open: true, lockedAppt: a });
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* Upload modal */}
      {uploadState.open && uploadState.lockedAppt && (
        <UploadModal
          patient={uploadState.lockedAppt}
          onClose={() => setUploadState({ open: false, lockedAppt: null })}
          onSubmit={handleUploadSubmit}
        />
      )}

      {/* Assign modal */}
      {assignAppt && (
        <AssignModal
          appt={assignAppt}
          doctors={
            Array.isArray(doctors) && doctors.length > 0
              ? doctors.map((d) => (typeof d === "string" ? d : d.name)).filter(Boolean)
              : docChoices.map((d) => d.name)
          }
          onClose={() => setAssignAppt(null)}
          onConfirm={handleAssignConfirm}
        />
      )}
    </div>
  );
}
