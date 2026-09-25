export const CLAIM_BILLS_AT_ONCE = 500;
export const NO_CATEGORY = "No sub-category";
export const NO_DOCTOR = "No doctor";

const sortByLabel = (a, b) => a.label.localeCompare(b.label);

export function claimSubtotals(rows) {
  const groups = new Map();
  for (const row of rows) {
    const label = row.category_label || NO_CATEGORY;
    const group = groups.get(label) ?? { label, count: 0, amount: 0, doctors: new Map() };
    const doctorLabel = row.doctor_name || NO_DOCTOR;
    const doctor = group.doctors.get(doctorLabel) ?? {
      label: doctorLabel,
      count: 0,
      amount: 0,
      rows: [],
    };
    doctor.count += 1;
    doctor.amount += row.claim;
    doctor.rows.push(row);
    group.count += 1;
    group.amount += row.claim;
    group.doctors.set(doctorLabel, doctor);
    groups.set(label, group);
  }
  return [...groups.values()].sort(sortByLabel).map((group) => ({
    label: group.label,
    count: group.count,
    amount: group.amount,
    doctors: [...group.doctors.values()].sort(sortByLabel),
  }));
}
