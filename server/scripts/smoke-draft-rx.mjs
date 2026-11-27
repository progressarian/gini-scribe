import { applyDraftMedicines } from "../services/giniflow/draftRxMeds.js";

let failed = 0;
const check = (label, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
};

const chart = [
  { id: 1, name: "Glycomet 500", pharmacy_match: "GLYCOMET 500", dose: "1-0-1", is_active: true },
  { id: 2, name: "Amlong 5", pharmacy_match: null, dose: "1-0-0", is_active: true },
  { id: 3, name: "Rosuvas 10", pharmacy_match: "ROSUVAS 10", dose: "0-0-1", is_active: true },
  { id: 4, name: "Thyronorm 50", pharmacy_match: null, dose: "1-0-0", is_active: true },
];

const items = [
  { medicine_name: "Glycomet 500", pharmacy_match: "glycomet 500", change_type: "stopped" },
  {
    medicine_name: "Amlong 5",
    change_type: "changed",
    dose: "1-0-1",
    previous_dose: "1-0-0",
    patient_instruction: "",
  },
  { medicine_name: "Rosuvas 10", pharmacy_match: "ROSUVAS 10", change_type: "paused" },
  { medicine_name: "Jardiance 10", change_type: "new", dose: "1-0-0", reason: "HbA1c high" },
  { medicine_name: "Pending Pill", change_type: "new", approval_status: "pending" },
];

const out = applyDraftMedicines(chart, items);
const byName = (n) => out.find((m) => m.name === n);

check("stopped medicine is removed (case-insensitive match)", !byName("Glycomet 500"), out);
check(
  "changed medicine takes the draft dose and keeps its chart id",
  byName("Amlong 5")?.dose === "1-0-1" && byName("Amlong 5")?.id === 2,
  byName("Amlong 5"),
);
check(
  "empty draft fields do not blank chart values",
  byName("Amlong 5")?.instructions === undefined,
  byName("Amlong 5"),
);
check(
  "paused medicine stays, marked paused",
  byName("Rosuvas 10")?.change_type === "paused",
  byName("Rosuvas 10"),
);
check(
  "new medicine is added as new with its reason",
  byName("Jardiance 10")?.is_new === true && byName("Jardiance 10")?.clinical_note === "HbA1c high",
  byName("Jardiance 10"),
);
check("untouched chart medicine is kept", byName("Thyronorm 50")?.dose === "1-0-0", out);
check("pending (unapproved) proposal is left out", !byName("Pending Pill"), out);
check("no draft items -> chart unchanged", applyDraftMedicines(chart, []).length === 4, null);

console.log(failed ? `\n${failed} FAILED` : "\nAll passed");
process.exit(failed ? 1 : 0);
