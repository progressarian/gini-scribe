export const TRENDS_CSS = `
.rx-bio-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:4px}
.rx-bio-section{}
.rx-bio{background:var(--bg);border-radius:8px;padding:10px 12px;border:1px solid var(--bd);break-inside:avoid}
.rx-bio-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}
.rx-bio-name{font-size:10px;font-weight:700;color:var(--ink3);text-transform:uppercase;letter-spacing:.04em}
.rx-bio-goal{font-size:9px;color:var(--ink3);font-weight:600}
.rx-bio-val{font-family:var(--fm);font-size:18px;font-weight:600;line-height:1.1}
.rx-bio-trend{font-size:10px;margin-top:2px;font-weight:600}
.rx-bio-trend .arrow{font-weight:700;margin-right:2px}
.rx-bio-chart{margin-top:8px;padding-top:14px;border-top:1px dashed var(--bd2)}
.rx-bio-sparkline{display:flex;gap:6px;align-items:flex-end;height:38px;position:relative}
.sp-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;position:relative;z-index:1}
.sp-val{font-family:var(--fm);font-size:8.5px;font-weight:600;color:var(--ink2);position:absolute;top:-12px;white-space:nowrap}
.sp-bar{width:100%;max-width:14px;border-radius:2px 2px 0 0;min-height:3px}
.sp-col.latest .sp-val{color:var(--ink);font-weight:700}
.sp-col.latest .sp-bar{box-shadow:0 0 0 1.5px var(--nv)}
.sp-goal{position:absolute;left:0;right:0;height:0;border-top:1px dashed #1a233266;z-index:0;pointer-events:none}
.sp-goal-tag{position:absolute;right:-2px;top:-7px;font-family:var(--fm);font-size:7.5px;font-weight:700;color:var(--ink2);background:var(--bg);padding:0 3px;border-radius:2px;letter-spacing:.02em}
.sp-trend-svg{position:absolute;left:0;right:0;top:0;bottom:0;width:100%;height:100%;z-index:0;pointer-events:none;overflow:visible}
.sp-dates{display:flex;gap:6px;margin-top:3px}
.sp-date{flex:1;text-align:center;font-family:var(--fm);font-size:7.5px;font-weight:500;color:var(--ink3);white-space:nowrap;letter-spacing:0}
.sp-dates .sp-date.latest{color:var(--ink);font-weight:700}
`;

const fmtSparkDate = (d) => {
  if (!d) return "";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  return t.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};

const SAME_REPORT_DAYS = 3;
const dayNumber = (d) => Math.floor(new Date(d).getTime() / 86400000);

const sameReadingOnce = (entries) =>
  entries.reduce((kept, e) => {
    const prev = kept[kept.length - 1];
    const repeat =
      prev &&
      prev.value === e.value &&
      Math.abs(dayNumber(e.date) - dayNumber(prev.date)) <= SAME_REPORT_DAYS;
    return repeat ? kept : [...kept, e];
  }, []);

const buildSparkline = (history, goal, lowerBetter = true) => {
  if (!history || history.length === 0) return { bars: [], goalPct: null };
  const entries = sameReadingOnce(
    [...history]
      .reverse()
      .map((h) => ({ value: Number(h.result ?? h.value), date: h.date || h.test_date }))
      .filter((e) => !Number.isNaN(e.value)),
  ).slice(-4);
  if (entries.length === 0) return { bars: [], goalPct: null };
  const vals = entries.map((e) => e.value);
  const min = Math.min(...vals, goal != null ? goal : Infinity);
  const max = Math.max(...vals, goal != null ? goal : -Infinity);
  const span = Math.max(max - min, max * 0.15, 1);
  const heightPct = (v) => Math.max(20, Math.round(((v - min) / span) * 80) + 20);
  const bars = entries.map((e) => {
    let bg = "#d97a0a";
    if (goal != null) {
      const onTarget = lowerBetter ? e.value <= goal : e.value >= goal;
      const wayOff = lowerBetter ? e.value > goal * 1.3 : e.value < goal * 0.7;
      bg = onTarget ? "#15803d" : wayOff ? "#d94f4f" : "#d97a0a";
    }
    return {
      height: heightPct(e.value),
      bg,
      value: e.value,
      date: e.date,
      dateLabel: fmtSparkDate(e.date),
    };
  });
  const goalPct = goal != null ? Math.max(0, Math.min(100, heightPct(goal))) : null;
  return { bars, goalPct };
};

const firstReading = (history) => {
  if (!history || history.length < 2) return null;
  return history[history.length - 1];
};

export function biomarkerTrendsHtml(
  {
    activeDx = [],
    labResults = [],
    labHistory = {},
    latestVitals = {},
    prevVitals = {},
    vitalsHistory = [],
  },
  { findLatest, findHist, valueColor, escape },
) {
  const hba1c = findLatest(labResults, "hba1c");
  const fbs = findLatest(labResults, "fbs");
  const ldl = findLatest(labResults, "ldl");
  const tg = findLatest(labResults, "triglycerides");
  const creatinine = findLatest(labResults, "creatinine");
  const uacr = findLatest(labResults, "uacr");
  const tsh = findLatest(labResults, "tsh");
  const egfr = findLatest(labResults, "egfr");
  const alt = findLatest(labResults, "alt");
  const dxText = (activeDx || [])
    .filter((d) => d && d.is_active !== false)
    .map((d) => `${d.diagnosis_id || ""} ${d.label || ""}`.toLowerCase())
    .join(" | ");
  const has = (words) => words.some((w) => dxText.includes(w));
  const dx = {
    diabetes: has(["diabetes", "dm1", "dm2", "t1dm", "t2dm", "prediabetes", "hyperglycemia"]),
    htn: has(["hypertension", "htn", "hypertensive"]),
    cad: has(["cad", "coronary", "ihd", "cvd", "cva", "atherosclero"]),
    ckd: has(["ckd", "kidney", "renal", "nephropathy", "albuminuria"]),
    lipid: has(["dyslipid", "hyperlipid", "cholesterol", "lipid"]),
    thyroid: has(["thyroid", "hypothyroid", "hyperthyroid", "hashimoto", "graves", "goiter"]),
    obesity: has(["obesity", "obese", "overweight", "adiposity", "metabolic syndrome"]),
    liver: has(["nafld", "masld", "fatty liver", "hepatitis", "cirrhosis"]),
  };

  const vitalsHistFor = (field) => {
    if (!Array.isArray(vitalsHistory) || vitalsHistory.length === 0) return [];
    return vitalsHistory
      .filter((v) => v && v[field] != null && v[field] !== "")
      .map((v) => ({ result: Number(v[field]), date: v.recorded_at }))
      .filter((v) => !Number.isNaN(v.result));
  };

  const weightHist = vitalsHistFor("weight");
  const waistHist = vitalsHistFor("waist");

  const candidates = [
    hba1c && {
      label: "HbA1c (%)",
      val: hba1c.result,
      sparks: buildSparkline(findHist(labHistory, "hba1c"), 7.0, true),
      goal: 7.0,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "hba1c")),
      tracks: ["diabetes"],
      defaultOrder: 1,
    },
    fbs && {
      label: "FPG (mg/dL)",
      val: fbs.result,
      sparks: buildSparkline(findHist(labHistory, "fbs"), 100, true),
      goal: 100,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "fbs")),
      tracks: ["diabetes"],
      defaultOrder: 2,
    },
    latestVitals?.bp_sys && {
      label: "BP (mmHg)",
      val: `${latestVitals.bp_sys}/${latestVitals.bp_dia}`,
      raw: latestVitals.bp_sys,
      sparks: prevVitals?.bp_sys
        ? buildSparkline(
            [{ result: prevVitals.bp_sys }, { result: latestVitals.bp_sys }],
            130,
            true,
          )
        : { bars: [], goalPct: null },
      goal: 130,
      lowerBetter: true,
      tracks: ["htn", "cad", "ckd"],
      defaultOrder: 3,
    },
    ldl && {
      label: "LDL (mg/dL)",
      val: ldl.result,
      sparks: buildSparkline(findHist(labHistory, "ldl"), 100, true),
      goal: 100,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "ldl")),
      tracks: ["lipid", "cad"],
      defaultOrder: 4,
    },
    tg && {
      label: "TG (mg/dL)",
      val: tg.result,
      sparks: buildSparkline(findHist(labHistory, "triglycerides"), 150, true),
      goal: 150,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "triglycerides")),
      tracks: ["lipid", "cad"],
      defaultOrder: 5,
    },
    egfr && {
      label: "eGFR (mL/min)",
      val: egfr.result,
      sparks: buildSparkline(findHist(labHistory, "egfr"), 90, false),
      goal: 90,
      lowerBetter: false,
      first: firstReading(findHist(labHistory, "egfr")),
      tracks: ["ckd"],
      defaultOrder: 6,
    },
    creatinine && {
      label: "Creatinine",
      val: creatinine.result,
      sparks: buildSparkline(findHist(labHistory, "creatinine"), null, true),
      lowerBetter: true,
      tracks: ["ckd"],
      defaultOrder: 7,
    },
    uacr && {
      label: "UACR (mg/g)",
      val: uacr.result,
      sparks: buildSparkline(findHist(labHistory, "uacr"), 30, true),
      goal: 30,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "uacr")),
      tracks: ["ckd", "diabetes"],
      defaultOrder: 8,
    },
    tsh && {
      label: "TSH (µIU/mL)",
      val: tsh.result,
      sparks: buildSparkline(findHist(labHistory, "tsh"), 4.5, true),
      goal: 4.5,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "tsh")),
      tracks: ["thyroid"],
      defaultOrder: 9,
    },
    alt && {
      label: "ALT (U/L)",
      val: alt.result,
      sparks: buildSparkline(findHist(labHistory, "alt"), 40, true),
      goal: 40,
      lowerBetter: true,
      first: firstReading(findHist(labHistory, "alt")),
      tracks: ["liver", "obesity"],
      defaultOrder: 10,
    },
    latestVitals?.weight && {
      label: "Weight (kg)",
      val: latestVitals.weight,
      sparks: buildSparkline(weightHist, null, true),
      lowerBetter: true,
      first: firstReading(weightHist),
      tracks: ["obesity", "diabetes"],
      defaultOrder: 11,
    },
    latestVitals?.waist && {
      label: "Waist (cm)",
      val: latestVitals.waist,
      sparks: buildSparkline(waistHist, 90, true),
      goal: 90,
      lowerBetter: true,
      first: firstReading(waistHist),
      tracks: ["obesity"],
      defaultOrder: 12,
    },
    latestVitals?.bmi && {
      label: "BMI",
      val: latestVitals.bmi,
      sparks: buildSparkline(vitalsHistFor("bmi"), 25, true),
      goal: 25,
      lowerBetter: true,
      first: firstReading(vitalsHistFor("bmi")),
      tracks: ["obesity", "diabetes"],
      defaultOrder: 13,
    },
  ].filter(Boolean);

  const relevance = (c) => ((c.tracks || []).some((t) => dx[t]) ? 1 : 0);
  const biomarkerCards = candidates
    .map((c, i) => ({ ...c, _r: relevance(c), _i: i }))
    .sort((a, b) => b._r - a._r || a.defaultOrder - b.defaultOrder)
    .slice(0, 6);

  const fmtBioNum = (v) => {
    if (v == null || Number.isNaN(Number(v))) return String(v ?? "");
    const n = Number(v);
    if (Number.isInteger(n)) return String(n);
    return Number(n.toFixed(1)).toString();
  };
  const bioHtml = biomarkerCards
    .map((b) => {
      const numVal = b.raw != null ? b.raw : parseFloat(b.val);
      const color = valueColor(numVal, b.goal, b.lowerBetter);
      let trendText = "";
      let trendColor = "#6b7d90";
      if (b.first?.result != null) {
        const f = Number(b.first.result);
        const c = Number(numVal);
        if (!Number.isNaN(f) && !Number.isNaN(c) && f !== c) {
          const improving = b.lowerBetter ? c < f : c > f;
          const arrow = c < f ? "↓" : "↑";
          trendText = `<span class="arrow">${arrow}</span>from ${fmtBioNum(f)} at first visit`;
          trendColor = improving ? "#15803d" : "#d94f4f";
        }
      } else if (b.goal != null && !Number.isNaN(Number(numVal))) {
        const onTarget = b.lowerBetter ? numVal <= b.goal : numVal >= b.goal;
        trendText = onTarget ? "● at target" : "● needs work";
        trendColor = onTarget ? "#15803d" : "#d94f4f";
      }
      const sparkObj = b.sparks || {};
      const bars = Array.isArray(sparkObj) ? sparkObj : sparkObj.bars || [];
      const goalPct = Array.isArray(sparkObj) ? null : sparkObj.goalPct;
      const sparksHtml = bars
        .map((s, i) => {
          const isLatest = i === bars.length - 1;
          return `<div class="sp-col${isLatest ? " latest" : ""}">
            <div class="sp-val">${escape(fmtBioNum(s.value))}</div>
            <div class="sp-bar" style="height:${s.height}%;background:${s.bg}"></div>
          </div>`;
        })
        .join("");
      let trendSvg = "";
      if (bars.length >= 2) {
        const stepX = 100 / bars.length;
        const points = bars.map((s, i) => `${(i + 0.5) * stepX},${100 - s.height}`).join(" ");
        trendSvg = `<svg class="sp-trend-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polyline points="${points}" fill="none" stroke="#1a2332" stroke-opacity="0.45" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
        </svg>`;
      }
      const goalLineHtml =
        goalPct != null && bars.length > 0
          ? `<div class="sp-goal" style="bottom:${goalPct}%"><span class="sp-goal-tag">${b.lowerBetter ? "≤" : "≥"} ${escape(fmtBioNum(b.goal))}</span></div>`
          : "";
      const datesHtml =
        bars.length > 0
          ? `<div class="sp-dates">${bars
              .map(
                (s, i) =>
                  `<div class="sp-date${i === bars.length - 1 ? " latest" : ""}">${escape(s.dateLabel || "")}</div>`,
              )
              .join("")}</div>`
          : "";
      const goalLabel =
        b.goal != null
          ? `<span class="rx-bio-goal">Goal ${b.lowerBetter ? "≤" : "≥"} ${escape(fmtBioNum(b.goal))}</span>`
          : "";
      return `
        <div class="rx-bio">
          <div class="rx-bio-head">
            <span class="rx-bio-name">${escape(b.label)}</span>
            ${goalLabel}
          </div>
          <div class="rx-bio-val" style="color:${color}">${escape(b.val)}</div>
          ${trendText ? `<div class="rx-bio-trend" style="color:${trendColor}">${trendText}</div>` : ""}
          ${
            sparksHtml
              ? `<div class="rx-bio-chart">
                  <div class="rx-bio-sparkline">
                    ${trendSvg}
                    ${goalLineHtml}
                    ${sparksHtml}
                  </div>
                  ${datesHtml}
                </div>`
              : ""
          }
        </div>`;
    })
    .join("");

  if (biomarkerCards.length === 0) return "";
  return `<div class="rx-bio-section"><div class="rx-section-title">Biomarker trends — last 4 visits</div>
           <div class="rx-bio-grid">${bioHtml}</div></div>`;
}
