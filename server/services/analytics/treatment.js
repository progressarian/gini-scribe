import {
  normalizeDrug,
  COMPARATOR_LABELS,
  MOLECULE_LABELS,
  detectSupportMed,
} from "./drugNormalizer.js";
import { AUTOMATED_STOP_REASON } from "./constants.js";
import { describe, pct, round } from "./stats.js";
import { conditionMembers } from "./conditions.js";

const CLASS_LABELS = {
  ...COMPARATOR_LABELS,
  glp1: "GLP-1 / GIP receptor agonist",
  ccb: "Calcium channel blocker",
  beta_blocker: "Beta blocker",
  antiplatelet: "Antiplatelet",
  ppi: "Proton pump inhibitor",
  diuretic: "Diuretic",
  gabapentinoid: "Gabapentinoid",
  supplement: "Supplement",
  antibiotic: "Antibiotic",
  antifungal: "Antifungal",
  corticosteroid: "Corticosteroid",
  antiemetic: "Antiemetic",
  urate_lowering: "Urate lowering",
  alpha_blocker: "Alpha blocker",
  other: "Other",
};

const DIABETES_CLASSES = [
  "biguanide",
  "sulfonylurea",
  "dpp4i",
  "sglt2i",
  "glp1",
  "insulin",
  "tzd",
  "agi",
];

export async function getMedicationRows(db, { asOf } = {}) {
  const sql = `
    SELECT id, patient_id, name, composition, pharmacy_match, drug_class, dose, frequency,
           is_active, started_date, stopped_date, stop_reason, last_prescribed_date,
           parent_medication_id, support_condition, created_at::date AS created_on
      FROM medications
     WHERE patient_id IS NOT NULL
       AND (started_date IS NULL OR started_date <= $1::date)`;
  const { rows } = await db.query(sql, [asOf]);
  return rows.map((row) => ({ ...row, resolved: normalizeDrug(row) }));
}

export function buildTreatmentLandscape(medRows, patients) {
  const withVisit = new Set(patients.filter((p) => p.first_visit).map((p) => p.patient_id));
  const everByClass = new Map();
  const activeByClass = new Map();

  for (const row of medRows) {
    if (!withVisit.has(row.patient_id)) continue;
    for (const cls of row.resolved.classes) {
      if (!everByClass.has(cls)) everByClass.set(cls, new Set());
      everByClass.get(cls).add(row.patient_id);
      if (row.is_active) {
        if (!activeByClass.has(cls)) activeByClass.set(cls, new Set());
        activeByClass.get(cls).add(row.patient_id);
      }
    }
  }

  const rows = [...everByClass.entries()]
    .map(([cls, set]) => ({
      drug_class: CLASS_LABELS[cls] || cls,
      key: cls,
      patients_ever: set.size,
      patients_active: (activeByClass.get(cls) || new Set()).size,
      share_of_panel_pct: pct(set.size, withVisit.size),
    }))
    .sort((a, b) => b.patients_ever - a.patients_ever);

  const activeCounts = new Map();
  for (const row of medRows) {
    if (!row.is_active || !withVisit.has(row.patient_id)) continue;
    activeCounts.set(row.patient_id, (activeCounts.get(row.patient_id) || 0) + 1);
  }
  const polypharmacy = new Map();
  for (const patientId of withVisit) {
    const n = activeCounts.get(patientId) || 0;
    const bucket =
      n === 0
        ? "No active medications"
        : n <= 2
          ? "1-2"
          : n <= 4
            ? "3-4"
            : n <= 7
              ? "5-7"
              : n <= 10
                ? "8-10"
                : "11+";
    polypharmacy.set(bucket, (polypharmacy.get(bucket) || 0) + 1);
  }

  return {
    classes: rows,
    polypharmacy: [...polypharmacy.entries()]
      .map(([bucket, p]) => ({ bucket, patients: p, share_pct: pct(p, withVisit.size) }))
      .sort((a, b) => b.patients - a.patients),
    active_med_count: describe([...activeCounts.values()], 1),
    denominator: withVisit.size,
  };
}

export function buildDiabetesRegimenMix(medRows, conditionIndex, patients) {
  const withVisit = new Set(patients.filter((p) => p.first_visit).map((p) => p.patient_id));
  const diabetics = new Set(
    [...conditionMembers(conditionIndex, "diabetes")].filter((id) => withVisit.has(id)),
  );

  const classesByPatient = new Map();
  for (const row of medRows) {
    if (!row.is_active || !diabetics.has(row.patient_id)) continue;
    const set = classesByPatient.get(row.patient_id) || new Set();
    for (const cls of row.resolved.classes) {
      if (DIABETES_CLASSES.includes(cls)) set.add(cls);
    }
    classesByPatient.set(row.patient_id, set);
  }

  const perClass = DIABETES_CLASSES.map((cls) => {
    let n = 0;
    for (const set of classesByPatient.values()) if (set.has(cls)) n += 1;
    return {
      drug_class: CLASS_LABELS[cls] || cls,
      key: cls,
      patients: n,
      share_of_diabetics_pct: pct(n, diabetics.size),
    };
  }).sort((a, b) => b.patients - a.patients);

  const intensity = new Map();
  for (const patientId of diabetics) {
    const n = (classesByPatient.get(patientId) || new Set()).size;
    const bucket =
      n === 0
        ? "No glucose-lowering drug recorded"
        : n === 1
          ? "Monotherapy"
          : n === 2
            ? "Dual therapy"
            : n === 3
              ? "Triple therapy"
              : "Four or more classes";
    intensity.set(bucket, (intensity.get(bucket) || 0) + 1);
  }

  const combos = new Map();
  for (const set of classesByPatient.values()) {
    if (!set.size) continue;
    const key = [...set]
      .sort()
      .map((c) => CLASS_LABELS[c] || c)
      .join(" + ");
    combos.set(key, (combos.get(key) || 0) + 1);
  }

  return {
    denominator: diabetics.size,
    per_class: perClass,
    intensity: [...intensity.entries()].map(([bucket, p]) => ({
      bucket,
      patients: p,
      share_pct: pct(p, diabetics.size),
    })),
    top_combinations: [...combos.entries()]
      .map(([combination, patients]) => ({
        combination,
        patients,
        share_pct: pct(patients, diabetics.size),
      }))
      .sort((a, b) => b.patients - a.patients)
      .slice(0, 15),
  };
}

export function buildGuidelineGaps(medRows, byMarker, conditionIndex, patients) {
  const withVisit = new Map(patients.filter((p) => p.first_visit).map((p) => [p.patient_id, p]));
  const activeClasses = new Map();
  for (const row of medRows) {
    if (!row.is_active) continue;
    const set = activeClasses.get(row.patient_id) || new Set();
    for (const cls of row.resolved.classes) set.add(cls);
    activeClasses.set(row.patient_id, set);
  }

  const markerIndex = new Map();
  for (const [marker, list] of byMarker.entries()) {
    const m = new Map();
    for (const r of list) m.set(r.patient_id, r);
    markerIndex.set(marker, m);
  }
  const val = (marker, patientId) => {
    const m = markerIndex.get(marker);
    const r = m && m.get(patientId);
    return r ? r.last_val : null;
  };

  const diabetics = conditionMembers(conditionIndex, "diabetes");
  const cadPatients = conditionMembers(conditionIndex, "cad");

  const gaps = [
    {
      key: "statin_gap_diabetes",
      label: "Diabetic with LDL above 100 mg/dL and no statin prescribed",
      eligible: (id) => diabetics.has(id) && val("ldl", id) != null && val("ldl", id) > 100,
      missing: (cls) => !cls.has("statin"),
    },
    {
      key: "statin_gap_cad",
      label: "Coronary artery disease and no statin prescribed",
      eligible: (id) => cadPatients.has(id),
      missing: (cls) => !cls.has("statin"),
    },
    {
      key: "antiplatelet_gap_cad",
      label: "Coronary artery disease and no antiplatelet prescribed",
      eligible: (id) => cadPatients.has(id),
      missing: (cls) => !cls.has("antiplatelet"),
    },
    {
      key: "raas_gap_albuminuria",
      label: "UACR above 30 mg/g and no ACE inhibitor or ARB",
      eligible: (id) => val("uacr", id) != null && val("uacr", id) > 30,
      missing: (cls) => !cls.has("renin_angiotensin"),
    },
    {
      key: "sglt2_gap_ckd",
      label: "UACR above 30 mg/g in a diabetic and no SGLT2 inhibitor",
      eligible: (id) => diabetics.has(id) && val("uacr", id) != null && val("uacr", id) > 30,
      missing: (cls) => !cls.has("sglt2i"),
    },
    {
      key: "metformin_low_egfr",
      label: "eGFR below 30 and still on metformin",
      eligible: (id) => val("egfr", id) != null && val("egfr", id) < 30,
      missing: (cls) => cls.has("biguanide"),
    },
    {
      key: "inertia_high_a1c",
      label: "HbA1c 9% or above without insulin or a GLP-1 agonist",
      eligible: (id) => diabetics.has(id) && val("hba1c", id) != null && val("hba1c", id) >= 9,
      missing: (cls) => !cls.has("insulin") && !cls.has("glp1"),
    },
  ];

  return gaps.map((gap) => {
    let eligible = 0;
    let affected = 0;
    const patientsAffected = [];
    for (const [patientId, patient] of withVisit.entries()) {
      if (!gap.eligible(patientId)) continue;
      eligible += 1;
      const cls = activeClasses.get(patientId) || new Set();
      if (gap.missing(cls)) {
        affected += 1;
        patientsAffected.push({ patient_id: patientId, file_no: patient.file_no });
      }
    }
    return {
      key: gap.key,
      gap: gap.label,
      eligible_patients: eligible,
      patients_with_gap: affected,
      gap_rate_pct: pct(affected, eligible),
      sample: patientsAffected.slice(0, 500),
    };
  });
}

export function buildPersistence(medRows, { asOf }) {
  const byClass = new Map();
  for (const row of medRows) {
    for (const cls of row.resolved.classes) {
      const list = byClass.get(cls) || [];
      list.push(row);
      byClass.set(cls, list);
    }
  }
  const out = [];
  for (const [cls, rows] of byClass.entries()) {
    const stopped = rows.filter((r) => r.stopped_date);
    const clinicalStops = stopped.filter(
      (r) => r.stop_reason && !AUTOMATED_STOP_REASON.test(r.stop_reason),
    );
    const durations = rows
      .filter((r) => r.started_date)
      .map((r) => {
        const end = r.stopped_date || asOf;
        return Math.round(
          (new Date(`${end}T00:00:00Z`) - new Date(`${r.started_date}T00:00:00Z`)) / 86400000,
        );
      })
      .filter((d) => d >= 0 && d < 4000);
    out.push({
      drug_class: CLASS_LABELS[cls] || cls,
      key: cls,
      prescriptions: rows.length,
      still_active: rows.filter((r) => r.is_active).length,
      still_active_pct: pct(rows.filter((r) => r.is_active).length, rows.length),
      stopped: stopped.length,
      stopped_with_clinical_reason: clinicalStops.length,
      duration_days: describe(durations, 0),
    });
  }
  return out.sort((a, b) => b.prescriptions - a.prescriptions);
}

export function buildSupportMedProfile(medRows, cohortPatientIds) {
  const counts = new Map();
  for (const row of medRows) {
    if (!cohortPatientIds.has(row.patient_id)) continue;
    const kind = detectSupportMed(row);
    if (!kind) continue;
    const e = counts.get(kind) || { kind, patients: new Set(), linked_to_parent: 0 };
    e.patients.add(row.patient_id);
    if (row.parent_medication_id || row.support_condition) e.linked_to_parent += 1;
    counts.set(kind, e);
  }
  return [...counts.values()]
    .map((e) => ({
      support_type: e.kind,
      patients: e.patients.size,
      share_of_cohort_pct: pct(e.patients.size, cohortPatientIds.size),
      explicitly_linked_rows: e.linked_to_parent,
    }))
    .sort((a, b) => b.patients - a.patients);
}

export { CLASS_LABELS, DIABETES_CLASSES, MOLECULE_LABELS, round };
