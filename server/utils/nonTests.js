// Rows a lab report carries that are not results.
//
// Every HealthRay lab report prints the patient's age in its header, and the
// parser reads it as a test like any other: 5,124 `AGE` rows across the chart,
// one per report since Oct 2024. On the consult screen they surface as two
// "AGE" lines — "55 yrs" and "54.0" — sitting between C-Peptide and Blood
// Glucose, each with its own Graph button offering to trend the patient
// getting older.
//
// Height and Weight are deliberately NOT here. They are real measurements, the
// "Body / vitals" tab exists to show them, and the patient's own chart is the
// right place for them.
const NON_TESTS = new Set(["age", "patient age", "sex", "gender", "name", "patient name"]);

export const isNonTest = (name) =>
  NON_TESTS.has(
    String(name ?? "")
      .trim()
      .toLowerCase(),
  );

// The same rule as SQL, for the queries that read the chart. Takes the column
// expression to test, so a caller can pass `COALESCE(canonical_name, test_name)`.
export const nonTestPredicate = (expr) =>
  `lower(btrim(${expr})) NOT IN (${[...NON_TESTS].map((n) => `'${n}'`).join(", ")})`;
