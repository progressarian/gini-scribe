import { PALETTE } from "./theme.js";

const esc = (v) =>
  String(v ?? "—").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const num = (v) => (v == null ? "—" : Number(v).toLocaleString("en-IN"));
const fixed = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));
const signed = (v, d = 2) =>
  v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`;
const longDate = (iso, withDay = true) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-GB", {
        ...(withDay ? { day: "numeric" } : {}),
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
const pctOf = (s) => (s && s.d ? `${fixed(s.pct, 1)}%` : "—");
const nOf = (s) => (s && s.d != null ? `${num(s.n)} / ${num(s.d)}` : "—");

const ciText = (ci, unit = "") =>
  ci ? `95% CI ${signedOrPlain(ci[0], unit)} to ${signedOrPlain(ci[1], unit)}` : "";
const signedOrPlain = (v, unit) =>
  unit === "%" ? `${fixed(v, 1)}%` : `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toFixed(2)}`;

const cell = (s) =>
  `<td class="num"><strong>${pctOf(s)}</strong><span class="nd">${nOf(s)}</span></td>`;

function css() {
  const t = (p) => `
    --surface:${p.surface};--plane:${p.plane};--ink:${p.ink};--ink2:${p.inkSecondary};
    --muted:${p.muted};--grid:${p.grid};--border:${p.border};--accent:${p.series[0]};
    --warn:${p.warning};--critical:${p.critical};`;
  return `
  :root{${t(PALETTE.light)}color-scheme:light}
  @media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${t(PALETTE.dark)}color-scheme:dark}}
  :root[data-theme="dark"]{${t(PALETTE.dark)}color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:var(--plane);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}
  h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 8px}
  .sub{color:var(--ink2);margin:0 0 16px}
  .banner{border:1px solid var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent);padding:10px 14px;border-radius:6px;margin:12px 0 20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
  .grid--tables{grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));margin-top:12px}
  .tile{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
  .tile .k{color:var(--ink2);font-size:13px}
  .tile .v{font-size:26px;font-weight:650;margin:4px 0 2px;font-variant-numeric:tabular-nums}
  .tile .d{color:var(--muted);font-size:12px}
  .scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--border);border-radius:8px}
  table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
  th,td{padding:7px 10px;border-bottom:1px solid var(--grid);text-align:left;vertical-align:top;white-space:nowrap}
  th{font-size:12px;color:var(--ink2);font-weight:600;background:var(--surface)}
  td.num,th.num{text-align:right}
  .nd{display:block;font-size:11px;color:var(--muted)}
  .press{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px;padding:12px 16px 12px 34px;margin:0}
  .press > li{margin:14px 0;line-height:1.55}
  .say{margin:0;font-size:15px}
  .say-sub{margin:2px 0 0;color:var(--ink2)}
  .how{margin:6px 0 0;font-size:12.5px;color:var(--ink2)}
  .how summary{cursor:pointer;color:var(--accent);width:max-content}
  .how ol{margin:6px 0 0;padding-left:20px}
  .how li{margin:3px 0}
  .avoid{background:var(--surface);border:1px solid var(--border);border-left:4px solid var(--critical);border-radius:8px;padding:12px 16px 12px 34px;margin:12px 0 0}
  .avoid li{margin:6px 0}
  .guide{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 16px;margin:0 0 8px}
  .guide dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;margin:6px 0 0}
  .guide dt{font-weight:600}.guide dd{margin:0;color:var(--ink2)}
  .tile .how{margin-top:8px}
  .def{color:var(--ink2);font-size:12.5px;margin:6px 0 0}
  ul.caveats{padding-left:18px;margin:6px 0}ul.caveats li{margin:4px 0}
  footer{margin-top:32px;color:var(--muted);font-size:12px}
  @media print{body{background:#fff}.scroll,.tile{break-inside:avoid}}`;
}

function how(steps) {
  return `<details class="how"><summary>How this number was counted</summary><ol>${steps.map((x) => `<li>${x}</li>`).join("")}</ol></details>`;
}

const addDays = (iso, days) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function tile(label, value, detail, steps) {
  return `<div class="tile"><div class="k">${esc(label)}</div><div class="v">${value}</div><div class="d">${detail}</div>${steps ? how(steps) : ""}</div>`;
}

function section(title, intro, steps) {
  return `<h2>${title}</h2>${intro ? `<p class="def">${intro}</p>` : ""}${steps ? how(steps) : ""}`;
}

const HEAD = {
  eligible: "Enough time had passed",
  baseline: "Had a test at first visit",
  measured: "Re-tested in this window",
  means: "Average HbA1c: first test → re-test",
  change: "Average change (points)",
  any: "Any fall",
  imp05: "Fell 0.5+ points",
  imp10: "Fell 1+ point",
  worse: "Rose 0.5+ points",
  reached: "Got below 7% (started at 7%+)",
  stayed: "Stayed below 7% (started below 7%)",
  below7: "Below 7% at re-test",
};

function windowRows(windows, keys) {
  return windows
    .filter((w) => keys.includes(w.window))
    .map((w) => {
      const o = w.outcome;
      return `<tr><th scope="row">${esc(w.label)}<span class="nd">re-test ${w.measurement_range_days[0]}–${w.measurement_range_days[1]} days after first visit; typical ${num(w.median_days_to_followup)} days</span></th>
        <td class="num">${num(w.eligible)}</td><td class="num">${num(w.with_baseline)}</td>${cell(w.measured)}
        <td class="num">${fixed(o.baseline_mean)}% → ${fixed(o.follow_mean)}%<span class="nd">middle patient ${fixed(o.baseline_median)}% → ${fixed(o.follow_median)}%</span></td>
        <td class="num"><strong>${signed(o.change_mean)}</strong><span class="nd">middle patient ${signed(o.change_median)}</span><span class="nd">${ciText(o.change_ci95)}</span></td>
        ${cell(o.any_improvement)}${cell(o.improved_05)}${cell(o.improved_10)}${cell(o.worsened_05)}
        ${cell(o.reached_below7)}${cell(o.maintained_below7)}${cell(o.below7_at_follow)}</tr>`;
    })
    .join("");
}

const WINDOW_HEAD = `<tr><th scope="col">Re-test time</th><th class="num" scope="col">${HEAD.eligible}</th><th class="num" scope="col">${HEAD.baseline}</th>
  <th class="num" scope="col">${HEAD.measured}</th><th class="num" scope="col">${HEAD.means}</th>
  <th class="num" scope="col">${HEAD.change}</th><th class="num" scope="col">${HEAD.any}</th>
  <th class="num" scope="col">${HEAD.imp05}</th><th class="num" scope="col">${HEAD.imp10}</th><th class="num" scope="col">${HEAD.worse}</th>
  <th class="num" scope="col">${HEAD.reached}</th><th class="num" scope="col">${HEAD.stayed}</th><th class="num" scope="col">${HEAD.below7}</th></tr>`;

function severityTable(window) {
  const rows = window.by_severity
    .map(
      (b) => `<tr><th scope="row">${esc(b.band)}</th><td class="num">${num(b.n)}</td>
      <td class="num">${fixed(b.baseline_mean)}% → ${fixed(b.follow_mean)}%</td>
      <td class="num"><strong>${signed(b.change_mean)}</strong><span class="nd">middle patient ${signed(b.change_median)}</span></td>
      ${cell(b.improved_05)}${cell(b.worsened_05)}${cell(b.below7_at_follow)}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table aria-label="HbA1c change by starting level at ${esc(window.label)}">
    <thead><tr><th scope="col">HbA1c at first visit</th><th class="num" scope="col">Patients re-tested</th><th class="num" scope="col">Average: first test → re-test</th>
    <th class="num" scope="col">Average change</th><th class="num" scope="col">${HEAD.imp05}</th><th class="num" scope="col">${HEAD.worse}</th><th class="num" scope="col">${HEAD.below7}</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function controlTable(c) {
  const a = c.among_complete;
  const row = (label, s) => `<tr><th scope="row">${label}</th>${cell(s)}</tr>`;
  return `<div class="scroll"><table aria-label="Latest combined control">
    <thead><tr><th scope="col">Target (using each patient's latest results)</th><th class="num" scope="col">Patients meeting it</th></tr></thead>
    <tbody>${row("HbA1c below 7%", a.hba1c_below7)}${row("Blood pressure below 130/80", a.bp_below_130_80)}${row("Blood pressure below 140/90 (looser target)", a.bp_below_140_90)}
    ${row("LDL cholesterol below 100 mg/dL", a.ldl_below100)}${row("LDL cholesterol below 70 mg/dL (stricter target)", a.ldl_below70)}
    ${row("<strong>All three: HbA1c below 7%, BP below 130/80, LDL below 100</strong>", a.all_three)}
    ${row("All three, using the looser BP target", a.all_three_bp140)}</tbody></table></div>`;
}

function treatmentTable(treatments, mode) {
  const rows = treatments
    .map((t) => {
      const parts = ["m3", "m6", "m12"].map((w) => {
        const src = mode === "new" ? t.new_start[w] : t[w];
        const a = src.hba1c;
        const wt = src.weight;
        return `<td class="num">${a.n ? `<strong>${signed(a.change_mean)}</strong> HbA1c<span class="nd">${num(a.n)} re-tested of ${num(a.with_baseline)}</span>` : `—<span class="nd">${a.eligible ? `none re-tested yet` : "too recent"}</span>`}
        ${wt.n ? `<span class="nd">weight ${signed(wt.change_mean, 1)} kg (${num(wt.n)} weighed)</span>` : ""}</td>`;
      });
      return `<tr><th scope="row">${esc(t.label)}<span class="nd">first prescribed ${longDate(t.first_start)}</span></th>
        <td class="num">${num(mode === "new" ? t.new_starts : t.started_in_period)}</td>
        ${mode === "new" ? "" : `<td class="num">${fixed(t.baseline_hba1c.mean)}%<span class="nd">${num(t.baseline_hba1c.n)} tested</span></td>`}${parts.join("")}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table aria-label="Treatment groups">
    <thead><tr><th scope="col">Medicine</th><th class="num" scope="col">Patients</th>${mode === "new" ? "" : `<th class="num" scope="col">Average HbA1c when started</th>`}
    <th class="num" scope="col">After 3 months</th><th class="num" scope="col">After 6 months</th><th class="num" scope="col">After 12 months</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function retentionTable(rows) {
  const body = rows
    .map(
      (
        r,
      ) => `<tr><th scope="row">${esc(r.enrollment_year)}</th><td class="num">${num(r.enrolled)}</td>
      ${["m3", "m6", "m12", "m24"].map((k) => (r[k].visit_in_window.d ? cell(r[k].visit_in_window) : `<td class="num">—<span class="nd">too recent</span></td>`)).join("")}</tr>`,
    )
    .join("");
  return `<div class="scroll"><table aria-label="Patients coming back, by first-visit year">
    <thead><tr><th scope="col">Year of first visit</th><th class="num" scope="col">Patients</th><th class="num" scope="col">Came back around 3 months</th>
    <th class="num" scope="col">Around 6 months</th><th class="num" scope="col">Around 12 months</th><th class="num" scope="col">Around 24 months</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function shareTable(label, head, rows) {
  return `<div class="scroll"><table aria-label="${esc(label)}"><thead><tr><th scope="col">${esc(head)}</th><th class="num" scope="col">Patients</th></tr></thead>
    <tbody>${rows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th>${cell(v)}</tr>`).join("")}</tbody></table></div>`;
}

function funnelTable(f) {
  const rows = [
    ["All diabetes patients seen in the period", { n: f.registry, d: f.registry, pct: 100 }],
    ["Came only once", f.single_visit],
    ["Had an HbA1c test at their first visit", f.with_baseline_hba1c],
    ["Had at least one HbA1c test in the period", f.with_any_hba1c_in_period],
    ["Had 2 or more HbA1c tests", f.with_two_plus_hba1c],
    ["Came 3 or more times", f.three_plus_visits],
    ["Came 3 or more times, over at least 6 months", f.three_visits_over_six_months],
  ];
  const windows = f.windows
    .map(
      (
        w,
      ) => `<tr><th scope="row">${esc(w.label)}</th><td class="num">${num(w.eligible)}</td><td class="num">${num(w.too_recent)}</td>
      <td class="num">${num(w.with_baseline)}</td>${cell(w.measured)}</tr>`,
    )
    .join("");
  return `${shareTable("Diabetes patients", "Group", rows)}
  <div class="scroll" style="margin-top:12px"><table aria-label="Who could be re-tested at each time"><thead><tr><th scope="col">Re-test time</th>
  <th class="num" scope="col">${HEAD.eligible}</th><th class="num" scope="col">Joined too recently</th><th class="num" scope="col">${HEAD.baseline}</th>
  <th class="num" scope="col">${HEAD.measured}</th></tr></thead><tbody>${windows}</tbody></table></div>`;
}

const MARKER_LABEL = {
  weight: ["Weight", "kg"],
  bmi: ["BMI", "kg/m²"],
  sbp: ["Blood pressure (top number)", "mmHg"],
  dbp: ["Blood pressure (bottom number)", "mmHg"],
  ldl: ["LDL cholesterol", "mg/dL"],
  egfr: ["Kidney function (eGFR)", "mL/min/1.73m²"],
  uacr: ["Urine protein (UACR)", "mg/g"],
};

function markerTable(markers) {
  const rows = Object.entries(markers)
    .map(([key, byWindow]) => {
      const [label, unit] = MARKER_LABEL[key];
      return `<tr><th scope="row">${label}<span class="nd">${unit}</span></th>${["m6", "m12", "m24"]
        .map((wk) => {
          const r = byWindow[wk];
          return r.n
            ? `<td class="num">${fixed(r.baseline_mean, 1)} → ${fixed(r.follow_mean, 1)}<span class="nd">average change ${signed(r.change_mean, 1)}, middle patient ${signed(r.change_median, 1)}; ${num(r.n)} re-tested of ${num(r.with_baseline)}</span></td>`
            : `<td class="num">—</td>`;
        })
        .join("")}</tr>`;
    })
    .join("");
  return `<div class="scroll"><table aria-label="Other health measures"><thead><tr><th scope="col">Measure</th><th class="num" scope="col">After 6 months</th>
    <th class="num" scope="col">After 12 months</th><th class="num" scope="col">After 24 months</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function kidneyTable(k) {
  const row = (wk, label) => {
    const u = k[wk].uacr;
    const e = k[wk].egfr;
    return `<tr><th scope="row">${label}</th>
      <td class="num">${fixed(u.median_baseline, 1)} → ${fixed(u.median_follow, 1)}<span class="nd">${num(u.measured.n)} re-tested of ${num(u.with_baseline)}</span></td>
      ${cell(u.stage_better)}${cell(u.stage_worse)}${cell(u.albuminuric_fell_30pct)}
      <td class="num">${num(e.median_baseline)} → ${num(e.median_follow)}<span class="nd">${num(e.measured.n)} re-tested of ${num(e.with_baseline)}</span></td>${cell(e.fell_30pct)}</tr>`;
  };
  return `<div class="scroll"><table aria-label="Kidney results"><thead><tr><th scope="col">Re-test time</th>
    <th class="num" scope="col">Urine protein, middle patient (mg/g)</th><th class="num" scope="col">Protein level improved</th><th class="num" scope="col">Protein level worsened</th>
    <th class="num" scope="col">Protein fell by 30%+ (those who had raised protein)</th><th class="num" scope="col">Kidney function (eGFR), middle patient</th><th class="num" scope="col">Kidney function fell by 30%+</th></tr></thead>
    <tbody>${row("m12", "After 12 months")}${row("m24", "After 24 months")}</tbody></table></div>`;
}

function combinedChangeTable(rows) {
  return `<div class="scroll"><table aria-label="All three targets over time"><thead><tr><th scope="col">Re-test time</th><th class="num" scope="col">Patients with all three tested at both times</th>
    <th class="num" scope="col">All three on target at first visit</th><th class="num" scope="col">All three on target at re-test</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><th scope="row">${r.window === "m6" ? "After 6 months" : "After 12 months"}</th><td class="num">${num(r.complete_pairs)}<span class="nd">of ${num(r.eligible)} with enough time</span></td>${cell(r.all_three_at_baseline)}${cell(r.all_three_at_follow_up)}</tr>`).join("")}
    </tbody></table></div>`;
}

function biasTable(cmp, label) {
  const r = (k, f) =>
    `<tr><th scope="row">${k}</th><td class="num">${f(cmp.measured)}</td><td class="num">${f(cmp.not_measured)}</td></tr>`;
  return `<div class="scroll"><table aria-label="Re-tested versus not re-tested at ${label}">
    <thead><tr><th scope="col">At first visit (${label} group)</th><th class="num" scope="col">Came back and re-tested</th><th class="num" scope="col">Not re-tested</th></tr></thead>
    <tbody>${r("Patients", (g) => num(g.n))}${r("Average age", (g) => fixed(g.mean_age, 1))}${r("Women", (g) => pctOf(g.female))}
    ${r("Average HbA1c at first visit", (g) => `${fixed(g.mean_baseline_hba1c)}%`)}${r("Visits (middle patient)", (g) => num(g.median_visits))}${r("Type 1 / LADA", (g) => pctOf(g.type1))}</tbody></table></div>`;
}

function allPatientsSection(all, dmRegistry) {
  if (!all) {
    return `<h2>All patients seen at Gini</h2><p class="def">Not built yet. Run <code>node server/scripts/build-all-patients.mjs --out=&lt;this folder&gt;</code> when the database is quiet.</p>`;
  }
  const m = all.meta;
  const newPts = all.new_patients_2025_26;
  return `${section(
    "All patients seen at Gini (not only diabetes)",
    `Everyone with at least one visit between ${longDate(m.period.start)} and ${longDate(m.period.end)}, whatever their condition. Diabetes patients are ${pctOf({ n: dmRegistry, d: all.total_seen, pct: (dmRegistry / all.total_seen) * 100 })} of them. Data taken ${longDate(m.generated_at)}.`,
    [
      `Scribe holds ${num(m.patients_in_scribe)} patient records in total`,
      `${num(all.never_seen_in_period)} had no visit in the period (no consultation and no attended appointment), so they are left out`,
      `${num(m.duplicate_records_merged)} duplicate records of the same person (same name and date of birth) were merged`,
      `= <strong>${num(all.total_seen)} people seen</strong>`,
      `Scribe has records from 2022 and full appointment data from January 2025, so this is not Gini's lifetime patient count in HealthRay`,
    ],
  )}
  <div class="grid">
    ${tile("People seen", num(all.total_seen), `at least one visit in the period`)}
    ${tile("New patients in 2025–26", num(newPts.n), `${pctOf(newPts)} of everyone seen; first visit was a "New Patient" visit`)}
    ${tile("Diabetes patients", num(dmRegistry), `${pctOf({ n: dmRegistry, d: all.total_seen, pct: (dmRegistry / all.total_seen) * 100 })} of everyone seen`)}
    ${tile("Seen in the last 6 months", num(all.status[0].n), `${pctOf(all.status[0])} of everyone seen`)}
  </div>
  <div class="grid grid--tables">
    ${shareTable(
      "All patients by year of first visit",
      "Year of first visit",
      all.first_visit_year.map((x) => [x.label, x]),
    )}
    ${shareTable(
      "All patients by sex",
      "Sex",
      all.sex.map((x) => [x.label, x]),
    )}
    ${shareTable(
      "All patients by age at first visit",
      "Age at first visit",
      all.age.map((x) => [x.label, x]),
    )}
    ${shareTable(
      "All patients by number of visits",
      "Visits in the period",
      all.visits.map((x) => [x.label, x]),
    )}
    ${shareTable(
      "All patients by last visit",
      "Last visit",
      all.status.map((x) => [x.label, x]),
    )}
    ${shareTable(
      "All patients by recorded condition",
      "Recorded condition (a patient can have several)",
      all.conditions.map((x) => [x.label, x]),
    )}
  </div>`;
}

function twoTestSection(report, all) {
  const fl = report.first_vs_latest;
  const f = report.funnel;
  if (!fl) return "";
  const totalSeen = all ? all.total_seen : null;
  const rows = [
    ...(totalSeen ? [["All patients seen at Gini", { n: totalSeen, d: totalSeen, pct: 100 }]] : []),
    [
      "Have diabetes",
      {
        n: f.registry,
        d: totalSeen ?? f.registry,
        pct: totalSeen ? (f.registry / totalSeen) * 100 : 100,
      },
    ],
    [
      "Had HbA1c tested 2 or more times",
      { n: fl.n, d: f.registry, pct: (fl.n / f.registry) * 100 },
    ],
    ["Improved by 0.5 points or more (first test → latest test)", fl.improved_05],
    ["Improved by 1 point or more", fl.improved_10],
    ["Stayed about the same (within 0.5 points)", fl.no_real_change],
    ["Got worse by 0.5 points or more", fl.worsened_05],
  ];
  return `${section(
    "From all patients to patients who improved",
    `Of the ${num(fl.n)} diabetes patients with at least two HbA1c tests, average HbA1c went from <strong>${fixed(fl.first_mean)}%</strong> at their first test to <strong>${fixed(fl.latest_mean)}%</strong> at their latest test, a change of <strong>${signed(fl.change_mean)} points</strong> (likely true range ${signed(fl.change_ci95[0])} to ${signed(fl.change_ci95[1])}). <strong>${pctOf(fl.improved_05)}</strong> improved by 0.5 points or more. Below 7%: ${pctOf(fl.below7_first)} at the first test, ${pctOf(fl.below7_latest)} at the latest.`,
    [
      ...(totalSeen
        ? [`${num(totalSeen)} people seen at Gini in the period (see "All patients" above)`]
        : []),
      `${num(f.registry)} of them have diabetes`,
      `${num(fl.n)} had HbA1c tested on 2 or more different dates in the period (after removing values copied forward from old notes)`,
      `For each of them: latest test − first test. Improved = fell by 0.5 points or more`,
      `The time between first and latest test varies (middle patient ${fixed(fl.months_between_median, 1)} months), so this is a simple overall picture. The tables further down compare everyone at the same time point (3, 6, 12 months) and are the stronger measure`,
    ],
  )}
  ${shareTable("All patients to improved", "Group", rows)}
  <div class="scroll" style="margin-top:12px"><table aria-label="Change by time between tests"><thead><tr><th scope="col">Time between first and latest test</th><th class="num" scope="col">Patients</th><th class="num" scope="col">Average change</th><th class="num" scope="col">Improved 0.5+ points</th></tr></thead>
  <tbody>${fl.by_time_between.map((g) => `<tr><th scope="row">${esc(g.label)}</th><td class="num">${num(g.n)}</td><td class="num"><strong>${signed(g.change_mean)}</strong></td>${cell(g.improved_05)}</tr>`).join("")}</tbody></table></div>`;
}

export function renderDmScorecard(report, all = null) {
  const f = report.funnel;
  const w = Object.fromEntries(report.hba1c.windows.map((x) => [x.window, x]));
  const ctl = report.latest_control.all;
  const tr = Object.fromEntries(report.treatments.map((t) => [t.key, t]));
  const eng = report.engagement;
  const st = Object.fromEntries(eng.status.map((s) => [s.status, s]));
  const m = report.meta;
  const yr = Object.fromEntries(
    report.demographics.enrollment_by_year.map((y) => [y.year, y.patients]),
  );
  const np = Object.fromEntries(report.new_patients.windows.map((x) => [x.window, x]));
  const conf = f.confirmation;
  const sg = report.new_patients.same_patients;
  const confirmed12 = report.confirmed_only.find((x) => x.window === "m12").outcome;
  const byDate = (days) => longDate(addDays(m.period.end, -days));
  const chain = (win, label) => [
    `${num(f.registry)} diabetes patients`,
    `${num(win.eligible)} had their first visit by ${byDate(win.measurement_range_days[1])}, so enough time had passed`,
    `${num(win.with_baseline)} of them had an HbA1c test at their first visit (the starting value)`,
    `${num(win.measured.n)} had another HbA1c test ${label} (${win.measurement_range_days[0]}–${win.measurement_range_days[1]} days after the first visit)`,
  ];
  const registrySteps = [
    `Patients in Scribe with a recorded diabetes diagnosis, plus ${num(f.by_definition.lab_confirmed)} without one but with two HbA1c tests of 6.5% or more on different dates`,
    `Keep only those seen at least once between ${longDate(m.period.start)} and ${longDate(m.period.end)} (a consultation or an attended appointment)`,
    `Merge ${num(m.duplicate_records_merged)} duplicate records of the same person (same name and date of birth)`,
    `= <strong>${num(f.registry)} people</strong>: ${num(conf.medicine.n)} on diabetes medicines + ${num(conf.hba1c_only.n)} with HbA1c 6.5% or more + ${num(conf.unconfirmed.n)} with a diagnosis only`,
  ];

  const tiles = [
    tile(
      "Diabetes patients seen",
      num(f.registry),
      `At least one visit between ${longDate(m.period.start)} and ${longDate(m.period.end)}. ${fixed(conf.medicine.pct + conf.hba1c_only.pct, 1)}% confirmed by medicines or a high HbA1c. ${num(f.single_visit.n)} came only once.`,
      registrySteps,
    ),
    tile(
      "Had HbA1c tested 2 or more times",
      num(f.with_two_plus_hba1c.n),
      `${pctOf(f.with_two_plus_hba1c)} of diabetes patients. A change can only be seen with two tests.`,
      [
        `All HbA1c tests dated inside the period`,
        `Removed values copied forward from old notes and tests with only a year as the date`,
        `Patients with 2 or more different test dates = ${num(f.with_two_plus_hba1c.n)} of ${num(f.registry)}`,
      ],
    ),
    tile(
      "Came 3 or more times",
      num(f.three_plus_visits.n),
      `${pctOf(f.three_plus_visits)} of diabetes patients; ${num(f.three_visits_over_six_months.n)} of them over at least 6 months.`,
      [
        `A visit = a day with a consultation or an attended appointment (several records on one day count once)`,
        `Patients with 3 or more visit days = ${num(f.three_plus_visits.n)}`,
        `Of these, ${num(f.three_visits_over_six_months.n)} had at least 6 months between their first and last visit`,
      ],
    ),
    tile(
      "Re-tested about 6 months later",
      num(w.m6.measured.n),
      `Out of ${num(w.m6.with_baseline)} who had a first-visit test and enough time (${pctOf(w.m6.measured)}).`,
      chain(w.m6, "about 6 months later"),
    ),
    tile(
      "Re-tested about 1 year later",
      num(w.m12.measured.n),
      `Out of ${num(w.m12.with_baseline)} who had a first-visit test and enough time (${pctOf(w.m12.measured)}).`,
      chain(w.m12, "about 1 year later"),
    ),
    tile(
      "Average HbA1c change after 1 year",
      `${signed(w.m12.outcome.change_mean)} points`,
      `${fixed(w.m12.outcome.baseline_mean)}% → ${fixed(w.m12.outcome.follow_mean)}% in the ${num(w.m12.outcome.n)} re-tested. Likely true range: a fall of ${fixed(Math.abs(w.m12.outcome.change_ci95[1]), 2)} to ${fixed(Math.abs(w.m12.outcome.change_ci95[0]), 2)} points.`,
      [
        ...chain(w.m12, "about 1 year later"),
        `For each of the ${num(w.m12.outcome.n)}: re-test value − first value`,
        `Average of these changes = ${signed(w.m12.outcome.change_mean)} points (middle patient ${signed(w.m12.outcome.change_median)})`,
      ],
    ),
    tile(
      "Fell by 0.5 points or more (1 year)",
      pctOf(w.m12.outcome.improved_05),
      `${num(w.m12.outcome.improved_05.n)} of ${num(w.m12.outcome.n)} re-tested. After 6 months: ${pctOf(w.m6.outcome.improved_05)}.`,
      [
        `The ${num(w.m12.outcome.n)} patients re-tested about 1 year later`,
        `Those whose HbA1c was at least 0.5 points lower than at their first visit = ${num(w.m12.outcome.improved_05.n)}`,
        `0.5 points is the change doctors regard as meaningful`,
      ],
    ),
    tile(
      "Got below 7% within a year",
      pctOf(w.m12.outcome.reached_below7),
      `${num(w.m12.outcome.reached_below7.n)} of ${num(w.m12.outcome.reached_below7.d)} who started at 7% or above. ${pctOf(w.m12.outcome.maintained_below7)} of those already below 7% stayed there.`,
      [
        `Of the ${num(w.m12.outcome.n)} re-tested at 1 year, ${num(w.m12.outcome.reached_below7.d)} started at 7% or above`,
        `${num(w.m12.outcome.reached_below7.n)} of them were below 7% at the re-test`,
        `The other ${num(w.m12.outcome.maintained_below7.d)} started below 7%; ${num(w.m12.outcome.maintained_below7.n)} were still below 7%`,
      ],
    ),
    tile(
      "All three targets met now",
      pctOf(ctl.among_complete.all_three),
      `About 1 in ${Math.round(100 / ctl.among_complete.all_three.pct)}: HbA1c below 7%, BP below 130/80 and LDL below 100, using latest results.`,
      [
        `Each patient's latest HbA1c, blood pressure and LDL from the 12 months before their last visit`,
        `${num(ctl.complete.n)} patients had all three tested`,
        `${num(ctl.among_complete.all_three.n)} of them met all three targets at the same time`,
      ],
    ),
    tile(
      "New patients: change after 1 year",
      `${signed(np.m12.outcome.change_mean)} points`,
      `${fixed(np.m12.outcome.baseline_mean)}% → ${fixed(np.m12.outcome.follow_mean)}% in ${num(np.m12.outcome.n)} patients new to Gini in 2025–26.`,
      [
        `${num(report.new_patients.patients)} diabetes patients new to Gini in 2025–26`,
        `${num(np.m12.eligible)} had their first visit by ${byDate(np.m12.measurement_range_days[1])}`,
        `${num(np.m12.with_baseline)} had an HbA1c test at their first visit`,
        `${num(np.m12.outcome.n)} were re-tested about 1 year later`,
      ],
    ),
    tile(
      "On GLP-1 or tirzepatide",
      num(tr.any_incretin.started_in_period),
      `${num(tr.any_incretin.new_starts)} started it at Gini; their HbA1c fell ${fixed(Math.abs(tr.any_incretin.new_start.m6.hba1c.change_mean), 2)} points after 6 months (${num(tr.any_incretin.new_start.m6.hba1c.n)} re-tested).`,
      [
        `Prescriptions matched to GLP-1 medicines (semaglutide, liraglutide, dulaglutide…) or tirzepatide by brand and generic name`,
        `Patients with one first prescribed in the period = ${num(tr.any_incretin.started_in_period)} (GLP-1 ${num(tr.glp1.started_in_period)}, tirzepatide ${num(tr.tirzepatide.started_in_period)}; some had both)`,
        `"Started at Gini" = first prescribed at least 30 days after their first visit = ${num(tr.any_incretin.new_starts)}`,
      ],
    ),
    tile(
      "On weekly insulin",
      num(tr.weekly_insulin.started_in_period),
      `First prescribed ${longDate(tr.weekly_insulin.first_start)}. Too new for results.`,
      [
        `Prescriptions of insulin icodec (Awiqli and its spellings)`,
        `Earliest prescription ${longDate(tr.weekly_insulin.first_start)}; a 3-month result needs a first prescription by ${byDate(150)}`,
      ],
    ),
    tile(
      "Came back for a 1-year test",
      pctOf(w.m12.measured),
      `${num(w.m12.measured.n)} of ${num(w.m12.with_baseline)}. The other ${num(w.m12.missing.n)} are left out, not counted as good or bad.`,
      chain(w.m12, "about 1 year later"),
    ),
  ].join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Diabetes Outcomes Scorecard</title><style>${css()}</style></head><body><main>
<h1>Gini diabetes outcomes scorecard</h1>
<p class="sub">Gini Advanced Care Hospital, Mohali · patients seen ${longDate(m.period.start)} to ${longDate(m.period.end)} · data taken ${longDate(m.generated_at)} from Scribe · totals only, no patient names</p>
<div class="banner" role="note"><strong>Draft for clinical review.</strong> Dr Bhansali and the clinical team must approve every figure before it is used publicly. These results show what happened to patients treated at Gini. They do not prove the treatment caused it.</div>

<div class="guide"><strong>How to read this page</strong>
<dl>
<dt>HbA1c</dt><dd>A blood test showing average blood sugar over about 3 months. Below 7% is the usual target for people with diabetes; 6.5% or more means diabetes.</dd>
<dt>Points</dt><dd>HbA1c going from 8.8% to 7.4% is a fall of 1.4 points.</dd>
<dt>Re-tested</dt><dd>Results come only from patients who came back and had a second test. Patients without one are left out, not counted as good or bad.</dd>
<dt>Likely true range</dt><dd>The "95% CI": with this many patients, the true average is very likely inside this range.</dd>
<dt>Middle patient</dt><dd>The median: half the patients are above this value and half below.</dd>
</dl></div>

${allPatientsSection(all, f.registry)}

${twoTestSection(report, all)}

<h2>Statements cleared by the data</h2>
<p class="def">Read these as written. Each one says who it covers, when they were tested and how many patients it is based on.</p>
<ol class="press">
<li><p class="say"><strong>${num(f.registry)} people with diabetes</strong> were seen at Gini between ${longDate(m.period.start)} and ${longDate(m.period.end)}.</p>
<p class="say-sub">Their diabetes is confirmed: ${pctOf(conf.medicine)} take diabetes medicines, and another ${pctOf(conf.hba1c_only)} have an HbA1c test of 6.5% or higher. ${pctOf(conf.unconfirmed)} have a diabetes diagnosis only.</p>
${how(registrySteps)}</li>
<li><p class="say">Patients who came to Gini <strong>new in 2025–2026</strong>: average HbA1c went from <strong>${fixed(np.m12.outcome.baseline_mean, 1)}% to ${fixed(np.m12.outcome.follow_mean, 1)}% after one year</strong> (${num(np.m12.outcome.n)} patients).</p>
<p class="say-sub">A fall of ${fixed(Math.abs(np.m12.outcome.change_mean), 1)} points (likely true range ${fixed(Math.abs(np.m12.outcome.change_ci95[1]), 1)} to ${fixed(Math.abs(np.m12.outcome.change_ci95[0]), 1)}). ${num(np.m12.outcome.improved_05.n)} of ${num(np.m12.outcome.n)} (${pctOf(np.m12.outcome.improved_05)}) improved by 0.5 points or more.</p>
${how([
  `${num(report.new_patients.patients)} diabetes patients whose first Gini visit was a "New Patient" visit in 2025–2026`,
  `${num(np.m12.eligible)} had their first visit by ${byDate(np.m12.measurement_range_days[1])}, so a full year had passed`,
  `${num(np.m12.with_baseline)} of them had an HbA1c test at their first visit (the starting value)`,
  `${num(np.m12.outcome.n)} had a second HbA1c test about one year later (9 to 15 months after the first visit)`,
  `Average of their first tests = ${fixed(np.m12.outcome.baseline_mean, 2)}%; average of their one-year tests = ${fixed(np.m12.outcome.follow_mean, 2)}%`,
])}</li>
<li><p class="say">After <strong>3 months</strong>, new patients' average HbA1c went from <strong>${fixed(np.m3.outcome.baseline_mean, 1)}% to ${fixed(np.m3.outcome.follow_mean, 1)}%</strong> (${num(np.m3.outcome.n)} patients).</p>
<p class="say-sub">${num(np.m3.outcome.improved_05.n)} of ${num(np.m3.outcome.n)} (${pctOf(np.m3.outcome.improved_05)}) improved by 0.5 points or more.</p>
${how([
  `The same ${num(report.new_patients.patients)} new patients`,
  `${num(np.m3.eligible)} had their first visit by ${byDate(np.m3.measurement_range_days[1])}, so 3 months had passed`,
  `${num(np.m3.with_baseline)} of them had an HbA1c test at their first visit`,
  `${num(np.m3.outcome.n)} had a second HbA1c test about 3 months later (2 to 5 months after the first visit)`,
  `Statements 2 and 3 count partly different patients: more people come back at 3 months than at one year, and those re-tested early started higher (${fixed(np.m3.outcome.baseline_mean, 1)}% against ${fixed(np.m12.outcome.baseline_mean, 1)}%). Statement 4 follows one group through all three tests.`,
])}</li>
<li><p class="say">The <strong>same ${num(sg.n)} new patients</strong>, tested three times: <strong>${fixed(sg.baseline_mean, 1)}% at the start → ${fixed(sg.m3_mean, 1)}% at 3 months → ${fixed(sg.m12_mean, 1)}% at one year</strong>.</p>
<p class="say-sub">The improvement came in the first 3 months and held at one year. ${pctOf(sg.improved_05_at_12)} were 0.5 points or more better at one year, and ${pctOf(sg.below7_at_12)} were below 7%.</p>
${how([
  `Of the ${num(np.m12.outcome.n)} new patients in statement 2, ${num(sg.n)} also had a test at about 3 months`,
  `Each of these ${num(sg.n)} people has all three tests: first visit, about 3 months and about 1 year`,
])}</li>
<li><p class="say">Across <strong>all</strong> diabetes patients re-tested about one year after their first visit, average HbA1c fell by <strong>${fixed(Math.abs(w.m12.outcome.change_mean), 1)} points</strong> (${num(w.m12.outcome.n)} patients).</p>
<p class="say-sub">${pctOf(w.m12.outcome.improved_05)} improved by 0.5 points or more. Of those who started at 7% or above, ${pctOf(w.m12.outcome.reached_below7)} got below 7%.</p>
${how(chain(w.m12, "about 1 year later"))}</li>
<li><p class="say">About <strong>1 in ${Math.round(100 / ctl.among_complete.all_three.pct)}</strong> diabetes patients (${pctOf(ctl.among_complete.all_three)}) met all three targets at once: HbA1c below 7%, blood pressure below 130/80 and LDL cholesterol below 100.</p>
<p class="say-sub">Based on the ${num(ctl.complete.n)} patients with all three tested in the last year.</p>
${how([
  `Each patient's latest HbA1c, blood pressure and LDL from the 12 months before their last visit`,
  `${num(ctl.complete.n)} patients had all three tested`,
  `${num(ctl.among_complete.all_three.n)} met all three targets at the same time`,
])}</li>
<li><p class="say"><strong>${num(tr.any_incretin.started_in_period)}</strong> patients have been prescribed a GLP-1 medicine or tirzepatide, and <strong>${num(tr.weekly_insulin.started_in_period)}</strong> have started once-weekly insulin since ${longDate(tr.weekly_insulin.first_start, false)}.</p></li>
<li><p class="say">These results are for patients who came back and were re-tested.</p>
<p class="say-sub">${pctOf(w.m12.measured)} of patients who could have had a one-year test had one, so the results do not describe every patient.</p></li>
</ol>
<ul class="avoid" aria-label="Do not say">
<li><strong>Do not say</strong> "${pctOf(w.m12.outcome.improved_05)} of our patients improved". Say "of patients re-tested at one year".</li>
<li><strong>Do not</strong> put the 3-month and 1-year figures side by side as if they were the same patients. Use statement 4, which follows one group.</li>
<li><strong>Do not say</strong> Gini's treatment caused the change. These are real-world results with no comparison group.</li>
<li><strong>Do not say</strong> "five years of follow-up". Records start in 2022, and 3-year results rest on ${num(w.m36.outcome.n)} patients.</li>
<li><strong>Do not</strong> quote weight loss on GLP-1 or tirzepatide, weekly-insulin results (none yet) or CGM results (no data).</li>
<li><strong>Do not</strong> present complication figures as screening rates, or compare these numbers with trials or other hospitals.</li>
</ul>

<h2>Summary cards</h2>
<p class="def">Open "How this number was counted" on any card to see the steps behind it.</p>
<div class="grid">${tiles}</div>

${section(
  "Patients new to Gini (2025–2026)",
  `The clearest group: their first visit was a "New Patient" visit, so their first HbA1c is their true starting point before Gini's care. ${num(report.new_patients.patients)} diabetes patients qualify. Results go up to 1 year because appointment types are only recorded from January 2025.`,
  [
    `First visit in Scribe was an attended "New Patient" appointment, and no Gini visit more than 30 days before it`,
    `30 days are allowed because a consultation for the same first visit is often recorded a few days before the appointment`,
    `Total: ${num(report.new_patients.patients)} diabetes patients`,
  ],
)}
<div class="scroll"><table aria-label="New patients HbA1c results"><thead>${WINDOW_HEAD}</thead><tbody>${windowRows(report.new_patients.windows, ["m3", "m6", "m12"])}</tbody></table></div>

${section(
  "Who the diabetes patients are",
  `Everyone with diabetes seen in the period, including those who came only once. Gestational diabetes and prediabetes are not included.`,
  registrySteps,
)}
${funnelTable(f)}
<div class="grid grid--tables">
${shareTable(
  "Sex",
  "Sex",
  report.demographics.sex.map((x) => [x.sex === "Unspecified" ? "Not recorded" : x.sex, x]),
)}
${shareTable(
  "Diabetes type",
  "Diabetes type",
  report.demographics.dm_type.map((x) => [x.type, x]),
)}
${shareTable("Age at first visit", `Age at first visit (average ${fixed(report.demographics.age_at_enrollment.mean, 1)})`, [...report.demographics.age_at_enrollment.bands.map((x) => [x.band, x]), ["Not recorded", report.demographics.age_at_enrollment.unknown]])}
${shareTable(
  "Year of first visit",
  "Year of first visit",
  report.demographics.enrollment_by_year.map((y) => [
    y.year,
    { n: y.patients, d: f.registry, pct: (y.patients / f.registry) * 100 },
  ]),
)}
</div>

${section(
  "HbA1c results for all diabetes patients",
  `For each re-test time: how many had enough time, how many had a first-visit test, how many were re-tested, and what changed. Every percentage shows "number / out of".`,
  [
    `First-visit test = the HbA1c closest to the first visit, from 6 months before to 2 weeks after`,
    `Re-test = the HbA1c closest to 3, 6, 12, 24 or 36 months after the first visit, inside that time's range`,
    `"Enough time had passed" = first visit early enough for the whole range to be over by ${longDate(m.period.end)}`,
    `Patients without a re-test are left out of the results, not counted as good or bad`,
  ],
)}
<div class="scroll"><table aria-label="HbA1c results by re-test time"><thead>${WINDOW_HEAD}</thead><tbody>${windowRows(report.hba1c.windows, ["m3", "m6", "m12", "m24", "m36"])}</tbody></table></div>
<p class="def">Leaving out the ${num(conf.unconfirmed.n)} patients with a diagnosis only (no diabetes medicine and no HbA1c of 6.5% or more) gives the same result: change after 1 year ${signed(confirmed12.change_mean)} points (${num(confirmed12.n)} patients), ${pctOf(confirmed12.improved_05)} improved by 0.5 points or more.</p>

${section(
  "Check: lab reports only",
  `The same results using only HbA1c values from lab reports, not values written in doctors' notes. The results are almost the same, so they are not caused by copying values from notes.`,
)}
<div class="scroll"><table aria-label="Lab reports only"><thead>${WINDOW_HEAD}</thead><tbody>${windowRows(report.hba1c.lab_confirmed_only, ["m3", "m6", "m12", "m24", "m36"])}</tbody></table></div>

${section(
  "Results by HbA1c at first visit (1 year)",
  `Patients who start very high fall the most. Part of that is a natural statistical effect, so compare within a row, not across rows.`,
)}
${severityTable(w.m12)}
<h2>Results by HbA1c at first visit (6 months)</h2>
${severityTable(w.m6)}
<h2>Results by HbA1c at first visit (2 years)</h2>
${severityTable(w.m24)}

${section(
  "Weight, blood pressure, cholesterol and kidney tests",
  `Same method as HbA1c: first-visit value compared with the value about 6, 12 or 24 months later. Weight records that just repeated the previous value were removed, so weight results are rough.`,
)}
${markerTable(report.other_markers)}
${section(
  "Kidney results",
  `Urine protein (UACR) stages: below 30 normal, 30–300 raised, above 300 high. Middle-patient values are used because a few very high readings distort the average.`,
)}
${kidneyTable(report.kidney)}

${section(
  "HbA1c, blood pressure and cholesterol all on target",
  `Each patient's latest results from the 12 months before their last visit. Out of the ${num(ctl.complete.n)} patients (${pctOf(ctl.complete)} of ${num(ctl.population)}) with all three tested. Among patients seen in the last 6 months: ${pctOf(report.latest_control.active_only.among_complete.all_three)} (${nOf(report.latest_control.active_only.among_complete.all_three)}).`,
)}
${controlTable(ctl)}
<p class="def">Over time: patients with all three tested at their first visit and again later.</p>
${combinedChangeTable(report.combined_control_change)}

${section(
  "Recorded complications",
  `The share of diabetes patients whose Scribe record lists each complication. These are recorded diagnoses, not screening results, so a low number can mean it was not checked or not written down.`,
)}
${shareTable("Recorded complications", "Complication", [...report.complications.rows.map((x) => [x.label, x]), ["Any small-vessel complication (kidney, nerve, eye)", report.complications.any_microvascular], ["Any large-vessel complication (heart, stroke, legs)", report.complications.any_macrovascular]])}

${section(
  "Medicines",
  `<strong>Started at Gini (use this table).</strong> The medicine was first prescribed at least 30 days after the patient's first visit, so we have their HbA1c before and after starting it.`,
)}
${treatmentTable(report.treatments, "new")}
<p class="def"><strong>Everyone prescribed it.</strong> This also includes patients who were already on the medicine when they joined Gini, so the change mixes the medicine with everything else that changed when they joined. Do not quote this table as a medicine effect.</p>
${treatmentTable(report.treatments, "all")}

${section(
  "Coming back",
  `Last visit as of ${longDate(m.period.end)}: within 6 months ${num(st.active.n)} (${pctOf(st.active)}); 6–12 months ago ${num(st.overdue.n)} (${pctOf(st.overdue)}); over 12 months ago ${num(st.long_gap.n)} (${pctOf(st.long_gap)}). Scribe does not record deaths or transfers, so these cannot be separated out. "Came back around N months" = any visit in that time range.`,
)}
${retentionTable(eng.retention_by_enrollment_year)}
<p class="def">Patients not seen for over a year: their last HbA1c averaged ${fixed(eng.long_gap_last_known_hba1c.mean)}%, and ${pctOf(eng.long_gap_last_known_hba1c.below7)} were below 7%. This is their old result, not a current one.</p>

${section(
  "Who came back for a re-test, and who did not",
  `At their first visit both groups were alike (age, sex, starting HbA1c). The difference is that re-tested patients came much more often. That is why every statement says "patients who came back".`,
)}
${biasTable(report.hba1c.missing_vs_measured_12m, "1-year")}
${biasTable(report.hba1c.missing_vs_measured_6m, "6-month")}

<h2>Limits of this data (say these when asked)</h2>
<ul class="caveats">
<li>Scribe's records really start in January 2022; only ${num(yr["2021"] ?? 0)} diabetes patients had a visit in November–December 2021. "First visit" means the first visit recorded in Scribe, which for long-time patients is not their first visit to Gini.</li>
<li>From April 2024 to February 2025, about 70% fewer visits and far fewer HbA1c tests were recorded in Scribe. This is missing data, not fewer patients, and it lowers the re-test numbers for patients who joined in 2023–2024.</li>
<li>Most patients had no re-test at a given time (${pctOf(w.m12.missing)} at 1 year). Results describe patients who came back.</li>
<li>Cleaning: ${num(m.readings_dropped.repeated_copy)} values copied forward from old notes, ${num(m.readings_dropped.placeholder_date)} HbA1c values with only a year as the date, and ${num(m.readings_dropped.carried_forward)} repeated weight records were removed. ${num(m.duplicate_records_merged)} duplicate patient records were merged.</li>
<li>Diabetes is confirmed by medicines or HbA1c for ${fixed(conf.medicine.pct + conf.hba1c_only.pct, 1)}% of patients. The other ${num(conf.unconfirmed.n)} have a diagnosis only; leaving them out changes nothing.</li>
<li>Complications are recorded diagnoses (added from notes since February 2026), not screening results.</li>
<li>Weight is not recorded reliably, so weight results are rough.</li>
<li>Age is unknown for ${pctOf(report.demographics.age_at_enrollment.unknown)} of patients (no date of birth recorded).</li>
<li>Deaths and transfers are not recorded. CGM data exist for only about 12 patients, so there are no CGM results.</li>
<li>This is a snapshot taken on ${longDate(m.generated_at)}. Scribe is live, so later rebuilds give slightly different counts. Quote this version.</li>
</ul>
<footer>Method: docs/DM_OUTCOMES_METHODOLOGY.md · engine server/services/analytics/dmOutcomes.js · rerun: node server/scripts/build-dm-outcomes.mjs</footer>
</main></body></html>`;
}
