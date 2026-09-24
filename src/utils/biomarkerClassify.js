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
  weight: 3,
  bmi: 3,
  alt: 3,
  ast: 3,
  hb: 3,
  wbc: 3,
  hdl: 2,
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
  // higher is better
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

  // 1) Zone crossing wins over everything — clinical zone change is what the
  //    care team needs to see, even if the absolute delta is small.
  if (t) {
    const curStatus = targetStatus(key, cur);
    const prevStatus = targetStatus(key, prev);
    if (curStatus !== "unknown" && prevStatus !== "unknown" && curStatus !== prevStatus) {
      const curRank = ZONE_RANK[curStatus];
      const prevRank = ZONE_RANK[prevStatus];
      if (curRank > prevRank) return "worse"; // good→warn, warn→bad, good→bad
      if (curRank < prevRank) return "better"; // bad→warn, warn→good, bad→good
    }
    // 2) Same zone, both 'good' → stable (ignore within-target jitter).
    if (curStatus === "good" && prevStatus === "good") return "stable";
  }

  if (withinStability) return "stable";

  if (t && t.range) {
    // For range markers any non-good movement still uses midpoint distance.
    const mid = (t.low + t.high) / 2;
    return Math.abs(cur - mid) < Math.abs(prev - mid) ? "better" : "worse";
  }
  const lowerBetter = t ? t.lowerBetter !== false : true;
  const down = diff < 0;
  if (lowerBetter) return down ? "better" : "worse";
  return down ? "worse" : "better";
}

export function classifyComposite(perBiomarker) {
  const reasons = [];
  const conflicts = [];

  const tier1 = [];
  const tier2 = [];
  for (const [key, v] of Object.entries(perBiomarker || {})) {
    if (!v) continue;
    const status = v.status || classifyBiomarker(key, v.cur, v.prev);
    const tgt = v.target || targetStatus(key, v.cur);
    const entry = { key, status, target: tgt, cur: v.cur, prev: v.prev };
    if (BIO_TIER[key] === 1) tier1.push(entry);
    else if (BIO_TIER[key] === 2) tier2.push(entry);
  }

  const trendable1 = tier1.filter((e) => e.status !== "unknown");
  if (trendable1.length === 0) {
    return { outcome: "partial", reasons: ["No prior Tier-1 reading"], conflicts };
  }

  const t1Better = trendable1.filter((e) => e.status === "better");
  const t1Worse = trendable1.filter((e) => e.status === "worse");
  const t1Stable = trendable1.filter((e) => e.status === "stable");

  const t2Worse = tier2.filter((e) => e.status === "worse");
  const t2Bad = tier2.filter((e) => e.target === "bad");

  // Both directions in Tier 1 → mixed
  if (t1Better.length > 0 && t1Worse.length > 0) {
    conflicts.push(
      `${t1Better.map((e) => e.key.toUpperCase()).join("/")} improving but ${t1Worse
        .map((e) => e.key.toUpperCase())
        .join("/")} worsening`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  // Any Tier 1 worsening → worse
  if (t1Worse.length > 0) {
    reasons.push(`${t1Worse.map((e) => e.key.toUpperCase()).join(", ")} worsening`);
    return { outcome: "worse", reasons, conflicts };
  }

  // Tier 1 better, but Tier 2 worsening → mixed (the clinical conflict case)
  if (t1Better.length > 0 && t2Worse.length > 0) {
    conflicts.push(
      `${t1Better.map((e) => e.key.toUpperCase()).join("/")} improving but ${t2Worse
        .map((e) => e.key.toUpperCase())
        .join("/")} rising — review`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  // Tier 1 better/stable but a Tier 2 has crossed into bad range → mixed-flag
  if (t1Better.length > 0 && t2Bad.length > 0 && t2Worse.length === 0) {
    conflicts.push(
      `${t2Bad.map((e) => e.key.toUpperCase()).join(", ")} outside target despite ${t1Better
        .map((e) => e.key.toUpperCase())
        .join("/")} improving`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  // All Tier 1 better, no Tier 2 issue → better
  if (t1Better.length > 0 && t1Worse.length === 0) {
    reasons.push(`${t1Better.map((e) => e.key.toUpperCase()).join(", ")} improving`);
    return { outcome: "better", reasons, conflicts };
  }

  // All Tier 1 stable, Tier 2 worsening → mixed (deterioration warning)
  if (t1Stable.length > 0 && t2Worse.length > 0) {
    conflicts.push(
      `Tier-1 stable but ${t2Worse.map((e) => e.key.toUpperCase()).join("/")} worsening`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  if (t1Stable.length > 0 && t2Bad.length > 0) {
    conflicts.push(
      `Tier-1 stable but ${t2Bad.map((e) => e.key.toUpperCase()).join(", ")} outside target`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  // Default: all Tier 1 stable
  reasons.push("Tier-1 within stable range");
  return { outcome: "stable", reasons, conflicts };
}

// Convenience: chip background colour from targetStatus
export const CHIP_COLOURS = {
  good: { bg: "#edfcf0", fg: "#15803d", border: "#bbf2c8" },
  warn: { bg: "#fef6e6", fg: "#d97a0a", border: "#f6dca7" },
  bad: { bg: "#fdf0f0", fg: "#d94f4f", border: "#f4c2c2" },
  unknown: { bg: "#f5f7fa", fg: "#6b7d90", border: "#dde3ea" },
};
