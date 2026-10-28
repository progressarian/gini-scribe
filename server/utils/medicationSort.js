import {
  MED_CATEGORIES,
  DIABETES_CLASS_RANK,
  detectDrugClass,
  detectMedCategory,
  getCategoryLabel,
  groupMedicationsByCategory,
} from "../config/medicationCategories.js";

const GROUP_RANK = MED_CATEGORIES.reduce((acc, c) => {
  acc[c.id] = c.rank;
  return acc;
}, {});
GROUP_RANK.cardiovascular = GROUP_RANK.bp;
GROUP_RANK.supplements = GROUP_RANK.supplement;
export { detectDrugClass };
export const detectMedGroup = detectMedCategory;
export { getCategoryLabel as getGroupLabel };

export function groupMedications(medications) {
  const groups = groupMedicationsByCategory(medications || []);
  for (const id of Object.keys(groups)) {
    groups[id] = sortMedicationsByClass(groups[id], id);
  }
  return groups;
}

// Sort medications within a single group.
function sortMedicationsByClass(meds, group) {
  if (group === "diabetes") {
    return meds
      .map((m) => ({ ...m, _drugClass: m.drug_class || detectDrugClass(m) }))
      .sort((a, b) => {
        const rankA = DIABETES_CLASS_RANK[a._drugClass] || 1.7;
        const rankB = DIABETES_CLASS_RANK[b._drugClass] || 1.7;
        if (rankA !== rankB) return rankA - rankB;
        if (a.sort_order !== b.sort_order) {
          return (a.sort_order || 0) - (b.sort_order || 0);
        }
        return (a.name || "").localeCompare(b.name || "");
      });
  }
  return [...meds].sort((a, b) => {
    if (a.sort_order !== b.sort_order) {
      return (a.sort_order || 0) - (b.sort_order || 0);
    }
    return (a.name || "").localeCompare(b.name || "");
  });
}

// Sort all medications according to clinical category order, then drug class.
export function sortMedications(medications) {
  if (!medications || medications.length === 0) return medications;
  const groups = groupMedications(medications);
  const result = [];
  for (const cat of MED_CATEGORIES) {
    result.push(...(groups[cat.id] || []));
  }
  return result;
}

// Format medication for display (legacy helper, kept as-is).
export function formatMedication(med, index) {
  const parts = [];
  parts.push(`${index + 1}.`);
  parts.push(med.name);
  if (med.dose) parts.push(med.dose);
  parts.push("|");
  parts.push(med.frequency || "OD");
  if (med.timing) {
    parts.push("|");
    parts.push(med.timing);
  }
  return parts.join(" ");
}

export default {
  sortMedications,
  groupMedications,
  detectDrugClass,
  detectMedGroup,
  getGroupLabel: getCategoryLabel,
  formatMedication,
  GROUP_RANK,
  DIABETES_CLASS_RANK,
};
