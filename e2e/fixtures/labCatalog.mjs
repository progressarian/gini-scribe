export const LAB_FIELDS = {
  totalCholesterol: { id: 990101, name: "Total Cholesterol", unit: "mg/dl" },
  triglycerides: { id: 990102, name: "Triglycerides", unit: "mg/dl" },
  hdl: { id: 990103, name: "HDL Cholesterol", unit: "mg/dl" },
  ldl: { id: 990104, name: "LDL Cholesterol", unit: "mg/dl" },
  vldl: { id: 990105, name: "VLDL Cholesterol", unit: "mg/dl", formula: "#990102 / 5" },
  nonHdl: { id: 990106, name: "Non HDL Cholesterol", unit: "mg/dl", formula: "#990101 - #990103" },
  totalHdlRatio: {
    id: 990107,
    name: "Total / HDL Cholesterol Ratio",
    noUnit: true,
    formula: "#990101 / #990103",
  },
  ldlHdlRatio: {
    id: 990108,
    name: "LDL / HDL Cholesterol Ratio",
    noUnit: true,
    formula: "#990104 / #990103",
  },
  hba1c: { id: 990201, name: "HbA1c", unit: "%" },
  bun: { id: 990301, name: "Blood Urea Nitrogen", unit: "mg/dl" },
  urea: { id: 990302, name: "Blood Urea", unit: "mg/dl", formula: "#990301 * 2.14" },
  creatinine: { id: 990303, name: "Creatinine, Serum", unit: "mg/dl" },
  ureaCreatinine: {
    id: 990304,
    name: "Urea / Creatinine Ratio",
    noUnit: true,
    formula: "#990302 / #990303",
  },
  bunCreatinine: {
    id: 990305,
    name: "BUN / Creatinine Ratio",
    noUnit: true,
    formula: "#990301 / #990303",
  },
};

const F = LAB_FIELDS;

export const LAB_REPORTS = [
  {
    id: 990001,
    name: "LIPID PROFILE",
    catalogTest: "Lipid Profile",
    fields: [
      F.totalCholesterol,
      F.triglycerides,
      F.hdl,
      F.ldl,
      F.vldl,
      F.nonHdl,
      F.totalHdlRatio,
      F.ldlHdlRatio,
    ],
  },
  { id: 990002, name: "HBA1C", catalogTest: "HbA1c", fields: [F.hba1c] },
  {
    id: 990003,
    name: "RFT",
    aliases: ["Renal Function Test", "KFT"],
    catalogTest: "RFT",
    fields: [F.bun, F.urea, F.creatinine, F.ureaCreatinine, F.bunCreatinine],
  },
];

export const LAB_RANGES = [
  { fieldId: F.hba1c.id, gender: "Female", min: 4.5, max: 6.5 },
  { fieldId: F.hba1c.id, gender: "Male", min: 4, max: 6 },
  { fieldId: F.totalCholesterol.id, gender: "Both", min: 0, max: 200 },
  { fieldId: F.triglycerides.id, gender: "Both", min: 0, max: 150 },
  { fieldId: F.hdl.id, gender: "Both", min: 40, max: 60 },
  { fieldId: F.creatinine.id, gender: "Male", min: 0.7, max: 1.3 },
  { fieldId: F.creatinine.id, gender: "Female", min: 0.6, max: 1.1 },
];

const FIELD_IDS = Object.values(LAB_FIELDS).map((f) => f.id);
const REPORT_IDS = LAB_REPORTS.map((r) => r.id);

export async function removeLabCatalog(query) {
  await query(
    `UPDATE giniflow_test_catalog SET lab_report_id = NULL WHERE lab_report_id = ANY($1)`,
    [REPORT_IDS],
  );
  await query(
    `DELETE FROM giniflow_test_catalog WHERE test_name = 'RFT' AND source = 'e2e_fixture'`,
  );
  await query(`DELETE FROM lab_report_catalog WHERE id = ANY($1)`, [REPORT_IDS]);
  await query(`DELETE FROM lab_test_catalog WHERE id = ANY($1)`, [FIELD_IDS]);
}

export async function seedLabCatalog(query) {
  await removeLabCatalog(query);
  await query(
    `INSERT INTO giniflow_test_catalog (test_name, category, price, source)
     VALUES ('RFT', 'lab', 700, 'e2e_fixture')
     ON CONFLICT (test_name) DO NOTHING`,
  );
  await query(
    `INSERT INTO lab_test_catalog (id, name, unit, no_unit, input_type, formula, source)
     SELECT f.id, f.name, f.unit, f.no_unit, 'numeric', f.formula, 'manual'
       FROM jsonb_to_recordset($1::jsonb)
         AS f(id BIGINT, name TEXT, unit TEXT, no_unit BOOLEAN, formula TEXT)`,
    [
      JSON.stringify(
        Object.values(LAB_FIELDS).map((f) => ({
          id: f.id,
          name: f.name,
          unit: f.unit ?? null,
          no_unit: !!f.noUnit,
          formula: f.formula ?? null,
        })),
      ),
    ],
  );
  for (const report of LAB_REPORTS) {
    await query(
      `INSERT INTO lab_report_catalog (id, name, aliases, source) VALUES ($1, $2, $3, 'manual')`,
      [report.id, report.name, report.aliases ?? []],
    );
    await query(
      `INSERT INTO lab_report_tests (report_id, test_id, sequence, is_required)
       SELECT $1, f.id, f.ord, f.formula IS NULL
         FROM unnest($2::bigint[], $3::text[]) WITH ORDINALITY AS f(id, formula, ord)`,
      [report.id, report.fields.map((f) => f.id), report.fields.map((f) => f.formula ?? null)],
    );
    await query(`UPDATE giniflow_test_catalog SET lab_report_id = $1 WHERE test_name = $2`, [
      report.id,
      report.catalogTest,
    ]);
  }
  await query(
    `INSERT INTO lab_test_ranges (test_id, gender, min_value, max_value, source)
     SELECT r.field_id, r.gender, r.min, r.max, 'manual'
       FROM jsonb_to_recordset($1::jsonb) AS r(field_id BIGINT, gender TEXT, min NUMERIC, max NUMERIC)`,
    [
      JSON.stringify(
        LAB_RANGES.map((r) => ({ field_id: r.fieldId, gender: r.gender, min: r.min, max: r.max })),
      ),
    ],
  );
}
