export const BIO_TIER = {
  hba1c: 1,
  sbp: 1,
  tsh: 1,
  fg: 2,
  ppbs: 2,
  ldl: 2,
  tg: 2,
  uacr: 2,
  egfr: 2,
  hdl: 2,
  weight: 3,
  bmi: 3,
  alt: 3,
  ast: 3,
  hb: 3,
  wbc: 3,
  dbp: 3,
};

export const BIO_TARGET = {
  hba1c: { good: 7, warn: 9, lowerBetter: true },
  sbp: { good: 130, warn: 140, lowerBetter: true },
  dbp: { good: 80, warn: 90, lowerBetter: true },
  fg: { good: 130, warn: 180, lowerBetter: true },
  ppbs: { good: 180, warn: 250, lowerBetter: true },
  ldl: { good: 100, warn: 130, lowerBetter: true },
  tg: { good: 150, warn: 200, lowerBetter: true },
  hdl: { good: 40, warn: 35, lowerBetter: false },
  uacr: { good: 30, warn: 300, lowerBetter: true },
  egfr: { good: 60, warn: 45, lowerBetter: false },
  tsh: { low: 0.5, high: 4.5, range: true },
  weight: null,
  bmi: { good: 25, warn: 30, lowerBetter: true },
  alt: { good: 40, warn: 80, lowerBetter: true },
  ast: { good: 40, warn: 80, lowerBetter: true },
  hb: { good: 12, warn: 10, lowerBetter: false },
  wbc: { good: 11000, warn: 13000, lowerBetter: true },
};

export const ANALYTICS_EXTRA_TARGETS = {
  nonhdl: { good: 130, warn: 160, lowerBetter: true },
  tc: { good: 200, warn: 240, lowerBetter: true },
  homair: { good: 2.5, warn: 4, lowerBetter: true },
  vitd: { good: 30, warn: 20, lowerBetter: false },
  creatinine: { good: 1.2, warn: 1.5, lowerBetter: true },
};

Object.assign(BIO_TARGET, ANALYTICS_EXTRA_TARGETS);

export const EXTRA_TARGET_KEYS = Object.keys(ANALYTICS_EXTRA_TARGETS);

export const STABILITY = {
  hba1c: 0.3,
  sbp: 5,
  dbp: 5,
  tsh: 0.5,
  fg: 15,
  ppbs: 20,
  ldl: 10,
  tg: 20,
  uacr: 10,
  egfr: 5,
  hdl: 3,
  weight: 1,
  bmi: 0.5,
  nonhdl: 10,
  tc: 15,
  homair: 0.5,
  vitd: 5,
  creatinine: 0.15,
  waist: 2,
  bodyfat: 1,
  hb: 0.5,
};

export function targetStatus(key, value) {
  if (value == null || isNaN(value)) return "unknown";
  const t = BIO_TARGET[key];
  if (!t) return "unknown";
  if (t.range) {
    if (value >= t.low && value <= t.high) return "good";
    const buf = (t.high - t.low) * 0.5;
    if (value >= t.low - buf && value <= t.high + buf) return "warn";
    return "bad";
  }
  if (t.lowerBetter) {
    if (value <= t.good) return "good";
    if (value <= t.warn) return "warn";
    return "bad";
  }
  if (value >= t.good) return "good";
  if (value >= t.warn) return "warn";
  return "bad";
}

const ZONE_RANK = { good: 0, warn: 1, bad: 2 };

export function classifyBiomarker(key, cur, prev) {
  if (cur == null || prev == null || isNaN(cur) || isNaN(prev)) return "unknown";
  const diff = cur - prev;
  const absStab = STABILITY[key];
  const withinStability =
    absStab != null ? Math.abs(diff) <= absStab : Math.abs(diff / prev) * 100 <= 5;
  const t = BIO_TARGET[key];

  if (t) {
    const curStatus = targetStatus(key, cur);
    const prevStatus = targetStatus(key, prev);
    if (curStatus !== "unknown" && prevStatus !== "unknown" && curStatus !== prevStatus) {
      const curRank = ZONE_RANK[curStatus];
      const prevRank = ZONE_RANK[prevStatus];
      if (curRank > prevRank) return "worse";
      if (curRank < prevRank) return "better";
    }
    if (curStatus === "good" && prevStatus === "good") return "stable";
  }

  if (withinStability) return "stable";

  if (t && t.range) {
    const mid = (t.low + t.high) / 2;
    return Math.abs(cur - mid) < Math.abs(prev - mid) ? "better" : "worse";
  }
  const lowerBetter = t ? t.lowerBetter !== false : true;
  const down = diff < 0;
  if (lowerBetter) return down ? "better" : "worse";
  return down ? "worse" : "better";
}

export const TRAJECTORY_LABELS = {
  better: "Improving",
  stable: "Stable",
  worse: "Worsening",
  unknown: "Insufficient data",
};

export const CONTROL_LABELS = {
  good: "At goal",
  warn: "Borderline",
  bad: "Off goal",
  unknown: "Not classifiable",
};
