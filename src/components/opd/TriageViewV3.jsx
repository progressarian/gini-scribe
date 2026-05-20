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
        flex: "0 0 290px",
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
  ldl: "LDL",
  tg: "TG",
  uacr: "UACR",
  egfr: "eGFR",
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
    uploaded: [],
    dataComplete: [],
    categorised: [],
    assigned: [],
    checkedIn: [],
    noShowCancel: [],
  };
  for (const a of appts) {
    buckets.total.push(a);
    if ((a.uploaded_labs || 0) > 0 || hasAnyTier1Biomarker(a)) buckets.labReceived.push(a);
    if ((a.uploaded_labs || 0) > 0 || (a.patient_report_count || 0) > 0) buckets.uploaded.push(a);
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
function PipelinePill({ label, sub, count, active, tone, onClick }) {
  const fg =
    tone === "ok" ? MG : tone === "warn" ? AM : tone === "crit" ? RE : tone === "lv" ? LV : INK3;
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: 110,
        padding: "8px 10px",
        textAlign: "center",
        background: active ? `${fg}11` : WH,
        border: `1px solid ${active ? fg : BD}`,
        borderRadius: 9,
        cursor: "pointer",
        fontFamily: FB,
        transition: "all .15s",
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
    </button>
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
            : LV;

  // Append prev_hba1c as a fallback for the legacy field.
  const prevHba1c = num(p.hba1c) ?? num(appt.prev_hba1c);

  // Bio chips — show prev → cur where both exist, otherwise just cur.
  const bioRows = [];
  for (const k of ["hba1c", "fg", "ldl", "tg", "uacr", "egfr"]) {
    const cur = num(b[k]);
    if (cur == null) continue;
    const prev = k === "hba1c" ? prevHba1c : num(p[k]);
    const tone = targetStatus(k, cur);
    bioRows.push({ k, label: KEY_LABEL[k] || k, cur, prev, tone });
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
  const reportTone =
    bucket === "no_reports" || missing.length === REQUIRED_PANELS.length
      ? "missing"
      : missing.length === 0
        ? "ok"
        : "partial";
  const reportPal =
    reportTone === "missing"
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
      </div>

      {/* Dates */}
      <div style={{ fontSize: 9, color: INK4, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {appt.uploaded_labs_date && (
          <span>
            📅 Report added:{" "}
            <strong style={{ color: INK3 }}>
              {new Date(appt.uploaded_labs_date).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
              })}
            </strong>
          </span>
        )}
        {appt.last_visit_date && (
          <span>
            🩺 Last visit:{" "}
            <strong style={{ color: INK3 }}>
              {new Date(appt.last_visit_date).toLocaleDateString("en-IN", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </strong>
          </span>
        )}
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
                {r.prev != null && (
                  <>
                    <span style={{ opacity: 0.6, fontSize: 9 }}>{r.prev}</span>
                    <span style={{ opacity: 0.55, fontSize: 9, margin: "0 2px" }}>→</span>
                  </>
                )}
                <span style={{ fontWeight: 800 }}>{r.cur}</span>{" "}
                <span style={{ fontWeight: 600 }}>{r.label}</span>
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

      {/* Route hint */}
      {route && (
        <div style={{ fontSize: 10, color: INK3, display: "flex", gap: 5 }}>
          <span>{route}</span>
        </div>
      )}

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
          {!["seen", "completed", "no_show", "cancelled"].includes(status) && (
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
              {assigned ? "↺" : "+ Assign"}
            </button>
          )}
          {bucket === "no_reports" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onUpload(appt);
              }}
              style={{
                fontSize: 10,
                fontWeight: 700,
                padding: "4px 9px",
                borderRadius: 6,
                border: `1px solid ${LV}`,
                background: LV,
                color: WH,
                cursor: "pointer",
                fontFamily: FB,
              }}
            >
              ⬆ Upload
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
        flex: "0 0 290px",
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
  const list = (
    doctors && doctors.length > 0 ? doctors : ["Dr. Bhansali", "Dr. Beant Sidhu", "Dr. Simranpreet"]
  ).slice();
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
          boxShadow: "0 20px 50px rgba(0,0,0,.22)",
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 800, color: INK }}>
          Assign — {appt.patient_name}
        </div>
        <div style={{ fontSize: 11, color: INK3, marginTop: 3, marginBottom: 12 }}>
          Select the doctor responsible for this patient.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {list.map((d) => (
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
  const [pipelineFilter, setPipelineFilter] = useState(null); // "labReceived" | ...
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
    return appointments.map((a) => ({ ...a, __bucket: triageTierV3(a) }));
  }, [appointments]);

  const pipeline = useMemo(() => derivePipeline(enriched), [enriched]);

  // Apply chip filters → produce visible appointment list.
  const visible = useMemo(() => {
    let arr = enriched;
    if (pipelineFilter) arr = pipeline[pipelineFilter] || [];
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
  }, [enriched, pipeline, pipelineFilter, categoryFilter, doctorFilter, searchQ]);

  const buckets = useMemo(() => {
    const out = { worse_out: [], worse_in: [], getting_better: [], in_control: [], no_reports: [] };
    for (const a of visible) {
      if (out[a.__bucket]) out[a.__bucket].push(a);
    }
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
                active={!pipelineFilter}
                tone="dim"
                onClick={() => setPipelineFilter(null)}
              />
              <PipelinePill
                label="Lab received"
                sub="From Gini Lab or uploaded"
                count={pipeline.labReceived.length}
                active={pipelineFilter === "labReceived"}
                tone="warn"
                onClick={() =>
                  setPipelineFilter(pipelineFilter === "labReceived" ? null : "labReceived")
                }
              />
              <PipelinePill
                label="Uploaded"
                sub="Reports uploaded"
                count={pipeline.uploaded.length}
                active={pipelineFilter === "uploaded"}
                tone="dim"
                onClick={() => setPipelineFilter(pipelineFilter === "uploaded" ? null : "uploaded")}
              />
              <PipelinePill
                label="Data complete"
                sub="Can be categorised"
                count={pipeline.dataComplete.length}
                active={pipelineFilter === "dataComplete"}
                tone="ok"
                onClick={() =>
                  setPipelineFilter(pipelineFilter === "dataComplete" ? null : "dataComplete")
                }
              />
              <PipelinePill
                label="Categorised"
                sub="Triaged"
                count={pipeline.categorised.length}
                active={pipelineFilter === "categorised"}
                tone="ok"
                onClick={() =>
                  setPipelineFilter(pipelineFilter === "categorised" ? null : "categorised")
                }
              />
              <PipelinePill
                label="Assigned"
                sub="To a doctor"
                count={pipeline.assigned.length}
                active={pipelineFilter === "assigned"}
                tone="ok"
                onClick={() => setPipelineFilter(pipelineFilter === "assigned" ? null : "assigned")}
              />
              <PipelinePill
                label="Checked in"
                sub="In clinic"
                count={pipeline.checkedIn.length}
                active={pipelineFilter === "checkedIn"}
                tone="lv"
                onClick={() =>
                  setPipelineFilter(pipelineFilter === "checkedIn" ? null : "checkedIn")
                }
              />
              <PipelinePill
                label="No-show / Cancel"
                sub="Did not attend"
                count={pipeline.noShowCancel.length}
                active={pipelineFilter === "noShowCancel"}
                tone="crit"
                onClick={() =>
                  setPipelineFilter(pipelineFilter === "noShowCancel" ? null : "noShowCancel")
                }
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
          doctors={docChoices.map((d) => d.name)}
          onClose={() => setAssignAppt(null)}
          onConfirm={handleAssignConfirm}
        />
      )}
    </div>
  );
}
