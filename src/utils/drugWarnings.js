// Smart Drug Warnings Engine
// Deterministic rule-based system (no AI) — all thresholds approved by Dr. Anil Bhansali
// Do not change threshold values without explicit approval

// ─── Helpers ───────────────────────────────────────────────────────────────

function num(labResults, name) {
  if (!labResults) return null;
  const lab = labResults.find((l) => {
    const key = l.canonical_name || l.test_name || "";
    return key.toLowerCase().includes(name.toLowerCase());
  });
  return lab && lab.result != null ? parseFloat(lab.result) : null;
}

function hasMed(meds, ...names) {
  if (!meds) return false;
  return meds.some((m) =>
    names.some((n) => (m.name || "").toLowerCase().includes(n.toLowerCase())),
  );
}

function hasDx(diagnoses, ...keywords) {
  if (!diagnoses) return false;
  return diagnoses.some((d) =>
    keywords.some(
      (kw) =>
        (d.label || "").toLowerCase().includes(kw.toLowerCase()) ||
        (d.diagnosis_id || "").toLowerCase().includes(kw.toLowerCase()),
    ),
  );
}

// ─── Drug Detection ────────────────────────────────────────────────────────

function isMetformin(name) {
  return /metformin/i.test(name);
}

function isSulphonylurea(name) {
  return /glimepiride|glipizide|gliclazide/i.test(name);
}

function isInsulin(name) {
  return /insulin|glargine|aspart|detemir|degludec|ryzodeg/i.test(name);
}

function isSGLT2i(name) {
  return /empagliflozin|dapagliflozin|canagliflozin/i.test(name);
}

function isACE(name) {
  return /ramipril|enalapril|lisinopril|perindopril|captopril/i.test(name);
}

function isARB(name) {
  return /telmisartan|losartan|valsartan|olmesartan|irbesartan|candesartan/i.test(name);
}

function isLevo(name) {
  return /levothyroxine|thyroxine|eltroxin/i.test(name);
}

function isStatin(name) {
  return /atorvastatin|rosuvastatin|simvastatin|pravastatin|fluvastatin/i.test(name);
}

function isFenofibrate(name) {
  return /fenofibrate/i.test(name);
}

function isAspirin(name) {
  return /aspirin.*75/i.test(name);
}

function isBetaBlocker(name) {
  return /metoprolol|bisoprolol|atenolol|carvedilol|nebivolol/i.test(name);
}

function isPioglitazone(name) {
  return /pioglitazone/i.test(name);
}

// ─── Main Warning Engine ───────────────────────────────────────────────────

export function getWarning(drugName, context = {}) {
  if (!drugName || drugName.trim().length < 2) return null;

  const { labResults = [], diagnoses = [], activeMeds = [], patient = {} } = context;
  const name = drugName.trim();
  const eGFR = num(labResults, "eGFR");
  const potassium = num(labResults, "Potassium") || num(labResults, "K+");
  const creatinine = num(labResults, "Creatinine");
  const age = patient.age ? parseInt(patient.age) : null;

  // ─── Cross-Drug Checks (run first, these override single-drug warnings) ───

  // 1. ACE + ARB both active
  if ((isACE(name) || isARB(name)) && hasMed(activeMeds, "ramipril", "enalapril", "lisinopril")) {
    if (hasMed(activeMeds, "telmisartan", "losartan", "valsartan", "olmesartan")) {
      const arbName = activeMeds.find((m) =>
        /telmisartan|losartan|valsartan|olmesartan/i.test(m.name),
      )?.name;
      return {
        level: "RED",
        message: `${arbName || "ARB"} is already prescribed. Do not combine ACE inhibitor and ARB — risk of hyperkalaemia and acute kidney injury. Remove one or the other.`,
      };
    }
  }

  // 2. Two sulphonylureas
  if (isSulphonylurea(name) && hasMed(activeMeds, "glimepiride", "glipizide", "gliclazide")) {
    return {
      level: "RED",
      message: "Another sulphonylurea is already prescribed. Only one should be active at a time.",
    };
  }

  // 3. Metformin + eGFR < 30
  if (isMetformin(name) && eGFR != null && eGFR < 30 && hasMed(activeMeds, "metformin")) {
    return {
      level: "RED",
      message: `eGFR is ${eGFR} ml/min. Metformin is already prescribed and is now contraindicated at this level. Flag for review and discontinuation.`,
    };
  }

  // 4. SGLT2i + eGFR < 30
  if (
    isSGLT2i(name) &&
    eGFR != null &&
    eGFR < 30 &&
    hasMed(activeMeds, "empagliflozin", "dapagliflozin", "canagliflozin")
  ) {
    return {
      level: "AMBER",
      message: `eGFR is ${eGFR} ml/min. SGLT2 inhibitor is already prescribed — not effective and not recommended below eGFR 30.`,
    };
  }

  // 5. Two statins
  if (
    isStatin(name) &&
    hasMed(activeMeds, "atorvastatin", "rosuvastatin", "simvastatin", "pravastatin")
  ) {
    return {
      level: "AMBER",
      message:
        "A statin is already prescribed. Two statins are rarely needed — confirm this is intentional.",
    };
  }

  // 6. Glimepiride + age > 70
  if (
    isSulphonylurea(name) &&
    /glimepiride/i.test(name) &&
    age != null &&
    age > 70 &&
    hasMed(activeMeds, "glimepiride")
  ) {
    return {
      level: "RED",
      message: `Patient is ${age} years old. Glimepiride is already prescribed — hypoglycaemia risk is significantly higher in elderly. Review and consider switching to DPP-4 inhibitor.`,
    };
  }

  // 7. Fenofibrate + Statin
  if (
    isFenofibrate(name) &&
    hasMed(activeMeds, "atorvastatin", "rosuvastatin", "simvastatin", "pravastatin")
  ) {
    const statinName = activeMeds.find((m) =>
      /atorvastatin|rosuvastatin|simvastatin|pravastatin/i.test(m.name),
    )?.name;
    return {
      level: "AMBER",
      message: `${statinName || "A statin"} is already prescribed. Combining fenofibrate with a statin increases myopathy risk. If patient reports muscle pain, check CK immediately.`,
    };
  }

  // ─── Single-Drug Warnings (Tier 1 → 2 → 3 → 4) ───

  // METFORMIN
  if (isMetformin(name)) {
    if (eGFR != null) {
      if (eGFR < 30) {
        return {
          level: "RED",
          message: `eGFR is ${eGFR} ml/min — Metformin is CONTRAINDICATED below 30. Stop and do not re-prescribe until eGFR recovers above 30.`,
        };
      } else if (eGFR < 45) {
        return {
          level: "AMBER",
          message: `eGFR is ${eGFR} ml/min — reduce Metformin to maximum 500mg twice daily. Review again if eGFR falls below 30.`,
        };
      } else {
        return null; // eGFR >= 45, safe, suppress warning
      }
    } else if (hasDx(diagnoses, "Diabetic Nephropathy", "CKD", "chronic kidney disease")) {
      return {
        level: "AMBER",
        message:
          "Patient has diabetic nephropathy — eGFR not on file. Check eGFR before prescribing Metformin. Contraindicated if < 30, reduce dose if 30–44.",
      };
    } else {
      return {
        level: "AMBER",
        message:
          "Check eGFR before prescribing. Reduce dose to 500mg BD if eGFR 30–44. Stop completely if eGFR < 30. Risk of lactic acidosis in renal impairment.",
      };
    }
  }

  // SULPHONYLUREAS (Glimepiride, Glipizide, Gliclazide)
  if (isSulphonylurea(name)) {
    if (age != null) {
      if (age > 70) {
        return {
          level: "RED",
          message: `Patient is ${age} years old — sulphonylurea hypoglycaemia risk is significantly higher in elderly patients. Use minimum effective dose (0.5–1mg). Counsel carefully. Consider switching to DPP-4 inhibitor (Sitagliptin or Vildagliptin) which has no hypoglycaemia risk.`,
        };
      } else {
        return {
          level: "AMBER",
          message:
            "Sulphonylurea — hypoglycaemia risk if patient skips meals. Counsel patient on recognising and managing low blood sugar. Avoid in patients who eat irregularly.",
        };
      }
    } else {
      return {
        level: "AMBER",
        message:
          "Sulphonylurea — hypoglycaemia risk. Counsel patient on symptoms. Use with caution in elderly — check age before prescribing.",
      };
    }
  }

  // INSULIN (any type)
  if (isInsulin(name)) {
    return {
      level: "RED",
      message:
        "Insulin carries hypoglycaemia risk. Before prescribing: (1) Counsel patient and family on recognising and managing low blood sugar. (2) Ensure fast-acting sugar or glucagon kit available at home. (3) Document that counselling has been given in the visit notes.",
    };
  }

  // SGLT2 INHIBITORS
  if (isSGLT2i(name)) {
    if (eGFR != null) {
      if (eGFR < 30) {
        return {
          level: "AMBER",
          message: `eGFR is ${eGFR} ml/min — SGLT2 inhibitors are not effective and not recommended below eGFR 30. Consider alternative. Also counsel on genital hygiene — increased UTI and fungal infection risk with this drug class.`,
        };
      } else if (eGFR < 45) {
        return {
          level: "AMBER",
          message: `eGFR is ${eGFR} ml/min — reduced efficacy in this range. Use only if cardiovascular or renal benefit outweighs limited glucose effect. Counsel on genital hygiene.`,
        };
      } else {
        return {
          level: "BLUE",
          message:
            "Counsel patient on genital hygiene — SGLT2 inhibitors increase risk of urinary tract and fungal infections.",
        };
      }
    } else if (hasDx(diagnoses, "Diabetic Nephropathy", "CKD", "chronic kidney disease")) {
      return {
        level: "AMBER",
        message:
          "Patient has diabetic nephropathy — eGFR not on file. SGLT2 inhibitors are ineffective and not recommended if eGFR < 30. Check eGFR before prescribing.",
      };
    } else {
      return {
        level: "BLUE",
        message:
          "Check eGFR before initiating — not effective if eGFR < 30. Counsel patient on genital hygiene: increased urinary tract and fungal infection risk.",
      };
    }
  }

  // ACE INHIBITORS (Ramipril, Enalapril, etc.)
  if (isACE(name)) {
    // Cross-drug check: ARB already active
    if (hasMed(activeMeds, "telmisartan", "losartan", "valsartan", "olmesartan")) {
      const arbName = activeMeds.find((m) =>
        /telmisartan|losartan|valsartan|olmesartan/i.test(m.name),
      )?.name;
      return {
        level: "RED",
        message: `${arbName || "ARB"} is already prescribed. Do not combine ACE inhibitor and ARB — risk of hyperkalaemia and acute kidney injury. Remove one or the other.`,
      };
    }

    if (eGFR != null && eGFR < 30) {
      return {
        level: "AMBER",
        message: `eGFR is ${eGFR} ml/min. Use with caution — ACE inhibitors can further reduce GFR acutely after initiation. Monitor creatinine and potassium closely 1–2 weeks after starting.`,
      };
    } else if (eGFR != null) {
      return {
        level: "AMBER",
        message:
          "ACE inhibitor — check potassium and creatinine 2 weeks after starting. Monitor for dry cough — if persistent, switch to ARB.",
      };
    } else {
      return {
        level: "AMBER",
        message:
          "ACE inhibitor — check eGFR, potassium, and creatinine before starting and again 2 weeks after. Do not combine with ARB. Monitor for dry cough.",
      };
    }
  }

  // ARBs (Telmisartan, Losartan, etc.)
  if (isARB(name)) {
    // Cross-drug check: ACE already active
    if (hasMed(activeMeds, "ramipril", "enalapril", "lisinopril", "perindopril", "captopril")) {
      const aceName = activeMeds.find((m) =>
        /ramipril|enalapril|lisinopril|perindopril|captopril/i.test(m.name),
      )?.name;
      return {
        level: "RED",
        message: `${aceName || "ACE inhibitor"} is already prescribed. Do not combine ACE inhibitor and ARB — risk of hyperkalaemia and acute kidney injury. Remove one.`,
      };
    }

    return {
      level: "AMBER",
      message: "ARB — check potassium and creatinine 2 weeks after starting.",
    };
  }

  // LEVOTHYROXINE (always show)
  if (isLevo(name)) {
    return {
      level: "BLUE",
      message:
        "Must be taken on empty stomach, 30 minutes before any food or drink. Food, calcium tablets, and iron supplements block absorption significantly. Do not share a timing slot with any other medication.",
    };
  }

  // STATINS (Rosuvastatin, Atorvastatin, etc.)
  if (isStatin(name)) {
    // Cross-drug check already handled above

    return {
      level: "BLUE",
      message:
        "Take at night — the liver produces cholesterol overnight, making evening dosing significantly more effective than morning.",
    };
  }

  // FENOFIBRATE
  if (isFenofibrate(name)) {
    // Cross-drug check already handled above

    return {
      level: "BLUE",
      message:
        "If combined with a statin later, monitor for muscle pain and check CK if symptoms appear.",
    };
  }

  // ASPIRIN 75mg
  if (isAspirin(name)) {
    if (
      hasDx(
        diagnoses,
        "CAD",
        "MI",
        "CVA",
        "cardiovascular",
        "stroke",
        "coronary",
        "myocardial infarction",
      )
    ) {
      return {
        level: "BLUE",
        message: "Aspirin is appropriate for this patient given documented cardiovascular history.",
      };
    } else {
      return {
        level: "AMBER",
        message:
          "Aspirin 75mg should only be prescribed if there is documented high cardiovascular risk or a prior cardiovascular event (MI, stroke). Not for routine use in diabetes without a CV indication.",
      };
    }
  }

  // BETA BLOCKERS (Metoprolol, Bisoprolol, etc.)
  if (isBetaBlocker(name)) {
    if (
      hasDx(
        diagnoses,
        "Heart Failure",
        "AF",
        "Atrial Fibrillation",
        "post-MI",
        "myocardial infarction",
      )
    ) {
      return {
        level: "BLUE",
        message:
          "Beta blocker is appropriate given cardiac indication. Note: beta blockers can mask hypoglycaemia symptoms in diabetic patients — counsel patient on non-adrenergic signs (sweating, confusion).",
      };
    } else {
      return {
        level: "AMBER",
        message:
          "Beta blockers are not first-line for blood pressure in T2DM. They can mask hypoglycaemia symptoms. Only prescribe if there is a specific cardiac indication (heart failure, AF, post-MI).",
      };
    }
  }

  // PIOGLITAZONE
  if (isPioglitazone(name)) {
    if (hasDx(diagnoses, "Heart Failure", "Bladder Cancer", "Osteoporosis")) {
      const foundDx = diagnoses.find((d) =>
        /heart failure|bladder cancer|osteoporosis/i.test(d.label || d.diagnosis_id),
      );
      return {
        level: "RED",
        message: `Pioglitazone is contraindicated in this patient — ${foundDx?.label || foundDx?.diagnosis_id} is present. Do not prescribe.`,
      };
    } else {
      return {
        level: "AMBER",
        message:
          "Avoid if patient has or develops heart failure, bladder cancer, or osteoporosis. Can cause fluid retention and weight gain.",
      };
    }
  }

  // Unknown drug
  return null;
}
