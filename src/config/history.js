// Empty history entry template for the history form
export const emptyHistory = {
  visit_date: "",
  visit_type: "OPD",
  doctor_name: "",
  specialty: "",
  vitals: { bp_sys: "", bp_dia: "", weight: "", height: "" },
  diagnoses: [{ id: "", label: "", status: "New" }],
  medications: [{ name: "", dose: "", frequency: "", timing: "" }],
  labs: [{ test_name: "", result: "", unit: "", flag: "", ref_range: "" }],
};
