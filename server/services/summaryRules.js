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

// Freshness window for "current value" rules. Labs/vitals older than this
// are considered stale and won't trigger RED/AMBER alerts (to avoid alarming
// the doctor with data that may have changed). Set to 120 days (one follow-up
// cycle, ~4 months). GREEN rules have no freshness check — positive signals
// are never stale.
const FRESH_DAYS = 120;
function isFresh(dateStr) {
  return dateStr != null && daysSince(dateStr) <= FRESH_DAYS;
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

function hasMed(meds, ...names) {
  return (meds || []).some((m) =>
    names.some((n) => (m.name || "").toLowerCase().includes(n.toLowerCase())),
  );
}

// Classify a medication by drug class so stopped-med alerts can carry
// class-specific clinical implications instead of a generic "treatment gap" note.
// Matches on brand AND generic names commonly seen in Indian outpatient scripts.
const MED_CLASSES = [
  {
    className: "thyroid",
    label: "thyroid hormone",
    weight: "high",
    keywords: [
      "thyronorm",
      "eltroxin",
      "thyrox",
      "levothyrox",
      "levothyroxine",
      "liothyronine",
      "thyroxine",
    ],
    implication: "Thyroid cover lost — expect TSH to drift within 2–4 weeks.",
    action: "Confirm replacement script or reason for stop",
  },
  {
    className: "antihypertensive",
    label: "antihypertensive",
    weight: "high",
    keywords: [
      "cilacar",
      "telma",
      "telmisartan",
      "amlodipine",
      "amlopres",
      "amlong",
      "losartan",
      "losar",
      "olmesartan",
      "olmezest",
      "olmy",
      "ramipril",
      "cardace",
      "enalapril",
      "perindopril",
      "coversyl",
      "lisinopril",
      "valsartan",
      "candesartan",
      "irbesartan",
      "metoprolol",
      "metolar",
      "bisoprolol",
      "concor",
      "atenolol",
      "carvedilol",
      "nebivolol",
      "nebicard",
      "prazosin",
      "hydrochlorothiazide",
      "hctz",
      "chlorthalidone",
      "indapamide",
      "nitrendipine",
      "nifedipine",
      "cilnidipine",
    ],
    implication:
      "Antihypertensive cover lost — BP likely to rise; check today's reading vs. prior.",
    action: "Restart or substitute today if BP trending up",
  },
  {
    className: "antidiabetic",
    label: "antidiabetic",
    weight: "high",
    keywords: [
      "metformin",
      "glycomet",
      "gluconorm",
      "obimet",
      "glimepiride",
      "amaryl",
      "gliclazide",
      "diamicron",
      "glipizide",
      "sitagliptin",
      "januvia",
      "vildagliptin",
      "galvus",
      "linagliptin",
      "trajenta",
      "teneligliptin",
      "tenepride",
      "dapagliflozin",
      "forxiga",
      "empagliflozin",
      "jardiance",
      "canagliflozin",
      "pioglitazone",
      "pioglit",
      "insulin",
      "lantus",
      "novomix",
      "humalog",
      "trulicity",
      "ozempic",
      "liraglutide",
    ],
    implication: "Glycaemic cover lost — expect FBS/HbA1c drift without substitute.",
    action: "Confirm replacement or reintroduce today",
  },
  {
    className: "statin",
    label: "statin",
    weight: "high",
    keywords: [
      "atorvastatin",
      "atorva",
      "atorlip",
      "lipitor",
      "rosuvastatin",
      "rosuvas",
      "crestor",
      "simvastatin",
      "simvotin",
      "pravastatin",
      "fluvastatin",
    ],
    implication: "Lipid cover lost — LDL will climb back toward untreated baseline.",
    action: "Restart or swap if intolerance",
  },
  {
    className: "antiplatelet",
    label: "antiplatelet",
    weight: "high",
    keywords: [
      "aspirin",
      "ecosprin",
      "disprin",
      "clopidogrel",
      "clopilet",
      "plavix",
      "prasugrel",
      "ticagrelor",
      "brilinta",
    ],
    implication: "Cardiovascular platelet protection paused — re-check indication.",
    action: "Confirm whether hold is intentional",
  },
  {
    className: "anticoagulant",
    label: "anticoagulant",
    weight: "high",
    keywords: [
      "warfarin",
      "acitrom",
      "apixaban",
      "eliquis",
      "rivaroxaban",
      "xarelto",
      "dabigatran",
      "pradaxa",
      "enoxaparin",
      "clexane",
      "heparin",
    ],
    implication: "Anticoagulation paused — thrombotic risk depending on indication.",
    action: "Confirm plan urgently",
  },
  {
    className: "supplement",
    label: "supplement",
    weight: "low",
    keywords: [
      "aktiv d",
      "calcirol",
      "cholecalciferol",
      "vitamin d",
      "uprise",
      "d3 must",
      "b12",
      "methylcobalamin",
      "nurokind",
      "neurobion",
      "iron",
      "orofer",
      "ferrous",
      "livogen",
      "dexorange",
      "calcium",
      "shelcal",
      "cipcal",
      "gemcal",
      "folic",
      "folvite",
      "multivitamin",
      "zincovit",
      "becosules",
    ],
    implication: "Nutritional supplement paused — low urgency unless symptomatic.",
    action: "Reconfirm at visit",
  },
  {
    className: "symptomatic",
    label: "symptomatic",
    weight: "low",
    keywords: [
      "paracetamol",
      "crocin",
      "dolo",
      "ibuprofen",
      "brufen",
      "diclofenac",
      "pantoprazole",
      "pan 40",
      "pan-d",
      "omeprazole",
      "rabeprazole",
      "razo",
      "cough",
      "cheston",
      "ascoril",
      "antacid",
      "digene",
      "gelusil",
    ],
    implication: "Short-course symptomatic drug — stop usually expected.",
    action: "No action unless symptoms persist",
  },
];

function classifyMed(name) {
  const n = (name || "").toLowerCase();
  for (const c of MED_CLASSES) {
    if (c.keywords.some((k) => n.includes(k))) {
      return {
        className: c.className,
        label: c.label,
        weight: c.weight,
        implication: c.implication,
        action: c.action,
      };
    }
  }
  return {
    className: "other",
    label: "",
    weight: "medium",
    implication: "Treatment gap — clinical cover may be incomplete.",
    action: "Discuss replacement or resumption",
  };
}

export function runSummaryRules({
  diagnoses = [],
  activeMeds = [],
  stoppedMeds = [],
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

  const onMetformin = hasMed(activeMeds, "metformin");
  const hasACEorARB = hasMed(
    activeMeds,
    "ramipril",
    "enalapril",
    "lisinopril",
    "perindopril",
    "captopril",
    "telmisartan",
    "losartan",
    "valsartan",
    "olmesartan",
    "irbesartan",
    "candesartan",
  );

  const hba1c = numVal(labResults, "HbA1c");
  const hba1cInfo = getLabVal(labResults, "HbA1c");
  const uacr = numVal(labResults, "UACR");
  const egfr = numVal(labResults, "eGFR");
  const ldl = numVal(labResults, "LDL");
  const ldlInfo = getLabVal(labResults, "LDL");
  const tshInfo = getLabVal(labResults, "TSH");
  const tsh = tshInfo ? parseFloat(tshInfo.result) : null;
  const latestVDate = latestV?.recorded_at || latestV?.created_at || null;

  const hba1cH = getLabHist(labHistory, "HbA1c");
  const uacrH = getLabHist(labHistory, "UACR");

  // ─── RED ─────────────────────────────────────────────────────────────────────

  // R1: Missing ACE/ARB with UACR > 30 in T2DM
  if (isT2DM && uacr != null && uacr > 30 && !hasACEorARB) {
    red.push({
      id: "r1_ace_missing",
      title: `UACR ${uacr} mg/g — no ACE inhibitor or ARB prescribed`,
      detail: "Protocol: ACE/ARB required for UACR > 30 mg/g in T2DM.",
      action: "Consider Ramipril 2.5mg OD or Telmisartan 20mg OD",
    });
  }

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

  // R3: HbA1c critically high (> 10%) — only if measurement is fresh
  if (hba1c != null && hba1c > 10 && isFresh(hba1cInfo?.date)) {
    red.push({
      id: "r3_hba1c_critical",
      title: `HbA1c ${hba1c}% — critically elevated`,
      detail: "Target ≤ 7.0% for most T2DM patients.",
      action: "Insulin initiation or intensification to consider",
    });
  }

  // R4: Recently stopped medication (within 60 days) — exclude non-clinical stops
  // Skip: data cleanup, medication switches/changes, HealthRay auto-stops, external doctor continuations
  const SKIP_PATTERNS = [
    "duplicate",
    "data cleanup",
    "developer",
    "wrong",
    "error",
    "never started",
    "not prescribed",
    "switched to",
    "changed to",
    "replaced by",
    "continue from",
    "continued with",
    "previous dose",
    "old dose",
    "prior dose",
  ];
  for (const m of stoppedMeds) {
    const d = daysSince(m.stopped_date);
    if (d > 60) continue;
    const reason = (m.stop_reason || "").toLowerCase();
    const notes = (m.notes || "").toLowerCase();
    const isNonClinical = SKIP_PATTERNS.some((p) => reason.includes(p) || notes.includes(p));
    // Also skip if stop_reason is just a bare HealthRay ID + "stopped" (automated sync stop)
    if (isNonClinical || /^healthray:\d+\s*[-—]?\s*stopped?$/i.test(m.stop_reason || "")) continue;

    const cls = classifyMed(m.name);
    const alert = {
      id: `r4_stopped_${m.id || m.name}`,
      title: `${m.name}${cls.label ? ` (${cls.label})` : ""} stopped ${d} day${d !== 1 ? "s" : ""} ago${m.stop_reason ? ` — ${m.stop_reason}` : ""}`,
      detail: cls.implication,
      action: cls.action,
      medClass: cls.className,
      medWeight: cls.weight,
      gapDays: d,
    };
    // Route supplements and symptomatic drugs to amber; critical classes to red
    if (cls.weight === "low") {
      amber.push(alert);
    } else {
      red.push(alert);
    }
  }

  // ── Biomarker range alerts (beyond HbA1c) ──

  // FBS elevated
  const fbs = numVal(labResults, "FBS");
  if (fbs != null && fbs > 200 && isFresh(getLabVal(labResults, "FBS")?.date)) {
    red.push({
      id: "bio_fbs_critical",
      title: `Fasting glucose ${fbs} mg/dL — critically elevated`,
      detail: "Target < 130 mg/dL fasting.",
      action: "Review insulin/OHA regimen",
    });
  } else if (fbs != null && fbs > 130 && isFresh(getLabVal(labResults, "FBS")?.date)) {
    amber.push({
      id: "bio_fbs_elevated",
      title: `Fasting glucose ${fbs} mg/dL — above target`,
      detail: "Target < 130 mg/dL.",
      action: "Review dose titration",
    });
  }

  // LDL elevated
  if (ldl != null && isFresh(ldlInfo?.date)) {
    if (ldl > 160) {
      red.push({
        id: "bio_ldl_critical",
        title: `LDL ${ldl} mg/dL — significantly elevated`,
        detail: "Target ≤ 100 mg/dL for diabetic patients.",
        action: "Statin initiation or dose increase",
      });
    } else if (ldl > 100) {
      amber.push({
        id: "bio_ldl_elevated",
        title: `LDL ${ldl} mg/dL — above target`,
        detail: "Target ≤ 100 mg/dL.",
        action: "Review lipid management",
      });
    }
  }

  // eGFR low (kidney function declining)
  if (egfr != null && isFresh(getLabVal(labResults, "eGFR")?.date)) {
    if (egfr < 30) {
      red.push({
        id: "bio_egfr_critical",
        title: `eGFR ${egfr} — Stage 4 CKD`,
        detail: "Severe kidney impairment. Multiple drug adjustments needed.",
        action: "Nephrology referral; review all renally cleared medications",
      });
    } else if (egfr < 60) {
      amber.push({
        id: "bio_egfr_low",
        title: `eGFR ${egfr} — reduced kidney function (Stage 3)`,
        detail: "Target > 60 mL/min. Monitor closely.",
        action: "Check medication doses; consider nephroprotective agents",
      });
    }
  }

  // Creatinine elevated
  const creatinine = numVal(labResults, "Creatinine");
  if (
    creatinine != null &&
    creatinine > 1.5 &&
    isFresh(getLabVal(labResults, "Creatinine")?.date)
  ) {
    amber.push({
      id: "bio_creatinine",
      title: `Creatinine ${creatinine} mg/dL — elevated`,
      detail: "Check eGFR and renal function trend.",
      action: "Order urine ACR if not done",
    });
  }

  // A2: Metformin + renal risk
  if (onMetformin && egfr != null && egfr < 45) {
    amber.push({
      id: "a2_metformin_egfr",
      title: `Metformin dose review — eGFR ${egfr} mL/min/1.73m²`,
      detail: "Metformin contraindicated at eGFR < 30; reduce dose at eGFR 30–45.",
      action: "Review dose safety — consider switching to safer alternative",
    });
  }

  // R5 removed — the summary should surface clinical findings (labs, vitals,
  // compliance), not document-review todos. "Unreviewed report" alerts belong
  // in a separate inbox/notification surface, not in the visit summary panel.

  // R6: Compliance critically low (< 50%)
  if (prep.medPct != null && prep.medPct < 50) {
    red.push({
      id: "r6_compliance_critical",
      title: `Medication compliance ${prep.medPct}% — critically low`,
      detail: "Patient is missing more than half their doses.",
      action: "Discuss barriers — consider simpler regimen or pill organiser",
    });
  }

  // R7: BP critically elevated and worsening — only if vitals are fresh
  if (
    latestV?.bp_sys != null &&
    latestV.bp_sys > 150 &&
    prevV?.bp_sys != null &&
    isFresh(latestVDate)
  ) {
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

  // A: BP borderline elevated — only if vitals are fresh
  if (
    isHTN &&
    latestV?.bp_sys != null &&
    latestV.bp_sys >= 130 &&
    latestV.bp_sys <= 150 &&
    isFresh(latestVDate) &&
    !red.some((r) => r.id === "r7_bp_critical")
  ) {
    amber.push({
      id: "a_bp_borderline",
      title: `BP ${latestV.bp_sys}/${latestV.bp_dia ?? "?"} — borderline elevated`,
      detail: "Target < 130/80 mmHg for hypertension patients.",
      action: "Review antihypertensive regimen",
    });
  }

  // A: TSH elevated in hypothyroid patients — only if measurement is fresh
  if (isHypo && tsh != null && tsh > 4.5 && isFresh(tshInfo?.date)) {
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

  // G2: HbA1c at target — suppress if R2 (rising trend) fired, since rising + at target is contradictory
  const r2Fired = red.some((r) => r.id === "r2_hba1c_rising");
  if (hba1c != null && hba1c <= 7.0 && !g1Fired && !g4Fired && !r2Fired) {
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

  // G: eGFR healthy
  if (egfr != null && egfr >= 90) {
    green.push({
      id: "g_egfr_healthy",
      title: `eGFR ${egfr} — normal kidney function`,
      detail: "No renal impairment.",
    });
  }

  // G: TSH in range
  if (tsh != null && tsh >= 0.5 && tsh <= 4.5) {
    green.push({
      id: "g_tsh_target",
      title: `TSH ${tsh} µIU/mL — in range`,
      detail: "Thyroid function well managed.",
    });
  }

  // G: FBS at target
  if (fbs != null && fbs <= 130) {
    green.push({
      id: "g_fbs_target",
      title: `Fasting glucose ${fbs} mg/dL — at target`,
      detail: "Glycaemic control maintained.",
    });
  }

  // G: UACR normal
  if (uacr != null && uacr < 30) {
    green.push({
      id: "g_uacr_normal",
      title: `UACR ${uacr} mg/g — normal`,
      detail: "No microalbuminuria.",
    });
  }

  return { red, amber, green };
}
