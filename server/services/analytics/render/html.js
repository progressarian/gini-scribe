import { buildCss, buildJs, CONTROL_COLORS, TRAJECTORY_COLORS } from "./theme.js";
import {
  barChart,
  columnChart,
  dotPlot,
  esc,
  funnelChart,
  groupedBarChart,
  legend,
  lineChart,
  stackedShareChart,
} from "./svg.js";
import { MARKERS } from "../constants.js";
import { CONDITION_LABELS } from "../conditions.js";

const num = (v) => (v == null || v === "" || Number.isNaN(v) ? "—" : Number(v).toLocaleString());
const pctText = (v) => (v == null ? "—" : `${v}%`);
const dec = (v, d = 1) => (v == null || Number.isNaN(v) ? "—" : Number(v).toFixed(d));
const signed = (v, d = 2) => {
  if (v == null || Number.isNaN(v)) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(d)}`;
};

function table(columns, rows) {
  if (!rows.length) return `<p class="small">No rows.</p>`;
  const head = columns.map((c) => `<th scope="col">${esc(c.label)}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${columns
          .map((c) => {
            const raw = c.get ? c.get(r) : r[c.key];
            const cls = c.className ? ` class="${c.className(r)}"` : "";
            return `<td${cls}>${raw == null ? "—" : raw}</td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  return `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function kpi(value, key, note) {
  return `<div class="kpi"><span class="v">${value}</span><span class="k">${esc(key)}</span>${note ? `<span class="n">${esc(note)}</span>` : ""}</div>`;
}

function notes(list, extraClass = "") {
  if (!list || !list.length) return "";
  return `<div class="notes ${extraClass}"><ul>${list.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`;
}

function section(id, title, lede, body) {
  return `<section id="${id}"><h2>${esc(title)}</h2><p class="lede">${esc(lede)}</p>${body}</section>`;
}

const CONTROL_SEGMENTS = [
  { key: "at_goal", label: "At goal", color: CONTROL_COLORS.good },
  { key: "borderline", label: "Borderline", color: CONTROL_COLORS.warn },
  { key: "off_goal", label: "Off goal", color: CONTROL_COLORS.bad },
];

const TRAJECTORY_SEGMENTS = [
  { key: "improving", label: "Improving", color: TRAJECTORY_COLORS.better },
  { key: "stable", label: "Stable", color: TRAJECTORY_COLORS.stable },
  { key: "worsening", label: "Worsening", color: TRAJECTORY_COLORS.worse },
];

function renderRegistry(s) {
  const k = s.kpis;
  const kpis = `<div class="kpis">
    ${kpi(num(k.registered_patients), "Registered patients", "all records in the system")}
    ${kpi(num(k.patients_with_visit), "With a recorded visit", `${num(k.patients_without_visit)} have none`)}
    ${kpi(num(k.continuing_patients), "Continuing", `${pctText(k.continuing_share_pct)} of those with a visit`)}
    ${kpi(num(k.lapsed_patients), "Lapsed", "no visit in the last 6 months")}
    ${kpi(dec(k.median_visits_per_patient, 1), "Median visits per patient", "distinct visit days")}
    ${kpi(num(k.median_tenure_days), "Median days since first visit", "how long they have been with Gini")}
  </div>`;

  const growth = lineChart(
    [
      {
        name: "Cumulative patients",
        color: "var(--series-1)",
        points: s.growth.map((g) => ({ y: g.cumulative })),
      },
    ],
    {
      xLabels: s.growth.map((g) => g.quarter),
      label: "Cumulative patients by first-visit quarter",
      height: 240,
    },
  );
  const newPer = lineChart(
    [
      {
        name: "New patients",
        color: "var(--series-2)",
        points: s.growth.map((g) => ({ y: g.new_patients })),
      },
    ],
    { xLabels: s.growth.map((g) => g.quarter), label: "New patients per quarter", height: 200 },
  );

  const volume = lineChart(
    [
      {
        name: "Patients seen",
        color: "var(--series-1)",
        points: s.visit_volume.map((v) => ({ y: v.patients })),
      },
    ],
    { xLabels: s.visit_volume.map((v) => v.month), label: "Patients seen per month", height: 220 },
  );

  const demoRows = s.demographics.map((d) => ({ ...d, label: d.age_band }));
  const demo = stackedShareChart(
    demoRows,
    [
      { key: "female", label: "Female", color: "var(--series-1)" },
      { key: "male", label: "Male", color: "var(--series-2)" },
      { key: "unspecified", label: "Not recorded", color: "var(--muted)" },
    ],
    { label: "Age and sex mix" },
  );

  return (
    kpis +
    `<div class="card"><figure><figcaption>Cumulative patient panel, by the quarter of each patient's first visit</figcaption>${growth}</figure></div>
     <div class="card"><figure><figcaption>New patients joining each quarter</figcaption>${newPer}</figure></div>
     <div class="card"><figure><figcaption>Distinct patients seen each month</figcaption>${volume}</figure></div>
     <h3>Age and sex</h3>
     <div class="card">${legend([
       { label: "Female", color: "var(--series-1)" },
       { label: "Male", color: "var(--series-2)" },
       { label: "Not recorded", color: "var(--muted)" },
     ])}${demo}<p class="small">Sex is not recorded for a large share of patients, and ${num(s.unknown_age_patients)} patients have no usable age. Both are data-entry gaps, not real categories.</p></div>
     <h3>How often patients come back</h3>
     ${table(
       [
         { label: "Visit count", key: "bucket" },
         { label: "Patients", get: (r) => num(r.patients) },
         { label: "Share", get: (r) => pctText(r.share_pct) },
       ],
       s.visit_distribution,
     )}` +
    notes(s.notes)
  );
}

function renderConditions(s) {
  const prevalence = barChart(
    s.prevalence.slice(0, 12).map((p) => ({ label: p.condition, value: p.patients })),
    { label: "Patients per condition", valueFormat: num },
  );

  const prevTable = table(
    [
      { label: "Condition", key: "condition" },
      { label: "Patients", get: (r) => num(r.patients) },
      { label: "Share of panel", get: (r) => pctText(r.share_of_panel_pct) },
      { label: "Continuing", get: (r) => num(r.continuing) },
      { label: "Continuing %", get: (r) => pctText(r.continuing_pct) },
      { label: "Lapsed", get: (r) => num(r.lapsed) },
      { label: "Female", get: (r) => num(r.female) },
      { label: "Male", get: (r) => num(r.male) },
      { label: "Mean age", get: (r) => num(r.mean_age) },
    ],
    s.prevalence,
  );

  const comps = table(
    [
      { label: "Complication", key: "complication" },
      { label: "Patients", get: (r) => num(r.patients_affected) },
      { label: "Crude rate", get: (r) => pctText(r.crude_rate_pct) },
      { label: "Adjusted rate", get: (r) => `<strong>${pctText(r.adjusted_rate_pct)}</strong>` },
      { label: "Adjusted denominator", get: (r) => num(r.eligible_denominator) },
      { label: "Recorded from", key: "capture_start" },
    ],
    s.complications.rows,
  );

  const burden = barChart(
    s.comorbidity.burden.map((b) => ({ label: b.bucket, value: b.patients })),
    { label: "Conditions per patient", valueFormat: num, color: "var(--series-3)" },
  );

  const matrixCols = [
    { label: "Condition", key: "condition" },
    ...s.comorbidity.keys.map((k) => ({
      label: CONDITION_LABELS[k] || k,
      get: (r) => (r.key === k ? `<strong>${num(r[k])}</strong>` : num(r[k])),
    })),
  ];

  return (
    `<div class="card"><figure><figcaption>Patients carrying each condition. A patient can appear in several rows.</figcaption>${prevalence}</figure></div>
     ${prevTable}
     <h3>How many conditions each patient carries</h3>
     <div class="card">${burden}</div>
     <h3>Which conditions occur together</h3>
     <p class="small">Read a row and a column: the cell is the number of patients carrying both. The diagonal is the condition's own total.</p>
     ${table(matrixCols, s.comorbidity.matrix)}
     <h3>Complication burden among diabetic patients</h3>
     <p class="small">Adjusted rate is the number to use. See the note below for why the crude rate understates the burden.</p>
     ${comps}
     <div class="kpis" style="margin-top:16px">
       ${kpi(pctText(s.complications.any_complication_pct), "Have at least one complication", `${num(s.complications.any_complication)} of ${num(s.complications.eligible_denominator)} diabetics seen since ${esc(s.complications.capture_start || "capture start")}`)}
     </div>` + notes(s.complications.notes, "caveat")
  );
}

function renderRetention(s) {
  const recency = barChart(
    s.recency.map((r) => ({ label: r.band, value: r.patients })),
    { label: "Time since last visit", valueFormat: num },
  );

  const byCondition = s.by_condition
    .filter((r) => r.patients >= 150)
    .map((r) => ({ label: r.condition, value: r.continuing_pct, n: r.patients }));

  const conditionBars = barChart(
    byCondition.map((r) => ({ label: `${r.label} (n=${num(r.n)})`, value: r.value })),
    {
      label: "Share still attending, by condition",
      valueFormat: (v) => `${v}%`,
      color: "var(--series-3)",
      width: 860,
      labelWidth: 380,
    },
  );

  const curve = lineChart(
    [
      {
        name: "Still attending",
        color: "var(--series-1)",
        points: s.retention_curve.map((r) => ({ y: r.still_active_pct })),
      },
      {
        name: "Returned within 180 days",
        color: "var(--series-2)",
        points: s.retention_curve.map((r) => ({ y: r.retained_180d_pct })),
      },
    ],
    {
      xLabels: s.retention_curve.map((r) => r.cohort),
      label: "Retention by joining cohort",
      height: 240,
      valueFormat: (v) => `${v}%`,
    },
  );

  const attendance = lineChart(
    [
      {
        name: "No-show rate",
        color: "var(--series-2)",
        points: s.attendance.monthly.map((m) => ({ y: m.no_show_rate_pct })),
      },
    ],
    {
      xLabels: s.attendance.monthly.map((m) => m.month),
      label: "Monthly no-show rate",
      height: 200,
      valueFormat: (v) => `${v}%`,
    },
  );

  return (
    `<div class="kpis">
      ${kpi(pctText(s.attendance.no_show_rate_pct), "No-show rate", "of booked appointments since 2025")}
      ${kpi(num(s.intervals.intervals.median), "Median days between visits", `across ${num(s.intervals.sample_size)} intervals`)}
      ${kpi(num(s.intervals.intervals.p75), "75th percentile gap", "days between consecutive visits")}
    </div>
    <div class="card"><figure><figcaption>Time since each patient's most recent visit</figcaption>${recency}</figure></div>
    <h3>Retention differs sharply by condition</h3>
    <div class="card"><figure><figcaption>Share of each condition's patients seen within the last 6 months</figcaption>${conditionBars}</figure></div>
    ${table(
      [
        { label: "Condition", key: "condition" },
        { label: "Patients", get: (r) => num(r.patients) },
        { label: "Continuing", get: (r) => num(r.continuing) },
        { label: "Continuing %", get: (r) => pctText(r.continuing_pct) },
        { label: "Lapsed", get: (r) => num(r.lapsed) },
        { label: "Recorded from", get: (r) => r.capture_start || "—" },
      ],
      s.by_condition,
    )}
    <h3>Retention by joining cohort</h3>
    <div class="card">${legend([
      { label: "Still attending", color: "var(--series-1)" },
      { label: "Returned within 180 days", color: "var(--series-2)" },
    ])}<figure><figcaption>Each point is a quarter's intake, followed forward</figcaption>${curve}</figure></div>
    <h3>Appointment attendance</h3>
    <div class="card"><figure><figcaption>Monthly no-show rate</figcaption>${attendance}</figure></div>` +
    notes(s.attendance.notes)
  );
}

function renderBiomarkers(s) {
  const cascade = funnelChart(s.cascade.steps, { label: "Diabetes control cascade" });

  const controlRows = s.control
    .filter((r) => r.at_goal_pct != null)
    .sort((a, b) => a.tier - b.tier || b.patients_current - a.patients_current)
    .map((r) => ({ ...r, label: `${r.label}` }));

  const controlChart = stackedShareChart(controlRows, CONTROL_SEGMENTS, {
    label: "Share of patients at goal by marker",
  });

  const trajRows = s.control
    .filter((r) => r.patients_paired >= 200)
    .map((r) => ({ ...r, label: r.label }));
  const trajChart = stackedShareChart(trajRows, TRAJECTORY_SEGMENTS, {
    label: "Direction of travel by marker",
  });

  const dists = s.distributions
    .map(
      (d) =>
        `<div class="card"><figure><figcaption>${esc(d.label)} — most recent value per patient (n=${num(d.n)})</figcaption>${columnChart(
          d.bins,
          { label: `${d.label} distribution`, valueSuffix: d.unit === "%" ? "%" : "" },
        )}</figure></div>`,
    )
    .join("");

  const controlTable = table(
    [
      { label: "Marker", key: "label" },
      { label: "Patients ever tested", get: (r) => num(r.patients_any) },
      { label: "Tested in last 12m", get: (r) => num(r.patients_current) },
      { label: "At goal", get: (r) => pctText(r.at_goal_pct) },
      { label: "Borderline", get: (r) => pctText(r.borderline_pct) },
      { label: "Off goal", get: (r) => pctText(r.off_goal_pct) },
      { label: "Trendable", get: (r) => num(r.patients_paired) },
      { label: "Improving", get: (r) => pctText(r.improving_pct) },
      { label: "Stable", get: (r) => pctText(r.stable_pct) },
      { label: "Worsening", get: (r) => pctText(r.worsening_pct) },
      { label: "Median latest", get: (r) => dec(r.latest_values.median, 2) },
    ],
    s.control,
  );

  const contTable = table(
    [
      { label: "Marker", get: (r) => MARKERS[r.marker].label },
      { label: "Group", get: (r) => (r.group === "continuing" ? "Continuing" : "Lapsed") },
      { label: "Patients", get: (r) => num(r.patients) },
      { label: "At goal", get: (r) => pctText(r.at_goal_pct) },
      { label: "Off goal", get: (r) => pctText(r.off_goal_pct) },
      { label: "Median", get: (r) => dec(r.median, 2) },
    ],
    s.by_continuity,
  );

  const trajCond = table(
    [
      { label: "Condition", get: (r) => CONDITION_LABELS[r.condition] || r.condition },
      { label: "Marker", get: (r) => MARKERS[r.marker].label },
      { label: "Trendable patients", get: (r) => num(r.patients_paired) },
      { label: "Improving", get: (r) => pctText(r.improving_pct) },
      { label: "Stable", get: (r) => pctText(r.stable_pct) },
      { label: "Worsening", get: (r) => pctText(r.worsening_pct) },
      {
        label: "Median change",
        get: (r) => signed(r.median_change, 2),
        className: (r) => (r.median_change < 0 ? "pos" : r.median_change > 0 ? "neg" : ""),
      },
    ],
    s.trajectory_by_condition,
  );

  return `<h3>The diabetes control cascade</h3>
     <p class="small">The clearest single view of whether diabetes care is working. Each bar is a subset of the one above it.</p>
     <div class="card">${cascade}</div>
     <div class="kpis">
       ${s.cascade.control_bands
         .map((b) =>
           kpi(
             pctText(b.share_pct),
             b.band,
             `${num(b.patients)} of ${num(s.cascade.current_denominator)} recently tested`,
           ),
         )
         .join("")}
     </div>
     ${notes(s.cascade.notes)}
     <h3>Where patients stand against target</h3>
     <div class="card">${legend(CONTROL_SEGMENTS.map((c) => ({ label: c.label, color: c.color })))}<figure><figcaption>Most recent value per patient, tested within the last 12 months</figcaption>${controlChart}</figure></div>
     <h3>Direction of travel</h3>
     <div class="card">${legend(TRAJECTORY_SEGMENTS.map((c) => ({ label: c.label, color: c.color })))}<figure><figcaption>First recorded value compared with the most recent, for patients with at least two readings</figcaption>${trajChart}</figure></div>
     <h3>All markers</h3>
     ${controlTable}
     <h3>Distributions</h3>
     ${dists}
     <h3>Continuing patients versus lapsed patients</h3>
     <p class="small">Patients who stopped attending are in worse control on every headline marker. This is the strongest argument in the report for chasing the lapsed list.</p>
     ${contTable}
     <h3>Direction of travel by condition</h3>
     ${trajCond}`;
}

function renderTreatment(s) {
  const classChart = barChart(
    s.landscape.classes.slice(0, 14).map((c) => ({ label: c.drug_class, value: c.patients_ever })),
    { label: "Patients ever prescribed each drug class", valueFormat: num },
  );

  const regimenChart = barChart(
    s.regimen.per_class.map((c) => ({ label: c.drug_class, value: c.patients })),
    { label: "Glucose-lowering drug classes in use", valueFormat: num, color: "var(--series-3)" },
  );

  const intensity = barChart(
    s.regimen.intensity.map((i) => ({ label: i.bucket, value: i.patients })),
    { label: "Treatment intensity", valueFormat: num, color: "var(--series-2)" },
  );

  const gapsChart = barChart(
    s.gaps.map((g) => ({ label: g.gap, value: g.gap_rate_pct, color: "var(--status-critical)" })),
    { label: "Guideline gap rates", valueFormat: (v) => `${v}%`, width: 900, labelWidth: 430 },
  );

  return `<div class="card"><figure><figcaption>Patients ever prescribed each class (denominator ${num(s.landscape.denominator)})</figcaption>${classChart}</figure></div>
     ${table(
       [
         { label: "Drug class", key: "drug_class" },
         { label: "Ever prescribed", get: (r) => num(r.patients_ever) },
         { label: "Currently active", get: (r) => num(r.patients_active) },
         { label: "Share of panel", get: (r) => pctText(r.share_of_panel_pct) },
       ],
       s.landscape.classes,
     )}
     <h3>Diabetes regimens</h3>
     <div class="card"><figure><figcaption>Active glucose-lowering therapy among ${num(s.regimen.denominator)} diabetic patients</figcaption>${regimenChart}</figure></div>
     <div class="card"><figure><figcaption>How many drug classes each diabetic patient is on</figcaption>${intensity}</figure></div>
     <h3>Most common combinations</h3>
     ${table(
       [
         { label: "Combination", key: "combination" },
         { label: "Patients", get: (r) => num(r.patients) },
         { label: "Share of diabetics", get: (r) => pctText(r.share_pct) },
       ],
       s.regimen.top_combinations,
     )}
     <h3>Treatment gaps against standard guidance</h3>
     <p class="small">Each row counts patients who meet the clinical trigger but have no matching active prescription recorded. A gap may reflect a missing record rather than missing care.</p>
     <div class="card">${gapsChart}</div>
     ${table(
       [
         { label: "Gap", key: "gap" },
         { label: "Eligible patients", get: (r) => num(r.eligible_patients) },
         { label: "With gap", get: (r) => num(r.patients_with_gap) },
         { label: "Gap rate", get: (r) => `<strong>${pctText(r.gap_rate_pct)}</strong>` },
       ],
       s.gaps,
     )}
     <h3>How long patients stay on each class</h3>
     ${table(
       [
         { label: "Drug class", key: "drug_class" },
         { label: "Prescriptions", get: (r) => num(r.prescriptions) },
         { label: "Still active", get: (r) => num(r.still_active) },
         { label: "Still active %", get: (r) => pctText(r.still_active_pct) },
         { label: "Stopped", get: (r) => num(r.stopped) },
         {
           label: "Stopped with a clinical reason",
           get: (r) => num(r.stopped_with_clinical_reason),
         },
         { label: "Median days on drug", get: (r) => num(r.duration_days.median) },
       ],
       s.persistence.slice(0, 18),
     )}
     ${notes([
       "Almost every recorded stop reason is the automated sweep that fires when a drug disappears from the latest prescription. Whether a patient stopped is knowable; why they stopped is almost never recorded.",
     ])}`;
}

function renderDrugOutcomes(s) {
  const cohortRows = s.cohort_sizes
    .filter((c) => c.patients >= 20)
    .map((c) => ({ label: c.cohort, value: c.patients }));

  const sizes = barChart(cohortRows, { label: "Cohort sizes", valueFormat: num });

  const a1c6 = s.outcomes.filter((r) => r.marker === "hba1c" && r.window === "m6");
  const wt6 = s.outcomes.filter((r) => r.marker === "weight" && r.window === "m6");

  const a1cChart = dotPlot(
    a1c6
      .filter((r) => r.paired_n >= 20)
      .sort((a, b) => a.change.mean - b.change.mean)
      .map((r) => ({
        label: r.cohort_label,
        value: r.change.mean,
        n: r.paired_n,
        color: "var(--series-1)",
      })),
    { label: "Mean HbA1c change at 6 months", valueFormat: (v) => signed(v, 2) },
  );

  const wtChart = dotPlot(
    wt6
      .filter((r) => r.paired_n >= 20)
      .sort((a, b) => a.pct_change.mean - b.pct_change.mean)
      .map((r) => ({
        label: r.cohort_label,
        value: r.pct_change.mean,
        n: r.paired_n,
        color: "var(--series-3)",
      })),
    { label: "Mean weight change at 6 months", valueFormat: (v) => `${signed(v, 1)}%` },
  );

  const outcomeTable = (rows, marker) =>
    table(
      [
        { label: "Cohort", key: "cohort_label" },
        { label: "Window", key: "window_label" },
        { label: "Cohort size", get: (r) => num(r.cohort_size) },
        { label: "Paired n", get: (r) => `<strong>${num(r.paired_n)}</strong>` },
        { label: "Baseline mean", get: (r) => dec(r.baseline.mean, 2) },
        { label: "Follow-up mean", get: (r) => dec(r.followup.mean, 2) },
        {
          label: "Mean change",
          get: (r) => signed(r.change.mean, 2),
          className: (r) => (r.change.mean < 0 ? "pos" : r.change.mean > 0 ? "neg" : ""),
        },
        { label: "Median change", get: (r) => signed(r.change.median, 2) },
        ...(marker === "hba1c"
          ? [
              { label: "Reached under 7%", get: (r) => pctText(r.reached_under_7_rate) },
              { label: "Fell 1% or more", get: (r) => pctText(r.drop_ge_1pct_rate) },
            ]
          : [
              { label: "Lost 5%+", get: (r) => pctText(r.loss_ge_5pct_rate) },
              { label: "Lost 10%+", get: (r) => pctText(r.loss_ge_10pct_rate) },
              { label: "Lost 15%+", get: (r) => pctText(r.loss_ge_15pct_rate) },
            ]),
      ],
      rows,
    );

  const sensitivity = (block, unit) =>
    dotPlot(
      block.rows
        .filter((r) => r.paired_n >= 3)
        .map((r) => ({
          label: `${r.cohort_label} — ${r.stratum_label}`,
          value: r.mean_change,
          n: r.paired_n,
          color: r.stratum === "all" ? "var(--series-1)" : "var(--muted)",
        })),
      {
        label: `Sensitivity of ${block.marker} estimate`,
        valueFormat: (v) => `${signed(v, 2)} ${unit}`,
        width: 860,
        labelWidth: 420,
      },
    );

  const titration = s.titration
    .filter((t) => t.patients_with_dose_data >= 30)
    .map(
      (t) =>
        `<div class="card"><figure><figcaption>${esc(t.molecule_label)} — dose levels recorded (${num(t.patients_with_dose_data)} patients)</figcaption>${barChart(
          t.doses
            .filter((d) => d.patients >= 3)
            .map((d) => ({ label: `${d.dose_mg} mg`, value: d.patients })),
          {
            label: `${t.molecule_label} dose distribution`,
            valueFormat: num,
            color: "var(--series-2)",
          },
        )}</figure>${table(
          [
            { label: "Dose escalation", key: "bucket" },
            { label: "Patients", get: (r) => num(r.patients) },
          ],
          t.escalation,
        )}</div>`,
    )
    .join("");

  return `<div class="card"><figure><figcaption>Patients ever prescribed each drug or class</figcaption>${sizes}</figure></div>
     ${table(
       [
         { label: "Cohort", key: "cohort" },
         { label: "Patients", get: (r) => num(r.patients) },
         {
           label: "Start recorded as it happened",
           get: (r) => num((r.index_quality || {}).observed_start),
         },
         {
           label: "Backfilled 1-6 months",
           get: (r) => num((r.index_quality || {}).backfilled_short),
         },
         {
           label: "Backfilled over 6 months",
           get: (r) => num((r.index_quality || {}).backfilled_long),
         },
       ],
       s.cohort_sizes.filter((c) => c.patients >= 20),
     )}
     <h3>HbA1c response at 6 months</h3>
     <div class="card"><figure><figcaption>Mean change in HbA1c, percentage points. Left is better.</figcaption>${a1cChart}</figure></div>
     ${outcomeTable(
       a1c6.filter((r) => r.paired_n >= 10),
       "hba1c",
     )}
     <h3>Weight response at 6 months</h3>
     <div class="card"><figure><figcaption>Mean percentage change in body weight. Left is better.</figcaption>${wtChart}</figure></div>
     ${outcomeTable(
       wt6.filter((r) => r.paired_n >= 10),
       "weight",
     )}
     <h3>How much to trust these numbers</h3>
     <p class="small">The same cohort, the same outcome, recomputed under different definitions of when treatment started. A wide spread means the headline figure is a range, not a point.</p>
     <div class="card"><figure><figcaption>Weight change at 6 months, by index-date definition</figcaption>${sensitivity(s.sensitivity_weight, "kg")}</figure></div>
     <div class="card"><figure><figcaption>HbA1c change at 6 months, by index-date definition</figcaption>${sensitivity(s.sensitivity_hba1c, "%")}</figure></div>
     ${notes(s.sensitivity_weight.notes, "caveat")}
     <h3>Dose and titration</h3>
     <p class="small">Dose levels are reconstructed from separate prescription rows per strength. A patient with only one dose level recorded was never escalated, or the escalation was not captured.</p>
     ${titration}
     <h3>Staying on treatment</h3>
     ${table(
       [
         { label: "Cohort", key: "cohort_label" },
         { label: "Patients", get: (r) => num(r.patients) },
         { label: "Still on drug", get: (r) => num(r.still_on_drug) },
         { label: "Still on drug %", get: (r) => pctText(r.still_on_drug_pct) },
         { label: "Discontinued", get: (r) => num(r.discontinued) },
         { label: "Median days on drug", get: (r) => num(r.time_on_drug_days.median) },
       ],
       s.persistence,
     )}
     <h3>Tolerability signal</h3>
     <p class="small">Supportive medicines co-prescribed to patients on a GLP-1 agonist. This is an indirect proxy for side-effect burden, not a recorded adverse-event rate.</p>
     ${table(
       [
         { label: "Supportive medicine type", key: "support_type" },
         { label: "Patients", get: (r) => num(r.patients) },
         { label: "Share of GLP-1 cohort", get: (r) => pctText(r.share_of_cohort_pct) },
         { label: "Explicitly linked to the GLP-1 row", get: (r) => num(r.explicitly_linked_rows) },
       ],
       s.tolerability,
     )}
     ${notes(s.notes, "caveat")}`;
}

function renderDataQuality(s) {
  const funnel = funnelChart(s.coverage_funnel, {
    label: "Data coverage funnel",
    width: 820,
    labelWidth: 370,
  });
  return `<div class="card">${funnel}</div>
     <h3>Patient record completeness</h3>
     <div class="kpis">
       ${kpi(pctText(s.identity.dob_missing_pct), "Missing date of birth", `${num(s.identity.dob_missing)} patients`)}
       ${kpi(pctText(s.identity.sex_unspecified_pct), "Sex not recorded as male or female", `${num(s.identity.sex_unspecified)} patients`)}
       ${kpi(pctText(s.identity.health_id_missing_pct), "No stable health ID", `${num(s.identity.health_id_missing)} patients`)}
       ${kpi(num(s.identity.duplicate_name_phone_groups), "Possible duplicate identities", "same name and phone number")}
     </div>
     <h3>Laboratory data</h3>
     <div class="kpis">
       ${kpi(num(s.labs.total_rows), "Lab result rows", "")}
       ${kpi(pctText(s.labs.canonical_missing_pct), "No normalised test name", `${num(s.labs.canonical_missing)} rows`)}
       ${kpi(pctText(s.labs.canonical_unmapped_slug_pct), "Unmapped test name", `${num(s.labs.canonical_unmapped_slug)} rows fell back to a raw slug`)}
       ${kpi(num(s.labs.non_numeric_results), "Non-numeric results", "excluded from all trends")}
     </div>
     <h3>Unit consistency</h3>
     <p class="small">Where one test is reported in several units, cross-patient comparison is unreliable until the units are reconciled.</p>
     ${table(
       [
         { label: "Test", key: "canonical_name" },
         { label: "Distinct units", get: (r) => num(r.distinct_units) },
         { label: "Rows", get: (r) => num(r.total_rows) },
         { label: "Dominant unit", key: "dominant_unit" },
         { label: "Dominant share", get: (r) => pctText(r.dominant_share_pct) },
       ],
       s.unit_heterogeneity,
     )}
     <h3>Legacy derived tables</h3>
     <p class="small">These tables exist in the database and look like analytics. Nothing refreshes them, no code reads them, and they are months out of date. This report does not use them.</p>
     ${table(
       [
         { label: "Table", key: "table" },
         { label: "Rows", get: (r) => num(r.rows) },
         { label: "Newest record", get: (r) => r.newest_record || "unknown" },
       ],
       s.legacy_tables,
     )}
     <h3>Drug names the classifier could not resolve</h3>
     <p class="small">Classifying these raises the accuracy of every prescribing and outcome figure in the report.</p>
     ${table(
       [
         { label: "Recorded name", key: "name" },
         { label: "Rows", get: (r) => num(r.rows) },
         { label: "Patients", get: (r) => num(r.patients) },
       ],
       s.unmatched_drugs.slice(0, 40),
     )}
     <h3>Diagnosis codes not mapped to a condition group</h3>
     ${table(
       [
         { label: "Diagnosis code", key: "slug" },
         { label: "Patients", get: (r) => num(r.patients) },
       ],
       s.unmapped_diagnoses.slice(0, 40),
     )}
     ${notes(s.notes)}`;
}

function renderWorklists(s) {
  const blocks = [
    {
      title: "Lapsed patients with uncontrolled diabetes",
      lede: "Last HbA1c at or above 9% and no visit in the last six months. Highest clinical priority for recall.",
      rows: s.lapsed_uncontrolled_diabetics.slice(0, 60),
      columns: [
        { label: "Patient ID", key: "patient_id" },
        { label: "File no", key: "file_no" },
        { label: "Age", get: (r) => num(r.age) },
        { label: "Sex", key: "sex" },
        { label: "Last HbA1c", get: (r) => dec(r.last_hba1c, 1) },
        { label: "Measured on", key: "last_hba1c_date" },
        { label: "Last visit", key: "last_visit" },
        { label: "Days since", get: (r) => num(r.days_since_visit) },
      ],
      total: s.lapsed_uncontrolled_diabetics.length,
    },
    {
      title: "On a GLP-1 agonist with no follow-up measurement",
      lede: "Started the drug but has no HbA1c or weight recorded afterwards, so the response cannot be assessed.",
      rows: s.glp1_without_followup.slice(0, 60),
      columns: [
        { label: "Patient ID", key: "patient_id" },
        { label: "File no", key: "file_no" },
        { label: "Recorded start", key: "index_date" },
        { label: "Still on drug", get: (r) => (r.still_on_drug ? "Yes" : "No") },
        { label: "Follow-up HbA1c", get: (r) => (r.has_followup_hba1c ? "Yes" : "No") },
        { label: "Follow-up weight", get: (r) => (r.has_followup_weight ? "Yes" : "No") },
        { label: "Last visit", key: "last_visit" },
      ],
      total: s.glp1_without_followup.length,
    },
    {
      title: "Deteriorating on a headline marker",
      lede: "Moved in the wrong direction and now sits outside target.",
      rows: s.worsening_tier1.slice(0, 60),
      columns: [
        { label: "Patient ID", key: "patient_id" },
        { label: "File no", key: "file_no" },
        { label: "Marker", get: (r) => MARKERS[r.marker].label },
        { label: "First", get: (r) => dec(r.first_value, 2) },
        { label: "First recorded", key: "first_date" },
        { label: "Latest", get: (r) => dec(r.latest_value, 2) },
        { label: "Latest recorded", key: "latest_date" },
        { label: "Change", get: (r) => signed(r.change, 2), className: () => "neg" },
        { label: "Still attending", get: (r) => (r.continuing ? "Yes" : "No") },
      ],
      total: s.worsening_tier1.length,
    },
  ];

  return blocks
    .map(
      (b) =>
        `<h3>${esc(b.title)} <span class="pill">${num(b.total)} patients</span></h3>
         <p class="small">${esc(b.lede)} Showing the first ${Math.min(60, b.rows.length)}; the full list is in the workbook.</p>
         ${table(b.columns, b.rows)}`,
    )
    .join("");
}

function renderMethodology(report) {
  const m = report.meta;
  const items = [
    ["Report date", m.as_of],
    ["Generated at", m.generated_at],
    ["Engine version", m.engine_version],
    ["Build time", `${(m.build_ms / 1000).toFixed(1)} seconds`],
    ["Continuing definition", `a visit within ${m.continuity_days} days of the report date`],
    [
      "Baseline window for drug outcomes",
      `last value from ${m.baseline_window.beforeDays} days before to ${m.baseline_window.afterDays} days after the recorded start`,
    ],
    [
      "Follow-up windows",
      m.outcome_windows.map((w) => `${w.label}: days ${w.minDays} to ${w.maxDays}`).join("; "),
    ],
    ["Markers tracked", m.markers_tracked],
  ];

  const definitions = [
    "A visit is a distinct calendar day on which a patient had a consultation or an attended appointment. Consultations and appointments are merged so one day is never counted twice.",
    "Registration date is the patient's first recorded visit. The patients table carries a bulk-import timestamp in place of a real registration date, so it cannot be used.",
    "Condition prevalence counts distinct patients whose active problem list contains a diagnosis code matching that condition group. Codes are grouped by pattern, and negative findings such as euthyroid or normotensive are excluded.",
    "A biomarker value is the highest reading for that patient, marker and day, after discarding values outside a plausibility range. Lab results and clinic vitals are merged into one series per marker.",
    "At goal, borderline and off goal use the same thresholds as the rest of the Gini application, so a patient is never classified one way here and another way on their own record.",
    "Improving, stable and worsening compare a patient's first recorded value with their most recent, using the application's stability thresholds and target zones.",
    "Drug cohorts are built by resolving free-text medicine names to a molecule using an alias table with fuzzy matching for misspellings. Fixed-dose combinations count towards every component class.",
    "Outcome analyses are observational. Patients were not randomised and treatment was chosen by clinicians, so differences between cohorts reflect both the drug and who received it.",
  ];

  const limitations = [
    "The diagnoses table was first populated in February 2026 and different complications began being captured on different dates. Complication rates are therefore reported against an adjusted denominator restricted to patients seen after capture began.",
    "Appointment records begin in 2025, so attendance and no-show figures cannot extend earlier.",
    "Most medication start dates were entered retrospectively. Where this matters the report shows a sensitivity analysis rather than a single number.",
    "Stop reasons are almost always the automated sweep, so discontinuation can be detected but its cause cannot.",
    "UACR is reported in several different units across labs. Values are plausibility-clamped but not unit-converted, so UACR comparisons are indicative only.",
    "This report describes recorded care. A missing prescription or diagnosis may mean the record is incomplete rather than the care was not given.",
  ];

  return `<div class="tablewrap"><table><tbody>${items
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td style="text-align:left">${esc(v)}</td></tr>`)
    .join("")}</tbody></table></div>
     <h3>Definitions</h3>
     <div class="notes"><ul>${definitions.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>
     <h3>Limitations</h3>
     <div class="notes caveat"><ul>${limitations.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>`;
}

export function renderHtmlReport(report) {
  const sections = [
    {
      id: "s1",
      title: "1. The patient panel",
      lede: "How many patients Gini has, when they joined, and who they are.",
      body: renderRegistry(report.s1_registry),
    },
    {
      id: "s2",
      title: "2. Conditions",
      lede: "How many patients carry each condition, which conditions travel together, and the complication burden.",
      body: renderConditions(report.s2_conditions),
    },
    {
      id: "s3",
      title: "3. Are patients staying with Gini",
      lede: "Continuity of care, retention by joining cohort, and appointment attendance.",
      body: renderRetention(report.s3_retention),
    },
    {
      id: "s4",
      title: "4. Are patients getting better",
      lede: "Control against clinical targets and direction of travel across every measured marker.",
      body: renderBiomarkers(report.s4_biomarkers),
    },
    {
      id: "s5",
      title: "5. What Gini prescribes",
      lede: "The prescribing landscape, diabetes regimens, and gaps against standard guidance.",
      body: renderTreatment(report.s5_treatment),
    },
    {
      id: "s6",
      title: "6. Do the GLP-1 medicines work",
      lede: "Outcomes for semaglutide, tirzepatide and the rest, with comparator classes and an honest account of the uncertainty.",
      body: renderDrugOutcomes(report.s6_drug_outcomes),
    },
    {
      id: "s7",
      title: "7. How complete is the data",
      lede: "Coverage, completeness and the specific fixes that would most improve these numbers.",
      body: renderDataQuality(report.s7_data_quality),
    },
    {
      id: "s8",
      title: "8. Patients to act on",
      lede: "De-identified worklists drawn from the findings above.",
      body: renderWorklists(report.s8_worklists),
    },
    {
      id: "s9",
      title: "9. Method and limitations",
      lede: "Every definition, window and known weakness in one place.",
      body: renderMethodology(report),
    },
  ];

  const toc = sections.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("");

  return `<title>Gini Clinical Outcomes Report — ${esc(report.meta.as_of)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${buildCss()}</style>
<div class="wrap">
  <header class="report">
    <h1>Gini clinical outcomes report</h1>
    <p class="sub">Gini Advanced Care Hospital · position as at ${esc(report.meta.as_of)} · generated ${esc(report.meta.generated_at.slice(0, 16).replace("T", " "))} UTC · engine ${esc(report.meta.engine_version)}</p>
  </header>
  <nav class="toc" aria-label="Report sections"><ul>${toc}</ul></nav>
  ${sections.map((s) => section(s.id, s.title, s.lede, s.body)).join("")}
  <p class="small">This report contains no patient names, phone numbers or identity numbers. Worklists identify patients by internal ID and file number only.</p>
</div>
<script>${buildJs()}</script>`;
}
