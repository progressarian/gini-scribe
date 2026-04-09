// Server-side rule engine — mirrors src/components/visit/summaryRules.js
// No React imports. Pure JS.

const LAB_ALIASES = {
  HbA1c: ["HbA1c", "Glycated Hemoglobin", "A1c", "Glycated Haemoglobin", "HBA1C"],
  FBS: [
    "FBS",
    "Fasting Glucose",
    "Fasting Blood Sugar",
    "FPG",
    "Fasting Plasma Glucose",
    "FASTING BLOOD SUGAR",
  ],
  LDL: ["LDL", "LDL Cholesterol", "LDL-C", "LDL CHOLESTEROL-DIRECT"],
  TG: ["TG", "Triglycerides", "TRIGLYCERIDES"],
  Creatinine: ["Creatinine", "S.Creatinine", "Serum Creatinine", "CREATININE"],
  eGFR: ["eGFR", "GFR", "Estimated GFR"],
  TSH: ["TSH", "Thyroid Stimulating Hormone", "THYROID STIMULATING HORMONE"],
  UACR: ["UACR", "Urine ACR", "Microalbumin"],
};

function findLab(labs, name) {
  const aliases = LAB_ALIASES[name] || [name];
  return (labs || []).find((l) =>
    aliases.some(
      (a) =>
        (l.canonical_name || "").toLowerCase() === a.toLowerCase() ||
        (l.test_name || "").toLowerCase() === a.toLowerCase(),
    ),
  );
}

function findLabHistory(labHistory, name) {
  const aliases = LAB_ALIASES[name] || [name];
  for (const a of aliases) {
    for (const key of Object.keys(labHistory || {})) {
      if (key.toLowerCase() === a.toLowerCase()) return labHistory[key];
    }
  }
  return [];
}

function getLabVal(labResults, name) {
  const r = findLab(labResults, name);
  return r ? { result: r.result, unit: r.unit || "", flag: r.flag, date: r.test_date } : null;
}

// Returns oldest-first (reversed from DB order which is newest-first)
function getLabHist(labHistory, name) {
  const h = findLabHistory(labHistory, name);
  return h ? h.slice().reverse() : [];
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  return Math.round((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function hasDx(diagnoses, id, ...labelKeywords) {
  return (diagnoses || []).some(
    (d) =>
      d.diagnosis_id === id ||
      labelKeywords.some((kw) => (d.label || "").toLowerCase().includes(kw.toLowerCase())),
  );
}

function numVal(labResults, name) {
  const v = getLabVal(labResults || [], name);
  return v?.result != null ? parseFloat(v.result) : null;
}

export function runSummaryRules({
  diagnoses = [],
  labResults = [],
  labHistory = {},
  vitals = [],
  documents = [],
  prep = {},
}) {
  const red = [];
  const amber = [];
  const green = [];

  const latestV = vitals[0] || null;
  const prevV = vitals[1] || null;

  const isT2DM = hasDx(diagnoses, "dm2", "type 2 diabetes", "t2dm", "diabetes mellitus");
  const isHTN = hasDx(diagnoses, "htn", "hypertension");
  const isHypo = hasDx(diagnoses, "hypo", "hypothyroid");

  const hba1c = numVal(labResults, "HbA1c");
  const hba1cInfo = getLabVal(labResults, "HbA1c");
  const uacr = numVal(labResults, "UACR");
  const egfr = numVal(labResults, "eGFR");
  const ldl = numVal(labResults, "LDL");
  const tshInfo = getLabVal(labResults, "TSH");
  const tsh = tshInfo ? parseFloat(tshInfo.result) : null;

  const hba1cH = getLabHist(labHistory, "HbA1c");
  const uacrH = getLabHist(labHistory, "UACR");

  // ─── RED ─────────────────────────────────────────────────────────────────────

  // R2: HbA1c rising for 3 consecutive visits
  if (hba1cH.length >= 3) {
    const [a, b, c] = hba1cH.slice(-3).map((v) => parseFloat(v.result));
    if (c > b && b > a && !isNaN(a) && !isNaN(b) && !isNaN(c)) {
      red.push({
        id: "r2_hba1c_rising",
        title: `HbA1c rising for 3rd consecutive visit (${a}→${b}→${c}%)`,
        detail: "Current regimen is not achieving glycaemic control.",
        action: "Regimen intensification or insulin initiation to consider",
      });
    }
  }

  // R3: HbA1c critically high (> 10%)
  if (hba1c != null && hba1c > 10) {
    red.push({
      id: "r3_hba1c_critical",
      title: `HbA1c ${hba1c}% — critically elevated`,
      detail: "Target ≤ 7.0% for most T2DM patients.",
      action: "Insulin initiation or intensification to consider",
    });
  }

  // R5: Unreviewed documents uploaded by coordinator
  const unreviewed = documents.filter((d) => d.reviewed === false);
  if (unreviewed.length > 0) {
    const names = unreviewed.map((d) => d.title || d.file_name || "Report").join(", ");
    red.push({
      id: "r5_unreviewed_docs",
      title: `${unreviewed.length} unreviewed report${unreviewed.length > 1 ? "s" : ""} uploaded`,
      detail: names,
      action: "Review before prescribing",
    });
  }

  // R6: Compliance critically low (< 50%)
  if (prep.medPct != null && prep.medPct < 50) {
    red.push({
      id: "r6_compliance_critical",
      title: `Medication compliance ${prep.medPct}% — critically low`,
      detail: "Patient is missing more than half their doses.",
      action: "Discuss barriers — consider simpler regimen or pill organiser",
    });
  }

  // R7: BP critically elevated and worsening
  if (latestV?.bp_sys != null && latestV.bp_sys > 150 && prevV?.bp_sys != null) {
    if (latestV.bp_sys > prevV.bp_sys) {
      red.push({
        id: "r7_bp_critical",
        title: `BP ${latestV.bp_sys}/${latestV.bp_dia ?? "?"} — elevated and rising (prev: ${prevV.bp_sys}/${prevV.bp_dia ?? "?"})`,
        detail: "Uncontrolled and worsening hypertension.",
        action: "Antihypertensive review needed this visit",
      });
    }
  }

  // R8: UACR worsening trajectory
  if (uacrH.length >= 3) {
    const [a, b, c] = uacrH.slice(-3).map((v) => parseFloat(v.result));
    if (c > b && b > a && c > 60 && !isNaN(a) && !isNaN(b) && !isNaN(c)) {
      red.push({
        id: "r8_uacr_worsening",
        title: `UACR worsening: ${a}→${b}→${c} mg/g over 3 visits`,
        detail: "Nephropathy progressing — urgent renoprotective review.",
        action: "Maximise ACE/ARB dose; consider nephrology referral",
      });
    }
  }

  // ─── AMBER ───────────────────────────────────────────────────────────────────

  // A1a: HbA1c overdue in T2DM
  if (isT2DM && hba1cInfo?.date) {
    const d = daysSince(hba1cInfo.date);
    if (d > 90) {
      amber.push({
        id: "a1_hba1c_overdue",
        title: `HbA1c overdue — last done ${d} days ago`,
        detail: "Recommended every 3 months for T2DM patients.",
        action: "Add to today's lab orders",
      });
    }
  }

  // A1b: TSH overdue (hypothyroid patients)
  if (isHypo && tshInfo?.date) {
    const d = daysSince(tshInfo.date);
    if (d > 90) {
      amber.push({
        id: "a1_tsh_overdue",
        title: `TSH not checked in ${d} days — patient has hypothyroidism`,
        detail: "Thyroid function should be monitored every 3 months.",
        action: "Add TSH to today's lab orders",
      });
    }
  }

  // A: BP borderline elevated
  if (
    isHTN &&
    latestV?.bp_sys != null &&
    latestV.bp_sys >= 130 &&
    latestV.bp_sys <= 150 &&
    !red.some((r) => r.id === "r7_bp_critical")
  ) {
    amber.push({
      id: "a_bp_borderline",
      title: `BP ${latestV.bp_sys}/${latestV.bp_dia ?? "?"} — borderline elevated`,
      detail: "Target < 130/80 mmHg for hypertension patients.",
      action: "Review antihypertensive regimen",
    });
  }

  // A: TSH elevated in hypothyroid patients
  if (isHypo && tsh != null && tsh > 4.5) {
    amber.push({
      id: "a_tsh_elevated",
      title: `TSH ${tsh} µIU/mL — elevated in hypothyroid patient`,
      detail: "Under-replaced hypothyroidism.",
      action: "Consider dose adjustment",
    });
  }

  // A5: Moderate compliance (50–79%)
  if (prep.medPct != null && prep.medPct >= 50 && prep.medPct < 80) {
    amber.push({
      id: "a5_compliance_moderate",
      title: `Medication compliance ${prep.medPct}% — moderate`,
      detail: "Patient is missing roughly 1 in 4–5 doses.",
      action: "Ask about barriers — simplify regimen if possible",
    });
  }

  // A6: Symptoms reported by coordinator
  if (prep.symptoms?.length > 0) {
    amber.push({
      id: "a6_symptoms_reported",
      title: `${prep.symptoms.length} symptom${prep.symptoms.length > 1 ? "s" : ""} reported since last visit`,
      detail: prep.symptoms.join(" · "),
      action: "Ask the patient about these today",
    });
  }

  // ─── GREEN ────────────────────────────────────────────────────────────────────

  // G4: Near remission
  let g4Fired = false;
  if (hba1cH.length >= 2) {
    const [prev, curr] = hba1cH.slice(-2).map((v) => parseFloat(v.result));
    if (!isNaN(prev) && !isNaN(curr) && prev < 6.5 && curr < 6.5) {
      green.push({
        id: "g4_near_remission",
        title: `HbA1c ${curr}% — in near-remission range for 2+ visits`,
        detail: "HbA1c < 6.5% sustained over consecutive visits.",
        action: "Discuss supervised dose reduction trial with the patient",
      });
      g4Fired = true;
    }
  }

  // G1: Strong HbA1c improvement
  let g1Fired = false;
  if (hba1cH.length >= 2) {
    const [prev, curr] = hba1cH.slice(-2).map((v) => parseFloat(v.result));
    if (!isNaN(prev) && !isNaN(curr) && prev - curr >= 1.5) {
      green.push({
        id: "g1_hba1c_improved",
        title: `HbA1c improved ${(prev - curr).toFixed(1)}% since last visit (${prev}→${curr}%)`,
        detail: "Excellent response to current regimen.",
        action: "Tell the patient — positive reinforcement improves adherence",
      });
      g1Fired = true;
    }
  }

  // G2: HbA1c at target
  if (hba1c != null && hba1c <= 7.0 && !g1Fired && !g4Fired) {
    green.push({
      id: "g2_hba1c_target",
      title: `HbA1c ${hba1c}% — at target (≤ 7.0%)`,
      detail: "Glycaemic control well maintained.",
      action: "Acknowledge with the patient — they've earned it",
    });
  }

  // G3: High compliance (≥ 90%)
  if (prep.medPct != null && prep.medPct >= 80) {
    green.push({
      id: "g3_compliance_high",
      title: `Medication compliance ${prep.medPct}% — ${prep.medPct >= 90 ? "excellent" : "good"}`,
      detail: "Patient is adhering well to prescribed regimen.",
      action: "Acknowledge with the patient",
    });
  }

  // G5: BP well controlled
  if (isHTN && latestV?.bp_sys != null && latestV.bp_sys < 130) {
    green.push({
      id: "g5_bp_controlled",
      title: `BP ${latestV.bp_sys}/${latestV.bp_dia ?? "?"} — well controlled`,
      detail: "Blood pressure at target despite hypertension diagnosis.",
      action: "Acknowledge with the patient",
    });
  }

  // G: LDL at target
  if (ldl != null && ldl <= 100) {
    green.push({
      id: "g_ldl_target",
      title: `LDL ${ldl} mg/dL — at target`,
      detail: "Lipid management is effective.",
    });
  }

  return { red, amber, green };
}
