import {
  BIO_TARGET,
  BIO_TIER,
  targetStatus,
  gapToGoal,
  classifyBiomarker,
} from "../analytics/biomarkerTargets.js";

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

const FALLBACK_TILES = ["hba1c", "fg", "tg", "ldl", "egfr", "bp"];
const EXTRA_TIER = { creatinine: 2, tc: 2, nonhdl: 2, homair: 2, vitd: 3 };

const tierOf = (key) => BIO_TIER[key] ?? EXTRA_TIER[key] ?? 3;
const isJudged = (m) => m.tier <= 2;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

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

export function classifyAll(current = {}, previous = {}) {
  const out = [];
  for (const key of Object.keys(BIO_TARGET)) {
    if (!BIO_TARGET[key]) continue;
    const marker = classifyMarker(key, current?.[key], previous?.[key]);
    if (marker) out.push(marker);
  }
  return foldBloodPressure(out);
}

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
export function pickTiles(markers, limit = 6) {
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

export function targetTextFor(key) {
  if (key === "bp") {
    return `<${BIO_TARGET.sbp.good}/${BIO_TARGET.dbp.good}`;
  }
  const t = BIO_TARGET[key];
  if (!t) return "—";
  if (t.range) return `${t.low}–${t.high}`;
  return t.lowerBetter ? `<${t.good}` : `>${t.good}`;
}

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
