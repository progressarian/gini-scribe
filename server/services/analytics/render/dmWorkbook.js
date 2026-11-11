const S = (s) => (s ? [s.n, s.d, s.pct] : [null, null, null]);
const SH = (label) => [`${label} n`, `${label} denominator`, `${label} %`];

const OUTCOME_HEAD = [
  "Paired patients",
  "Mean baseline HbA1c",
  "Median baseline HbA1c",
  "Mean follow-up HbA1c",
  "Median follow-up HbA1c",
  "Mean paired change",
  "Median paired change",
  ...SH("Any improvement"),
  ...SH("Improved ≥0.5"),
  ...SH("Improved ≥1.0"),
  ...SH("Worsened ≥0.5"),
  ...SH("Below 7% at follow-up"),
  ...SH("Reached <7% (baseline ≥7)"),
  ...SH("Stayed <7% (baseline <7)"),
  "Mean change 95% CI low",
  "Mean change 95% CI high",
  "Improved ≥0.5 95% CI low %",
  "Improved ≥0.5 95% CI high %",
];

const outcomeCells = (o) => [
  o.n,
  o.baseline_mean,
  o.baseline_median,
  o.follow_mean,
  o.follow_median,
  o.change_mean,
  o.change_median,
  ...S(o.any_improvement),
  ...S(o.improved_05),
  ...S(o.improved_10),
  ...S(o.worsened_05),
  ...S(o.below7_at_follow),
  ...S(o.reached_below7),
  ...S(o.maintained_below7),
  o.change_ci95?.[0] ?? null,
  o.change_ci95?.[1] ?? null,
  o.improved_05.ci95?.[0] ?? null,
  o.improved_05.ci95?.[1] ?? null,
];

function windowSheet(windows) {
  return [
    [
      "Window",
      "Measurement range (days)",
      "Median days to follow-up",
      "Eligible",
      "Eligible with baseline",
      ...SH("Measured"),
      ...SH("Missing"),
      ...OUTCOME_HEAD,
    ],
    ...windows.map((w) => [
      w.label,
      `${w.measurement_range_days[0]}–${w.measurement_range_days[1]}`,
      w.median_days_to_followup,
      w.eligible,
      w.with_baseline,
      ...S(w.measured),
      ...S(w.missing),
      ...outcomeCells(w.outcome),
    ]),
  ];
}

export async function buildDmWorkbook(report) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const add = (name, aoa) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = aoa[0].map((_, i) => ({
      wch: Math.min(48, Math.max(10, ...aoa.map((r) => String(r[i] ?? "").length + 2))),
    }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  };
  const m = report.meta;
  const f = report.funnel;
  const w = Object.fromEntries(report.hba1c.windows.map((x) => [x.window, x]));
  const tr = Object.fromEntries(report.treatments.map((t) => [t.key, t]));
  const ctl = report.latest_control.all;

  add("Press summary", [
    ["Gini diabetes outcomes — press summary (draft for clinical review)"],
    ["Reporting period", `${m.period.start} to ${m.period.end}`],
    ["Generated (UTC)", m.generated_at],
    [],
    ["#", "Item", "Value", "Numerator", "Denominator", "%", "Definition"],
    [
      1,
      "Unique diabetes patients",
      f.registry,
      null,
      null,
      null,
      "Diagnosis or 2 HbA1c ≥6.5% on different dates, with a visit in the period",
    ],
    [
      2,
      "Patients with 2+ HbA1c values",
      f.with_two_plus_hba1c.n,
      ...S(f.with_two_plus_hba1c),
      "Distinct dated HbA1c readings inside the period",
    ],
    [
      3,
      "Patients with 3+ visits",
      f.three_plus_visits.n,
      ...S(f.three_plus_visits),
      "Distinct visit days",
    ],
    [
      3,
      "3+ visits spanning ≥6 months",
      f.three_visits_over_six_months.n,
      ...S(f.three_visits_over_six_months),
      "",
    ],
    [
      4,
      "Eligible at 6 months",
      w.m6.eligible,
      null,
      null,
      null,
      "First visit ≥270 days before period end",
    ],
    [
      4,
      "Measured at 6 months",
      w.m6.measured.n,
      ...S(w.m6.measured),
      "Among eligible with baseline; HbA1c 151–270 days",
    ],
    [
      4,
      "Eligible at 12 months",
      w.m12.eligible,
      null,
      null,
      null,
      "First visit ≥450 days before period end",
    ],
    [
      4,
      "Measured at 12 months",
      w.m12.measured.n,
      ...S(w.m12.measured),
      "Among eligible with baseline; HbA1c 271–450 days",
    ],
    [
      5,
      "Mean paired HbA1c change, 6 months",
      w.m6.outcome.change_mean,
      null,
      w.m6.outcome.n,
      null,
      "Percentage points; median " + w.m6.outcome.change_median,
    ],
    [
      5,
      "Mean paired HbA1c change, 12 months",
      w.m12.outcome.change_mean,
      null,
      w.m12.outcome.n,
      null,
      "Percentage points; median " + w.m12.outcome.change_median,
    ],
    [
      6,
      "Improved ≥0.5 points, 6 months",
      w.m6.outcome.improved_05.pct,
      ...S(w.m6.outcome.improved_05),
      "",
    ],
    [
      6,
      "Improved ≥0.5 points, 12 months",
      w.m12.outcome.improved_05.pct,
      ...S(w.m12.outcome.improved_05),
      "",
    ],
    [
      7,
      "Reached <7%, 12 months",
      w.m12.outcome.reached_below7.pct,
      ...S(w.m12.outcome.reached_below7),
      "Among baseline ≥7%",
    ],
    [
      7,
      "Stayed <7%, 12 months",
      w.m12.outcome.maintained_below7.pct,
      ...S(w.m12.outcome.maintained_below7),
      "Among baseline <7%",
    ],
    [
      8,
      "All three at target (latest)",
      ctl.among_complete.all_three.pct,
      ...S(ctl.among_complete.all_three),
      "HbA1c <7, BP <130/80, LDL <100; patients with all three measured",
    ],
    [
      9,
      "GLP-1 / tirzepatide patients",
      tr.any_incretin.started_in_period,
      null,
      null,
      null,
      `Started at Gini: ${tr.any_incretin.new_starts}`,
    ],
    [
      9,
      "Weekly insulin (icodec) patients",
      tr.weekly_insulin.started_in_period,
      null,
      null,
      null,
      `First prescribed ${tr.weekly_insulin.first_start}; no 3-month outcomes yet`,
    ],
    [
      "5b",
      "New to Gini 2025–26: mean HbA1c change, 12 months",
      report.new_patients.windows[2].outcome.change_mean,
      null,
      report.new_patients.windows[2].outcome.n,
      null,
      `95% CI ${report.new_patients.windows[2].outcome.change_ci95?.join(" to ")}; ${report.new_patients.windows[2].outcome.baseline_mean} → ${report.new_patients.windows[2].outcome.follow_mean}`,
    ],
    [
      "5c",
      "Mean paired HbA1c change 12 months, 95% CI",
      w.m12.outcome.change_ci95?.join(" to "),
      null,
      w.m12.outcome.n,
      null,
      "All patients",
    ],
    [
      10,
      "Missing 12-month outcome",
      w.m12.missing.pct,
      ...S(w.m12.missing),
      "Never counted as success or failure",
    ],
  ]);

  add("Funnel", [
    ["Group", "Patients", "Denominator", "%"],
    ["All diabetes patients", f.registry, f.registry, 100],
    ["Defined by diagnosis", f.by_definition.diagnosis, f.registry, null],
    ["Defined by 2 HbA1c ≥6.5%", f.by_definition.lab_confirmed, f.registry, null],
    ["On diabetes medicine", ...S(f.confirmation.medicine)],
    ["Confirmed by HbA1c ≥6.5% only", ...S(f.confirmation.hba1c_only)],
    ["Unconfirmed (diagnosis only)", ...S(f.confirmation.unconfirmed)],
    ["New to Gini 2025–26", f.new_patients, f.registry, (f.new_patients / f.registry) * 100],
    ["Single visit only", ...S(f.single_visit)],
    ["With baseline HbA1c", ...S(f.with_baseline_hba1c)],
    ["With any HbA1c in period", ...S(f.with_any_hba1c_in_period)],
    ["With 2+ HbA1c", ...S(f.with_two_plus_hba1c)],
    ["3+ visits", ...S(f.three_plus_visits)],
    ["3+ visits over ≥6 months", ...S(f.three_visits_over_six_months)],
    [],
    ["Window", "Eligible", "Too recent", "Eligible with baseline", "Measured", "Denominator", "%"],
    ...f.windows.map((x) => [x.label, x.eligible, x.too_recent, x.with_baseline, ...S(x.measured)]),
  ]);

  const d = report.demographics;
  add("Demographics", [
    ["Dimension", "Group", "Patients", "Denominator", "%"],
    ...d.sex.map((x) => ["Sex", x.sex, ...S(x)]),
    ...d.dm_type.map((x) => ["Diabetes type", x.type, ...S(x)]),
    ...d.age_at_enrollment.bands.map((x) => ["Age at first visit", x.band, ...S(x)]),
    ["Age at first visit", "Not recorded", ...S(d.age_at_enrollment.unknown)],
    ...d.enrollment_by_year.map((x) => [
      "First visit year",
      x.year,
      x.patients,
      f.registry,
      (x.patients / f.registry) * 100,
    ]),
  ]);

  add("HbA1c by window", windowSheet(report.hba1c.windows));
  add("HbA1c lab-only", windowSheet(report.hba1c.lab_confirmed_only));
  add("HbA1c new to Gini 2025-26", windowSheet(report.new_patients.windows));
  add("HbA1c confirmed diabetes", windowSheet(report.confirmed_only));
  add("HbA1c by severity", [
    ["Window", "Baseline band", ...OUTCOME_HEAD],
    ...report.hba1c.windows.flatMap((x) =>
      x.by_severity.map((b) => [x.label, b.band, ...outcomeCells(b)]),
    ),
  ]);
  add("HbA1c by first-visit year", [
    [
      "First visit year",
      "Enrolled",
      "Window",
      "Eligible",
      "With baseline",
      ...SH("Measured"),
      "Mean change",
      ...SH("Improved ≥0.5"),
    ],
    ...report.hba1c.by_enrollment_year.flatMap((y) =>
      y.windows.map((x) => [
        y.enrollment_year,
        y.enrolled,
        x.window,
        x.eligible,
        x.with_baseline,
        ...S(x.measured),
        x.change_mean,
        ...S(x.improved_05),
      ]),
    ),
  ]);

  add("Other markers", [
    [
      "Marker",
      "Window",
      "Eligible",
      "With baseline",
      ...SH("Measured"),
      "Mean baseline",
      "Mean follow-up",
      "Mean change",
      "Median change",
      "Mean % change",
    ],
    ...Object.entries(report.other_markers).flatMap(([k, byW]) =>
      Object.entries(byW).map(([wk, r]) => [
        k,
        wk,
        r.eligible,
        r.with_baseline,
        ...S(r.measured),
        r.baseline_mean,
        r.follow_mean,
        r.change_mean,
        r.change_median,
        r.pct_change_mean,
      ]),
    ),
  ]);

  add("Kidney", [
    [
      "Window",
      "Marker",
      "With baseline",
      ...SH("Measured"),
      "Median baseline",
      "Median follow-up",
      ...SH("Stage better"),
      ...SH("Stage same"),
      ...SH("Stage worse"),
      ...SH("Fell ≥30%"),
    ],
    ...Object.entries(report.kidney).flatMap(([wk, k]) => [
      [
        wk,
        "UACR",
        k.uacr.with_baseline,
        ...S(k.uacr.measured),
        k.uacr.median_baseline,
        k.uacr.median_follow,
        ...S(k.uacr.stage_better),
        ...S(k.uacr.stage_same),
        ...S(k.uacr.stage_worse),
        ...S(k.uacr.albuminuric_fell_30pct),
      ],
      [
        wk,
        "eGFR",
        k.egfr.with_baseline,
        ...S(k.egfr.measured),
        k.egfr.median_baseline,
        k.egfr.median_follow,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        ...S(k.egfr.fell_30pct),
      ],
    ]),
  ]);

  const ctlRows = (label, c) => [
    [label, "Patients with all three measured", ...S(c.complete)],
    ...Object.entries(c.among_complete).map(([k, s]) => [label, k, ...S(s)]),
    ...Object.entries(c.each_marker).map(([k, s]) => [label, `${k} (each marker alone)`, ...S(s)]),
  ];
  add("Combined control", [
    ["Population", "Measure", "n", "Denominator", "%"],
    ...ctlRows("All patients", report.latest_control.all),
    ...ctlRows("Seen in last 6 months", report.latest_control.active_only),
    [],
    [
      "Window",
      "Eligible",
      "With all three at both times",
      ...SH("All three at baseline"),
      ...SH("All three at follow-up"),
    ],
    ...report.combined_control_change.map((r) => [
      r.window,
      r.eligible,
      r.complete_pairs,
      ...S(r.all_three_at_baseline),
      ...S(r.all_three_at_follow_up),
    ]),
  ]);

  const txRows = (t, view, src) =>
    ["m3", "m6", "m12"].map((wk) => {
      const a = src[wk].hba1c;
      const wt = src[wk].weight;
      return [
        t.label,
        view,
        wk,
        a.eligible,
        a.with_baseline,
        ...S(a.measured),
        a.n,
        a.change_mean,
        a.change_median,
        ...S(a.improved_05),
        ...S(a.below7_at_follow),
        wt.n,
        wt.change_mean,
        wt.pct_change_mean,
      ];
    });
  add("Treatments", [
    [
      "Treatment",
      "View",
      "Window",
      "Eligible",
      "With baseline",
      ...SH("Measured"),
      "Paired n",
      "Mean HbA1c change",
      "Median HbA1c change",
      ...SH("Improved ≥0.5"),
      ...SH("Below 7%"),
      "Weight n",
      "Mean weight change (kg)",
      "Mean weight change %",
    ],
    ...report.treatments.flatMap((t) => [
      ...txRows(t, `Started at Gini (n=${t.new_starts})`, t.new_start),
      ...txRows(t, `All prescribed (n=${t.started_in_period})`, t),
    ]),
  ]);

  const e = report.engagement;
  add("Engagement", [
    ["Status", "Patients", "Denominator", "%"],
    ...e.status.map((s) => [s.status, ...S(s)]),
    ["Deceased / transferred", "not recorded", null, null],
    [],
    [
      "First visit year",
      "Enrolled",
      ...["m3", "m6", "m12", "m24"].flatMap((k) => SH(`Visit at ${k}`)),
    ],
    ...e.retention_by_enrollment_year.map((r) => [
      r.enrollment_year,
      r.enrolled,
      ...["m3", "m6", "m12", "m24"].flatMap((k) => S(r[k].visit_in_window)),
    ]),
    [],
    ["Long-gap patients: last known HbA1c (historical, not a current outcome)"],
    ["Patients with a value", e.long_gap_last_known_hba1c.n, "of", e.long_gap_last_known_hba1c.of],
    ["Mean", e.long_gap_last_known_hba1c.mean, "Median", e.long_gap_last_known_hba1c.median],
    ["Below 7%", ...S(e.long_gap_last_known_hba1c.below7)],
  ]);

  const bias = (label, c) =>
    [
      ["measured", c.measured],
      ["not measured", c.not_measured],
    ].map(([g, p]) => [
      label,
      g,
      p.n,
      p.mean_age,
      ...S(p.female),
      p.mean_baseline_hba1c,
      p.median_visits,
      ...S(p.type1),
    ]);
  add("Missing vs measured", [
    [
      "Window",
      "Group",
      "Patients",
      "Mean age",
      ...SH("Female"),
      "Mean baseline HbA1c",
      "Median visits",
      ...SH("Type 1 / LADA"),
    ],
    ...bias("6 months", report.hba1c.missing_vs_measured_6m),
    ...bias("12 months", report.hba1c.missing_vs_measured_12m),
  ]);

  add("Complications", [
    ["Complication (recorded diagnosis)", "Patients", "Denominator", "%"],
    ...report.complications.rows.map((r) => [r.label, ...S(r)]),
    ["Any microvascular", ...S(report.complications.any_microvascular)],
    ["Any macrovascular", ...S(report.complications.any_macrovascular)],
  ]);

  add("Data quality", [
    ["Item", "Value"],
    ["HbA1c/marker readings loaded", m.readings_loaded],
    ["Repeat copies from notes removed", m.readings_dropped.repeated_copy],
    ["HbA1c on 1 January (placeholder) removed", m.readings_dropped.placeholder_date],
    ["Carried-forward weight/BMI vitals removed", m.readings_dropped.carried_forward],
    ["Duplicate patient records merged", m.duplicate_records_merged],
    ["Deaths / transfers", m.deaths_transfers],
    ["Lab-confirmed sources", m.lab_confirmed_sources.join(", ")],
    [
      "Recording gap",
      "Apr 2024 – Feb 2025: ~70% fewer consultations and far fewer HbA1c values recorded",
    ],
    ["Records start", "Effectively January 2022 (only 4 patients seen Nov–Dec 2021)"],
    ["CGM", "About 12 patients with any CGM value — not analysed"],
  ]);

  add("Definitions", [
    ["Term", "Definition"],
    ["Index date", "First visit (consultation or attended appointment) in the period"],
    [
      "Baseline",
      `Reading closest to index, ${m.baseline.beforeDays} days before to ${m.baseline.afterDays} days after; tie → earlier`,
    ],
    ...m.windows.map((x) => [
      `${x.label} window`,
      `${x.minDays}–${x.maxDays} days after index, nearest to day ${x.targetDays}; tie → later; eligible if index + ${x.maxDays} days ≤ period end`,
    ]),
    [
      "Measured / missing",
      "Eligible with baseline and a reading in the window / without one. Missing is never counted as success or failure.",
    ],
    ["Active / overdue / long gap", "Last visit ≤180 / 181–365 / >365 days before period end"],
    ["Started at Gini", "Drug first prescribed ≥30 days after the first recorded visit"],
    ["Full method", "docs/DM_OUTCOMES_METHODOLOGY.md"],
  ]);

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
