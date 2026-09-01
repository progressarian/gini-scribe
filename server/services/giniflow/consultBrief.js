import {
  BIO_TARGET,
  BIO_TIER,
  targetStatus,
  gapToGoal,
  classifyBiomarker,
} from "../analytics/biomarkerTargets.js";

// The consultant's brief: what is in control, what got worse, what to watch —
// and which six numbers deserve the tiles at the top of the screen.
//
// docs/gini-flow/13-CONSULTANT-STATION-PLAN.md §6.2, §6.3, §15.
//
// PLAN CORRECTION. The plan said targets come from `giniflow_test_catalog`.
// They do not: that table holds prices and nothing else. The hospital's clinical
// targets already live in `server/services/analytics/biomarkerTargets.js` —
// BIO_TARGET (good/warn bands per marker), BIO_TIER (headline vs supporting),
// STABILITY (how much movement counts as movement) — and the outcomes reporting
// has been classifying patients against them for months. This module reads that
// one, so the consult screen and the analytics report can never disagree about
// whether a patient is at target.

// The keys `appointments.biomarkers` uses, which is what the MO station's chips
// and the board's category already read.
export const MARKER_LABEL = {
  hba1c: { label: "HbA1c", unit: "%" },
  fg: { label: "FBS", unit: "mg/dL" },
  ppbs: { label: "Post-meal", unit: "mg/dL" },
  tg: { label: "Triglycerides", unit: "mg/dL" },
  ldl: { label: "LDL", unit: "mg/dL" },
  hdl: { label: "HDL", unit: "mg/dL" },
  tc: { label: "Total cholesterol", unit: "mg/dL" },
  egfr: { label: "eGFR", unit: "mL/min" },
  creatinine: { label: "Creatinine", unit: "mg/dL" },
  uacr: { label: "UACR", unit: "mg/g" },
  tsh: { label: "TSH", unit: "mIU/L" },
  sbp: { label: "BP", unit: "mmHg" },
  dbp: { label: "BP (diastolic)", unit: "mmHg" },
  // The folded pair (foldBloodPressure), which is what the screen actually shows.
  bp: { label: "BP", unit: "mmHg" },
  weight: { label: "Weight", unit: "kg" },
  bmi: { label: "BMI", unit: "" },
  alt: { label: "ALT", unit: "U/L" },
  ast: { label: "AST", unit: "U/L" },
  hb: { label: "Haemoglobin", unit: "g/dL" },
  vitd: { label: "Vitamin D", unit: "ng/mL" },
  homair: { label: "HOMA-IR", unit: "" },
};

// The prototype's six, used when a patient has too little history to rank.
const FALLBACK_TILES = ["hba1c", "fg", "tg", "ldl", "egfr", "bp"];

// BIO_TIER has no entry for the markers ANALYTICS_EXTRA_TARGETS added, so they
// would all default to tier 3 — "monitored only" — and drop out of the counts.
// Creatinine belongs beside eGFR, not beside weight; the prototype's "4 in
// control" includes it. Tiers are set here rather than in the shared file so the
// outcomes report's own tier model is left exactly as it is.
const EXTRA_TIER = { creatinine: 2, tc: 2, nonhdl: 2, homair: 2, vitd: 3 };

const tierOf = (key) => BIO_TIER[key] ?? EXTRA_TIER[key] ?? 3;

// Tier 3 is monitored, not judged: weight, BMI, ALT, Hb move for a dozen reasons
// and counting them as "worse" would bury the marker that actually matters. They
// stay classified and available — they are just not part of the headline count.
const isJudged = (m) => m.tier <= 2;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// `classifyBiomarker` answers "did this move, and which way" between two
// readings; `targetStatus` answers "is it at goal". A marker needs both: a value
// that improved but is still out of range is not in control, and a value that
// worsened inside the range is not a crisis. Those are the board's own
// worse_out_of_range / worse_in_range categories, one marker at a time.
export function classifyMarker(key, current, previous) {
  const cur = num(current);
  const prev = num(previous);
  if (cur === null) return null;
  const status = targetStatus(key, cur);
  const movement = prev === null ? "unknown" : classifyBiomarker(key, cur, prev);
  const gap = gapToGoal(key, cur);

  let bucket;
  if (movement === "worse") bucket = status === "good" ? "watch" : "worse";
  else if (status === "good") bucket = "in_control";
  else bucket = "watch";

  return {
    key,
    label: MARKER_LABEL[key]?.label || key,
    unit: MARKER_LABEL[key]?.unit ?? "",
    value: cur,
    previous: prev,
    delta: prev === null ? null : Number((cur - prev).toFixed(2)),
    status,
    movement,
    gapToGoal: gap,
    bucket,
    tier: tierOf(key),
  };
}

// The prototype reads "BP today 143/90" — one number a doctor thinks in, not two
// rows. Systolic and diastolic are classified separately (they have separate
// targets) and then folded, taking the worse of the two: 143/85 is still a high
// BP, and showing it as controlled because the diastolic is fine would be wrong.
function foldBloodPressure(markers) {
  const sbp = markers.find((m) => m.key === "sbp");
  const dbp = markers.find((m) => m.key === "dbp");
  if (!sbp && !dbp) return markers;
  const rest = markers.filter((m) => m.key !== "sbp" && m.key !== "dbp");
  const rank = { bad: 0, warn: 1, good: 2, unknown: 3 };
  const worst = [sbp, dbp].filter(Boolean).sort((a, b) => rank[a.status] - rank[b.status])[0];
  const bucketRank = { worse: 0, watch: 1, in_control: 2, unknown: 3 };
  const bucket = [sbp, dbp]
    .filter(Boolean)
    .sort((a, b) => bucketRank[a.bucket] - bucketRank[b.bucket])[0].bucket;

  rest.push({
    ...worst,
    key: "bp",
    label: "BP",
    unit: "mmHg",
    value: [sbp?.value, dbp?.value].filter((v) => v != null).join("/"),
    previous: [sbp?.previous, dbp?.previous].every((v) => v == null)
      ? null
      : [sbp?.previous, dbp?.previous].filter((v) => v != null).join("/"),
    delta: null,
    status: worst.status,
    movement: sbp?.movement ?? dbp?.movement,
    bucket,
    tier: 1,
  });
  return rest;
}

// Every marker this patient has a reading for, classified. `current` and
// `previous` are the biomarkers blobs the appointments carry.
export function classifyAll(current = {}, previous = {}) {
  const out = [];
  for (const key of Object.keys(BIO_TARGET)) {
    if (!BIO_TARGET[key]) continue;
    const marker = classifyMarker(key, current?.[key], previous?.[key]);
    if (marker) out.push(marker);
  }
  return foldBloodPressure(out);
}

// The header line: "✓ 4 in control · ↑ 1 worse · ⚠ 2 watch", with the markers
// named. Counting without naming gives a consultant a number they then have to
// go hunting for.
export function summarise(markers) {
  const of = (bucket) => markers.filter((m) => isJudged(m) && m.bucket === bucket);
  const name = (m) => m.label;
  const inControl = of("in_control");
  const worse = of("worse");
  const watch = of("watch");
  return {
    inControl: { count: inControl.length, markers: inControl.map(name) },
    worse: { count: worse.length, markers: worse.map(name) },
    watch: { count: watch.length, markers: watch.map(name) },
  };
}

// Which six numbers get the tiles (plan §15). Deterministic, so the same patient
// shows the same tiles all day: out of target first, then whichever moved most
// against its own stability threshold, then tier, then name. A patient with
// nothing to rank falls back to the prototype's six.
export function pickTiles(markers, limit = 6) {
  // Tier 3 never takes a tile from a marker the consultation is actually about.
  const pool = markers.filter(isJudged);
  const scored = [...(pool.length >= limit ? pool : markers)].sort((a, b) => {
    const outOf = (m) => (m.status === "bad" ? 0 : m.status === "warn" ? 1 : 2);
    if (outOf(a) !== outOf(b)) return outOf(a) - outOf(b);
    const moved = (m) => (m.movement === "worse" ? 0 : m.movement === "better" ? 1 : 2);
    if (moved(a) !== moved(b)) return moved(a) - moved(b);
    if (a.tier !== b.tier) return a.tier - b.tier;
    return a.label.localeCompare(b.label);
  });
  if (scored.length >= limit) return scored.slice(0, limit);

  const have = new Set(scored.map((m) => m.key));
  const padded = [...scored];
  for (const key of FALLBACK_TILES) {
    if (padded.length >= limit) break;
    if (have.has(key)) continue;
    padded.push({
      key,
      label: MARKER_LABEL[key]?.label || key,
      unit: MARKER_LABEL[key]?.unit ?? "",
      value: null,
      previous: null,
      delta: null,
      status: "unknown",
      movement: "unknown",
      bucket: "unknown",
      tier: tierOf(key),
    });
  }
  return padded;
}

// The target, in the words the row shows. `bp` is folded from two markers and so
// has no BIO_TARGET entry of its own — it reads from the pair it was folded from.
export function targetTextFor(key) {
  if (key === "bp") {
    return `<${BIO_TARGET.sbp.good}/${BIO_TARGET.dbp.good}`;
  }
  const t = BIO_TARGET[key];
  if (!t) return "—";
  if (t.range) return `${t.low}–${t.high}`;
  return t.lowerBetter ? `<${t.good}` : `>${t.good}`;
}

// The "🧪 From reports" block of Today's concerns (§6.1). One row per marker
// that is out of target or moved the wrong way, worst first, each carrying the
// evidence rather than just a colour.
export function reportConcerns(markers) {
  const notable = markers.filter(
    (m) => isJudged(m) && (m.status !== "good" || m.movement === "worse"),
  );
  const rank = { bad: 0, warn: 1, good: 2, unknown: 3 };
  notable.sort((a, b) => rank[a.status] - rank[b.status] || a.tier - b.tier);

  const rows = notable.map((m) => {
    const targetText = targetTextFor(m.key);
    const move =
      m.previous === null
        ? ""
        : m.movement === "worse"
          ? ` — up from ${m.previous}`
          : m.movement === "better"
            ? ` — down from ${m.previous}`
            : "";
    return {
      key: m.key,
      tone: m.status === "bad" ? "red" : m.status === "warn" ? "amber" : "green",
      title: `${m.label} ${m.value}${m.unit === "%" ? "%" : ""}`,
      detail: `target ${targetText}${m.unit && m.unit !== "%" ? ` ${m.unit}` : ""}${move}`,
    };
  });

  const good = markers.filter((m) => isJudged(m) && m.bucket === "in_control");
  if (good.length) {
    rows.push({
      key: "_ok",
      tone: "green",
      title: "At target",
      detail: good.map((m) => `${m.label} ${m.value}${m.unit === "%" ? "%" : ""}`).join(" · "),
    });
  }
  return rows;
}

// One call for everything the consult header and Overview need.
export function buildBrief(currentBiomarkers, previousBiomarkers) {
  const markers = classifyAll(currentBiomarkers, previousBiomarkers);
  return {
    markers,
    summary: summarise(markers),
    tiles: pickTiles(markers),
    reportConcerns: reportConcerns(markers),
  };
}
