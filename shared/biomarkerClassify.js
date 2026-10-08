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

  if (t1Better.length > 0 && t1Worse.length > 0) {
    conflicts.push(
      `${t1Better.map((e) => e.key.toUpperCase()).join("/")} improving but ${t1Worse
        .map((e) => e.key.toUpperCase())
        .join("/")} worsening`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  if (t1Worse.length > 0) {
    reasons.push(`${t1Worse.map((e) => e.key.toUpperCase()).join(", ")} worsening`);
    return { outcome: "worse", reasons, conflicts };
  }

  if (t1Better.length > 0 && t2Worse.length > 0) {
    conflicts.push(
      `${t1Better.map((e) => e.key.toUpperCase()).join("/")} improving but ${t2Worse
        .map((e) => e.key.toUpperCase())
        .join("/")} rising — review`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  if (t1Better.length > 0 && t2Bad.length > 0 && t2Worse.length === 0) {
    conflicts.push(
      `${t2Bad.map((e) => e.key.toUpperCase()).join(", ")} outside target despite ${t1Better
        .map((e) => e.key.toUpperCase())
        .join("/")} improving`,
    );
    return { outcome: "mixed", reasons: conflicts.slice(), conflicts };
  }

  if (t1Better.length > 0 && t1Worse.length === 0) {
    reasons.push(`${t1Better.map((e) => e.key.toUpperCase()).join(", ")} improving`);
    return { outcome: "better", reasons, conflicts };
  }

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

  reasons.push("Tier-1 within stable range");
  return { outcome: "stable", reasons, conflicts };
}

export const TIER_KEYS = ["hba1c", "sbp", "dbp", "fg", "ldl", "tg", "uacr", "egfr"];

export function num(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

export function readBio(appt) {
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

export function trendInputs(appt) {
  const bio = appt.biomarkers || {};
  const prevBio = appt.prev_biomarkers || {};
  const per = {};
  for (const key of Object.keys(BIO_TIER)) {
    if (BIO_TIER[key] === 3) continue;
    const c = Number(bio[key]);
    const p = Number(prevBio[key]);
    const curV = Number.isFinite(c) ? c : null;
    const prevV = Number.isFinite(p) ? p : null;
    if (curV == null && prevV == null) continue;
    const status = curV != null && prevV != null ? classifyBiomarker(key, curV, prevV) : "unknown";
    per[key] = { cur: curV, prev: prevV, status };
  }
  if (
    per.hba1c &&
    per.hba1c.prev == null &&
    appt.prev_hba1c != null &&
    appt.prev_hba1c !== "" &&
    Number.isFinite(Number(appt.prev_hba1c))
  ) {
    per.hba1c.prev = Number(appt.prev_hba1c);
    per.hba1c.status = classifyBiomarker("hba1c", per.hba1c.cur, per.hba1c.prev);
  }
  return per;
}

export function trendOutcome(appt) {
  const per = trendInputs(appt);
  const anyTrend = Object.values(per).some((entry) => entry.status !== "unknown");
  return anyTrend ? classifyComposite(per).outcome : "single";
}

export function triageTier(appt) {
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

  const outcome = trendOutcome(appt);
  const isNew =
    (appt.visit_type || "").toLowerCase().includes("new") ||
    (appt.visit_count != null && Number(appt.visit_count) <= 1);

  if (outcome === "worse") return { tier: "red", noReports: false, outcome };
  if (outcome === "mixed") return { tier: "amber", noReports: false, outcome };

  if (outcome === "better") {
    if (hasBad) return { tier: "amber", noReports: false, outcome };
    return { tier: "green", noReports: false, outcome };
  }

  if (outcome === "stable") {
    if (hasBad) return { tier: "red", noReports: false, outcome };
    if (hasWarn) return { tier: "amber", noReports: false, outcome };
    return { tier: "green", noReports: false, outcome };
  }

  if (hasBad) return { tier: "red", noReports: false, outcome };
  if (isNew && bio.hba1c != null && bio.hba1c > 9)
    return { tier: "red", noReports: false, outcome };
  if (hasWarn) return { tier: "amber", noReports: false, outcome };
  return { tier: "green", noReports: false, outcome };
}

export const STABILITY_STATES = ["stable", "unstable", "first", "no_reports"];

export const MARKER_NAME = {
  hba1c: "HbA1c",
  sbp: "BP systolic",
  dbp: "BP diastolic",
  fg: "FBS",
  ppbs: "PPBS",
  ldl: "LDL",
  hdl: "HDL",
  tg: "TG",
  uacr: "UACR",
  egfr: "eGFR",
  tsh: "TSH",
};

const nameOf = (key) => MARKER_NAME[key] || key.toUpperCase();

export const STABILITY_RECENT_MONTHS = 6;

export function stabilityOf(appt) {
  const bio = readBio(appt);
  const present = TIER_KEYS.filter((key) => bio[key] != null);
  if (!present.length) return { stability: "no_reports", outcome: "partial", reasons: [] };
  const outcome = trendOutcome(appt);
  if (outcome === "single" || outcome === "partial")
    return { stability: "first", outcome, reasons: [] };
  const per = trendInputs(appt);
  const moved = (status) =>
    Object.entries(per)
      .filter(([, entry]) => entry.status === status)
      .map(([key, entry]) => `${nameOf(key)} ${entry.prev} → ${entry.cur}`);
  const offTarget = present.filter((key) => targetStatus(key, bio[key]) === "bad");
  const unstable =
    outcome === "worse" || outcome === "mixed" || (outcome === "stable" && offTarget.length > 0);
  const offTargetNow = [...new Set([...present, ...Object.keys(per)])]
    .filter((key) => per[key]?.status !== "worse")
    .filter((key) => targetStatus(key, bio[key] ?? per[key]?.cur) === "bad")
    .map((key) => `${nameOf(key)} ${bio[key] ?? per[key]?.cur} off target`);
  if (unstable)
    return {
      stability: "unstable",
      outcome,
      reasons: [...moved("worse"), ...offTargetNow].slice(0, 4),
    };
  return { stability: "stable", outcome, reasons: moved("better").slice(0, 4) };
}
