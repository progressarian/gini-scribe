import { MARKERS } from "../constants.js";
import { CONDITION_LABELS } from "../conditions.js";

function sheetFrom(rows, columns) {
  const header = columns.map((c) => c.label);
  const body = rows.map((r) => columns.map((c) => (c.get ? c.get(r) : r[c.key]) ?? null));
  return [header, ...body];
}

function widths(aoa) {
  if (!aoa.length) return [];
  return aoa[0].map((_, i) => {
    const longest = aoa.reduce((max, row) => {
      const v = row[i] == null ? "" : String(row[i]);
      return Math.max(max, v.length);
    }, 8);
    return { wch: Math.min(52, longest + 2) };
  });
}

export async function buildWorkbook(report) {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();

  const add = (name, aoa) => {
    if (!aoa || aoa.length <= 1) return;
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = widths(aoa);
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };
    ws["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: aoa.length - 1, c: aoa[0].length - 1 },
      }),
    };
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  };

  const k = report.s1_registry.kpis;
  add("Summary", [
    ["Gini clinical outcomes report"],
    ["Position as at", report.meta.as_of],
    ["Generated at (UTC)", report.meta.generated_at],
    ["Engine version", report.meta.engine_version],
    [],
    ["Headline", "Value"],
    ["Registered patients", k.registered_patients],
    ["Patients with a recorded visit", k.patients_with_visit],
    ["Continuing (visit within 6 months)", k.continuing_patients],
    ["Continuing share %", k.continuing_share_pct],
    ["Lapsed", k.lapsed_patients],
    ["Median visits per patient", k.median_visits_per_patient],
    [],
    ["Diabetes control cascade", "Patients", "Share %"],
    ...report.s4_biomarkers.cascade.steps.map((s) => [s.step, s.patients, s.share_pct]),
    [],
    ["Privacy", "This workbook contains no patient names, phone numbers or identity numbers."],
    [
      "Note",
      "Every outcome table states its paired sample size. Cells with a small paired n are unstable.",
    ],
  ]);

  add(
    "Growth",
    sheetFrom(report.s1_registry.growth, [
      { label: "Quarter of first visit", key: "quarter" },
      { label: "New patients", key: "new_patients" },
      { label: "Cumulative patients", key: "cumulative" },
    ]),
  );

  add(
    "Visit volume",
    sheetFrom(report.s1_registry.visit_volume, [
      { label: "Month", key: "month" },
      { label: "Visits", key: "visits" },
      { label: "Distinct patients", key: "patients" },
    ]),
  );

  add(
    "Demographics",
    sheetFrom(report.s1_registry.demographics, [
      { label: "Age band", key: "age_band" },
      { label: "Female", key: "female" },
      { label: "Male", key: "male" },
      { label: "Not recorded", key: "unspecified" },
      { label: "Total", key: "total" },
    ]),
  );

  add(
    "Condition prevalence",
    sheetFrom(report.s2_conditions.prevalence, [
      { label: "Condition", key: "condition" },
      { label: "Patients", key: "patients" },
      { label: "Share of panel %", key: "share_of_panel_pct" },
      { label: "Continuing", key: "continuing" },
      { label: "Continuing %", key: "continuing_pct" },
      { label: "Lapsed", key: "lapsed" },
      { label: "Female", key: "female" },
      { label: "Male", key: "male" },
      { label: "Mean age", key: "mean_age" },
      { label: "First recorded on", key: "capture_start" },
    ]),
  );

  add(
    "Comorbidity matrix",
    sheetFrom(report.s2_conditions.comorbidity.matrix, [
      { label: "Condition", key: "condition" },
      ...report.s2_conditions.comorbidity.keys.map((key) => ({
        label: CONDITION_LABELS[key] || key,
        get: (r) => r[key],
      })),
    ]),
  );

  add(
    "Complications",
    sheetFrom(report.s2_conditions.complications.rows, [
      { label: "Complication", key: "complication" },
      { label: "Patients affected", key: "patients_affected" },
      { label: "Crude rate %", key: "crude_rate_pct" },
      { label: "Adjusted rate %", key: "adjusted_rate_pct" },
      { label: "Adjusted denominator", key: "eligible_denominator" },
      { label: "Capture start", key: "capture_start" },
    ]),
  );

  add(
    "Retention",
    sheetFrom(report.s3_retention.retention_curve, [
      { label: "Joining quarter", key: "cohort" },
      { label: "Cohort size", key: "size" },
      { label: "Returned within 180 days %", key: "retained_180d_pct" },
      { label: "Returned within 365 days %", key: "retained_365d_pct" },
      { label: "Still attending %", key: "still_active_pct" },
    ]),
  );

  add(
    "Retention by condition",
    sheetFrom(report.s3_retention.by_condition, [
      { label: "Condition", key: "condition" },
      { label: "Patients", key: "patients" },
      { label: "Continuing", key: "continuing" },
      { label: "Continuing %", key: "continuing_pct" },
      { label: "Lapsed", key: "lapsed" },
    ]),
  );

  add(
    "Biomarker control",
    sheetFrom(report.s4_biomarkers.control, [
      { label: "Marker", key: "label" },
      { label: "Unit", key: "unit" },
      { label: "Patients ever tested", key: "patients_any" },
      { label: "Tested in last 12 months", key: "patients_current" },
      { label: "Trendable patients", key: "patients_paired" },
      { label: "At goal %", key: "at_goal_pct" },
      { label: "Borderline %", key: "borderline_pct" },
      { label: "Off goal %", key: "off_goal_pct" },
      { label: "Improving %", key: "improving_pct" },
      { label: "Stable %", key: "stable_pct" },
      { label: "Worsening %", key: "worsening_pct" },
      { label: "Median latest value", get: (r) => r.latest_values.median },
      { label: "Mean change first to latest", get: (r) => r.change_first_to_last.mean },
    ]),
  );

  add(
    "Control by condition",
    sheetFrom(report.s4_biomarkers.by_condition, [
      { label: "Condition", get: (r) => CONDITION_LABELS[r.condition] || r.condition },
      { label: "Marker", get: (r) => MARKERS[r.marker].label },
      { label: "Patients", key: "patients" },
      { label: "At goal %", key: "at_goal_pct" },
      { label: "Borderline %", key: "borderline_pct" },
      { label: "Off goal %", key: "off_goal_pct" },
      { label: "Median", key: "median" },
    ]),
  );

  add(
    "Trajectory by condition",
    sheetFrom(report.s4_biomarkers.trajectory_by_condition, [
      { label: "Condition", get: (r) => CONDITION_LABELS[r.condition] || r.condition },
      { label: "Marker", get: (r) => MARKERS[r.marker].label },
      { label: "Trendable patients", key: "patients_paired" },
      { label: "Improving %", key: "improving_pct" },
      { label: "Stable %", key: "stable_pct" },
      { label: "Worsening %", key: "worsening_pct" },
      { label: "Mean change", key: "mean_change" },
      { label: "Median change", key: "median_change" },
    ]),
  );

  add(
    "Continuing vs lapsed",
    sheetFrom(report.s4_biomarkers.by_continuity, [
      { label: "Marker", get: (r) => MARKERS[r.marker].label },
      { label: "Group", key: "group" },
      { label: "Patients", key: "patients" },
      { label: "At goal %", key: "at_goal_pct" },
      { label: "Off goal %", key: "off_goal_pct" },
      { label: "Median", key: "median" },
    ]),
  );

  add(
    "Prescribing",
    sheetFrom(report.s5_treatment.landscape.classes, [
      { label: "Drug class", key: "drug_class" },
      { label: "Patients ever prescribed", key: "patients_ever" },
      { label: "Patients currently active", key: "patients_active" },
      { label: "Share of panel %", key: "share_of_panel_pct" },
    ]),
  );

  add(
    "Diabetes regimens",
    sheetFrom(report.s5_treatment.regimen.top_combinations, [
      { label: "Combination", key: "combination" },
      { label: "Patients", key: "patients" },
      { label: "Share of diabetics %", key: "share_pct" },
    ]),
  );

  add(
    "Guideline gaps",
    sheetFrom(report.s5_treatment.gaps, [
      { label: "Gap", key: "gap" },
      { label: "Eligible patients", key: "eligible_patients" },
      { label: "Patients with gap", key: "patients_with_gap" },
      { label: "Gap rate %", key: "gap_rate_pct" },
    ]),
  );

  add(
    "Drug outcomes",
    sheetFrom(report.s6_drug_outcomes.outcomes, [
      { label: "Cohort", key: "cohort_label" },
      { label: "Marker", key: "marker_label" },
      { label: "Window", key: "window_label" },
      { label: "Cohort size", key: "cohort_size" },
      { label: "With baseline", key: "with_baseline" },
      { label: "Paired n", key: "paired_n" },
      { label: "Baseline mean", get: (r) => r.baseline.mean },
      { label: "Baseline median", get: (r) => r.baseline.median },
      { label: "Follow-up mean", get: (r) => r.followup.mean },
      { label: "Mean change", get: (r) => r.change.mean },
      { label: "Median change", get: (r) => r.change.median },
      { label: "Mean % change", get: (r) => r.pct_change.mean },
      { label: "Median days to follow-up", key: "median_days_after" },
      { label: "Reached under 7% (HbA1c)", key: "reached_under_7_rate" },
      { label: "Fell 1%+ (HbA1c)", key: "drop_ge_1pct_rate" },
      { label: "Lost 5%+ (weight)", key: "loss_ge_5pct_rate" },
      { label: "Lost 10%+ (weight)", key: "loss_ge_10pct_rate" },
      { label: "Lost 15%+ (weight)", key: "loss_ge_15pct_rate" },
    ]),
  );

  const sensitivity = [
    ...report.s6_drug_outcomes.sensitivity_weight.rows.map((r) => ({
      ...r,
      outcome: "Weight, 6 months",
    })),
    ...report.s6_drug_outcomes.sensitivity_hba1c.rows.map((r) => ({
      ...r,
      outcome: "HbA1c, 6 months",
    })),
  ];
  add(
    "Outcome sensitivity",
    sheetFrom(sensitivity, [
      { label: "Outcome", key: "outcome" },
      { label: "Cohort", key: "cohort_label" },
      { label: "Index-date definition", key: "stratum_label" },
      { label: "Paired n", key: "paired_n" },
      { label: "Mean change", key: "mean_change" },
      { label: "Median change", key: "median_change" },
      { label: "Mean % change", key: "mean_pct_change" },
      { label: "Responder rate %", key: "responder_rate_pct" },
    ]),
  );

  add(
    "Drug persistence",
    sheetFrom(report.s6_drug_outcomes.persistence, [
      { label: "Cohort", key: "cohort_label" },
      { label: "Patients", key: "patients" },
      { label: "Still on drug", key: "still_on_drug" },
      { label: "Still on drug %", key: "still_on_drug_pct" },
      { label: "Discontinued", key: "discontinued" },
      { label: "Median days on drug", get: (r) => r.time_on_drug_days.median },
    ]),
  );

  const titration = report.s6_drug_outcomes.titration.flatMap((t) =>
    t.doses.map((d) => ({ molecule: t.molecule_label, ...d })),
  );
  add(
    "Titration",
    sheetFrom(titration, [
      { label: "Molecule", key: "molecule" },
      { label: "Dose (mg)", key: "dose_mg" },
      { label: "Patients", key: "patients" },
      { label: "Prescriptions", key: "prescriptions" },
    ]),
  );

  add(
    "Data coverage",
    sheetFrom(report.s7_data_quality.coverage_funnel, [
      { label: "Step", key: "step" },
      { label: "Patients", key: "patients" },
      { label: "Share %", key: "share_pct" },
    ]),
  );

  add(
    "Unresolved drug names",
    sheetFrom(report.s7_data_quality.unmatched_drugs, [
      { label: "Recorded name", key: "name" },
      { label: "Rows", key: "rows" },
      { label: "Patients", key: "patients" },
      { label: "Classify as (fill in)", get: () => "" },
    ]),
  );

  add(
    "Unmapped diagnoses",
    sheetFrom(report.s7_data_quality.unmapped_diagnoses, [
      { label: "Diagnosis code", key: "slug" },
      { label: "Rows", key: "rows" },
      { label: "Patients", key: "patients" },
      { label: "Map to condition (fill in)", get: () => "" },
    ]),
  );

  add(
    "LL lapsed uncontrolled",
    sheetFrom(report.s8_worklists.lapsed_uncontrolled_diabetics, [
      { label: "Patient ID", key: "patient_id" },
      { label: "File no", key: "file_no" },
      { label: "Age", key: "age" },
      { label: "Sex", key: "sex" },
      { label: "Last HbA1c", key: "last_hba1c" },
      { label: "Measured on", key: "last_hba1c_date" },
      { label: "Last visit", key: "last_visit" },
      { label: "Days since visit", key: "days_since_visit" },
    ]),
  );

  add(
    "LL GLP1 no followup",
    sheetFrom(report.s8_worklists.glp1_without_followup, [
      { label: "Patient ID", key: "patient_id" },
      { label: "File no", key: "file_no" },
      { label: "Recorded start", key: "index_date" },
      { label: "Still on drug", get: (r) => (r.still_on_drug ? "Yes" : "No") },
      { label: "Has follow-up HbA1c", get: (r) => (r.has_followup_hba1c ? "Yes" : "No") },
      { label: "Has follow-up weight", get: (r) => (r.has_followup_weight ? "Yes" : "No") },
      { label: "Last visit", key: "last_visit" },
    ]),
  );

  add(
    "LL deteriorating",
    sheetFrom(report.s8_worklists.worsening_tier1, [
      { label: "Patient ID", key: "patient_id" },
      { label: "File no", key: "file_no" },
      { label: "Marker", get: (r) => MARKERS[r.marker].label },
      { label: "First value", key: "first_value" },
      { label: "First recorded", key: "first_date" },
      { label: "Latest value", key: "latest_value" },
      { label: "Latest recorded", key: "latest_date" },
      { label: "Change", key: "change" },
      { label: "Still attending", get: (r) => (r.continuing ? "Yes" : "No") },
    ]),
  );

  add(
    "LL guideline gaps",
    sheetFrom(report.s8_worklists.guideline_gaps, [
      { label: "Patient ID", key: "patient_id" },
      { label: "File no", key: "file_no" },
      { label: "Gap", key: "gap" },
      { label: "Still attending", get: (r) => (r.continuing ? "Yes" : "No") },
      { label: "Last visit", key: "last_visit" },
    ]),
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
