// Care phase derivation — only applies to diabetes patients. Four tiers:
//
//   Phase 1 · Uncontrolled → any parameter uncontrolled or borderline
//   Phase 2 · Controlled   → all parameters controlled (first / single reading)
//   Phase 3 · Sustain      → all controlled across last 2 consecutive readings
//   Phase 4 · Maintain     → all controlled across last 3+ readings
//
// Non-diabetes patients get no phase.

// Each parameter: thresholds are [controlled-upper, borderline-upper].
// `lowerOk` means values below the controlled-upper bound are healthy (most
// metrics). BMI uses a band — handled explicitly below.
// HbA1c / FBS / LDL bands depend on the patient's category (diabetes vs.
// prediabetes vs. neither) — see `resolveBands` below.
const PARAM_DEFS = [
  {
    key: "HbA1c",
    label: "HbA1c",
    unit: "%",
    source: "lab",
    aliases: ["HbA1c", "hba1c", "A1c", "a1c"],
    bands: { controlled: 6.5, borderline: 8.0 },
  },
  {
    key: "FBS",
    label: "Fasting Glucose",
    unit: "mg/dL",
    source: "lab",
    aliases: ["FBS", "fbs", "Fasting Glucose", "FPG"],
    bands: { controlled: 100.01, borderline: 140 },
  },
  {
    key: "LDL",
    label: "LDL",
    unit: "mg/dL",
    source: "lab",
    aliases: ["LDL"],
    bands: { controlled: 100, borderline: 130 },
  },
  {
    key: "Triglycerides",
    label: "Triglycerides",
    unit: "mg/dL",
    source: "lab",
    aliases: ["Triglycerides", "TG"],
    bands: { controlled: 150, borderline: 200 },
  },
  {
    key: "BP_SYS",
    label: "BP (systolic)",
    unit: "mmHg",
    source: "vital",
    field: "bp_sys",
    bands: { controlled: 130, borderline: 140 },
  },
  {
    key: "BP_DIA",
    label: "BP (diastolic)",
    unit: "mmHg",
    source: "vital",
    field: "bp_dia",
    bands: { controlled: 80, borderline: 90 },
  },
  {
    key: "BMI",
    label: "BMI",
    unit: "kg/m²",
    source: "vital",
    field: "bmi",
    // BMI is band-based: healthy 18.5–24.9, overweight 25–29.9, obese ≥30.
    custom: (v) => {
      if (!Number.isFinite(v)) return null;
      if (v >= 18.5 && v < 25) return "controlled";
      if (v >= 25 && v < 30) return "borderline";
      return "uncontrolled";
    },
  },
];

function toNum(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}

function classify(def, value, bands) {
  if (!Number.isFinite(value)) return null;
  if (def.custom) return def.custom(value);
  const { controlled, borderline } = bands || def.bands;
  if (value < controlled) return "controlled";
  if (value < borderline) return "borderline";
  return "uncontrolled";
}

// Detect glycaemic category from the active diagnoses list. Diabetes wins
// over prediabetes when both are present (stricter LDL target, looser HbA1c).
function detectGlycaemicCategory(diagnoses) {
  const list = Array.isArray(diagnoses) ? diagnoses : [];
  let isDiabetes = false;
  let isPrediabetes = false;
  for (const d of list) {
    const id = String(d?.diagnosis_id || "").toLowerCase();
    const label = String(d?.label || "").toLowerCase();
    if (/pre.?diabet|impaired fasting|impaired glucose/.test(label)) {
      isPrediabetes = true;
      continue;
    }
    if (id === "dm2" || id === "dm1" || /diabetes|t2dm|t1dm|\bdm\b/.test(label)) {
      isDiabetes = true;
    }
  }
  if (isDiabetes) return "diabetes";
  if (isPrediabetes) return "prediabetes";
  return "none";
}

// Per-patient bands. HbA1c / FBS / LDL targets depend on whether the patient
// is diabetic, prediabetic, or neither. Everything else uses PARAM_DEFS bands.
function resolveBands(def, category) {
  if (def.key === "HbA1c") {
    if (category === "diabetes") return { controlled: 7.01, borderline: 8.0 };
    // Prediabetes / none: "below 6.5" is controlled.
    return { controlled: 6.5, borderline: 8.0 };
  }
  if (def.key === "LDL") {
    if (category === "diabetes") return { controlled: 70, borderline: 130 };
    return { controlled: 100, borderline: 130 };
  }
  return def.bands;
}

// Human-readable target string (shown in the care-phase tooltip). Mirrors
// the "controlled" cutoff in resolveBands; uses inclusive (≤) wording where
// the threshold is bumped by ε (HbA1c-diabetes, FBS) and "<" otherwise.
function targetForParam(def, category) {
  const unit = def.unit ? ` ${def.unit}` : "";
  if (def.key === "HbA1c") {
    return category === "diabetes" ? `≤ 7${unit}` : `< 6.5${unit}`;
  }
  if (def.key === "FBS") return `≤ 100${unit}`;
  if (def.key === "LDL") {
    return category === "diabetes" ? `< 70${unit}` : `< 100${unit}`;
  }
  if (def.key === "BMI") return `18.5–24.9${unit}`;
  if (def.bands) return `< ${def.bands.controlled}${unit}`;
  return null;
}

function pickLabHistory(labHistory, aliases) {
  if (!labHistory) return [];
  for (const k of aliases) {
    if (Array.isArray(labHistory[k]) && labHistory[k].length) return labHistory[k];
  }
  return [];
}

function seriesFromLab(labHistory, aliases) {
  return pickLabHistory(labHistory, aliases)
    .map((r) => ({ val: toNum(r.result ?? r.result_text), date: r.date }))
    .filter((r) => Number.isFinite(r.val) && r.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function seriesFromVitals(vitals, field) {
  if (!Array.isArray(vitals) || !vitals.length) return [];
  return vitals
    .map((v) => ({
      val: toNum(v?.[field]),
      date: v?.recorded_at || v?.recorded_date || null,
    }))
    .filter((r) => Number.isFinite(r.val) && r.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Count how many recent readings were all controlled, working back from
// newest. Stops at the first non-controlled reading.
function consecutiveControlledStreak(def, series, bands) {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    const s = classify(def, series[i].val, bands);
    if (s === "controlled") n++;
    else break;
  }
  return n;
}

const STATUS_RANK = { controlled: 0, borderline: 1, uncontrolled: 2 };

function trendForParam(def, latest, prev, bands) {
  if (!latest || !prev || !Number.isFinite(latest.val) || !Number.isFinite(prev.val)) return null;
  // BMI: "better" = closer to the healthy band centre (≈ 22).
  if (def.key === "BMI") {
    const dPrev = Math.abs(prev.val - 22);
    const dLatest = Math.abs(latest.val - 22);
    const d = +(dLatest - dPrev).toFixed(2);
    if (d <= -0.3) return "improving";
    if (d >= 0.3) return "worsening";
    return "stable";
  }
  // Everything else: lower = better.
  const d = +(latest.val - prev.val).toFixed(2);
  // Use a per-parameter "meaningful change" threshold so a 1 mg/dL LDL jiggle
  // doesn't read as worsening, but a 0.3 HbA1c shift does.
  const b = bands || def.bands;
  const eps = b ? Math.max(0.3, b.controlled * 0.03) : 0.3;
  if (d <= -eps) return "improving";
  if (d >= eps) return "worsening";
  return "stable";
}

// Four-tier phase ladder (diabetes only), worst → best:
//
//   Phase 1 · Uncontrolled → ≥ 1 parameter uncontrolled or borderline
//   Phase 2 · Controlled   → all parameters controlled (single reading)
//   Phase 3 · Sustain      → all controlled across the last 2 consecutive readings
//   Phase 4 · Maintain     → all controlled across the last 3+ readings (long-term)
function computeCarePhase({ labHistory, vitals, totalVisits = 0, diagnoses } = {}) {
  const category = detectGlycaemicCategory(diagnoses);

  // Care phase only applies to diabetes patients.
  if (category !== "diabetes") {
    return {
      carePhase: undefined,
      carePhaseBasis: "not-applicable",
      carePhaseCategory: category,
      carePhaseDrivers: [],
      carePhaseParameters: [],
    };
  }

  const parameters = [];
  for (const def of PARAM_DEFS) {
    const series =
      def.source === "lab"
        ? seriesFromLab(labHistory, def.aliases)
        : seriesFromVitals(vitals, def.field);
    if (!series.length) continue;
    const bands = resolveBands(def, category);
    const latest = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const status = classify(def, latest.val, bands);
    if (!status) continue;
    parameters.push({
      key: def.key,
      label: def.label,
      unit: def.unit,
      latest: latest.val,
      latestDate: latest.date,
      prev: prev?.val ?? null,
      prevDate: prev?.date ?? null,
      status,
      trend: trendForParam(def, latest, prev, bands),
      streak: consecutiveControlledStreak(def, series, bands),
      seriesLength: series.length,
      target: targetForParam(def, category),
    });
  }

  let carePhase;
  let carePhaseBasis;
  let drivers = [];

  if (!parameters.length) {
    carePhaseBasis = "none";
    carePhase = "No status";
  } else {
    carePhaseBasis = "clinical";

    const uncontrolledCount = parameters.filter((p) => p.status === "uncontrolled").length;
    const borderlineCount = parameters.filter((p) => p.status === "borderline").length;
    const allControlled = uncontrolledCount === 0 && borderlineCount === 0;

    if (!allControlled) {
      carePhase = "Phase 1 · Uncontrolled";
      drivers = parameters
        .filter((p) => p.status === "uncontrolled" || p.status === "borderline")
        .map((p) => p.key);
    } else {
      // Promote based on the worst (smallest) controlled-streak across params.
      const minStreak = parameters.reduce((m, p) => Math.min(m, p.streak), Infinity);
      if (minStreak >= 3) carePhase = "Phase 4 · Maintain";
      else if (minStreak >= 2) carePhase = "Phase 3 · Sustain";
      else carePhase = "Phase 2 · Controlled";
      drivers = parameters.filter((p) => p.streak === minStreak).map((p) => p.key);
    }
  }

  return {
    carePhase,
    carePhaseBasis,
    carePhaseCategory: category,
    carePhaseDrivers: drivers,
    carePhaseParameters: parameters,
  };
}

export { computeCarePhase };
