export const DISPENSABLE = ["continued", "changed", "new"];

const keyOf = (name, pharmacyMatch) =>
  String(pharmacyMatch || name || "")
    .trim()
    .toUpperCase();

const draftFields = (item) => ({
  name: item.medicine_name,
  pharmacy_match: item.pharmacy_match,
  composition: item.composition,
  dose: item.dose,
  previous_dose: item.previous_dose,
  frequency: item.frequency,
  timing: item.timing,
  timing_category: item.timing_category,
  time_of_day: item.time_of_day,
  route: item.route,
  form: item.form,
  clinical_note: item.reason,
  instructions: item.patient_instruction,
  drug_class: item.drug_class,
});

const withoutEmpty = (fields) =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== ""));

export function applyDraftMedicines(activeMeds = [], items = []) {
  const decided = items.filter((i) => i.approval_status !== "pending");
  const meds = new Map(activeMeds.map((m) => [keyOf(m.name, m.pharmacy_match), { ...m }]));

  for (const item of decided) {
    const key = keyOf(item.medicine_name, item.pharmacy_match);
    if (!key) continue;
    if (item.change_type === "stopped") {
      meds.delete(key);
      continue;
    }
    if (item.change_type === "paused") {
      if (meds.has(key)) meds.set(key, { ...meds.get(key), change_type: "paused" });
      continue;
    }
    if (!DISPENSABLE.includes(item.change_type)) continue;
    const existing = meds.get(key);
    meds.set(key, {
      ...(existing || { id: null, is_active: true }),
      ...withoutEmpty(draftFields(item)),
      change_type: item.change_type,
      is_new: item.change_type === "new",
    });
  }

  return [...meds.values()];
}
