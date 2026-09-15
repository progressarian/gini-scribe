import "../loadEnv.js";
import pool from "../config/db.js";
import { catalogRowsFor } from "../services/giniflow/labCatalog.js";
import { saveCaseResults } from "../services/giniflow/labResults.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const client = await pool.connect();
const TAG = `ZZLC_${Date.now()}`;
const REPORT = 990000001;
const CHOL = 990000002;
const TRIG = 990000003;
const VLDL = 990000004;
const PANEL = 990000005;
const CHILD = 990000006;

try {
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO lab_report_catalog (id, name, aliases, source) VALUES ($1, $2, $3, 'healthray')`,
    [REPORT, `${TAG} LIPIDS`, [`${TAG} lipid panel`]],
  );
  await client.query(
    `INSERT INTO lab_test_catalog (id, name, unit, input_type, formula, sequence, source) VALUES
       ($1, 'Probe Cholesterol', 'mg/dl', 'numeric', NULL, NULL, 'healthray'),
       ($2, 'Probe Triglyceride', 'mg/dl', 'numeric', NULL, NULL, 'healthray'),
       ($3, 'Probe VLDL', 'mg/dl', 'numeric', $4, NULL, 'healthray'),
       ($5, 'Probe Panel', NULL, 'group', NULL, NULL, 'healthray')`,
    [CHOL, TRIG, VLDL, `#${TRIG} / 5`, PANEL],
  );
  await client.query(
    `INSERT INTO lab_test_catalog (id, parent_test_id, sequence, name, unit, input_type, source)
     VALUES ($1, $2, 1, 'Probe Child', '%', 'numeric', 'healthray')`,
    [CHILD, PANEL],
  );
  await client.query(
    `INSERT INTO lab_report_tests (report_id, test_id, sequence) VALUES ($1,$2,1),($1,$3,2),($1,$4,3),($1,$5,4)`,
    [REPORT, CHOL, TRIG, VLDL, PANEL],
  );
  await client.query(
    `INSERT INTO lab_test_ranges (test_id, gender, min_value, max_value, source) VALUES
       ($1, 'Male', 0, 200, 'healthray'),
       ($1, 'Female', 0, 190, 'healthray'),
       ($2, 'Both', 0, 150, 'healthray'),
       ($3, 'Both', 4.7, 21.1, 'healthray')`,
    [CHOL, TRIG, VLDL],
  );
  await client.query(
    `INSERT INTO lab_test_ranges (test_id, gender, min_age_days, max_age_days, min_value, max_value, source)
     VALUES ($1, 'Both', 0, 3650, 1, 2, 'healthray')`,
    [CHILD],
  );

  console.log("── The catalogue answers for an ordered test ───────────────");
  const male = (await catalogRowsFor([`${TAG} LIPIDS`], { sex: "Male", ageYears: 50 }, client)).get(
    `${TAG} LIPIDS`,
  );
  check("every field of the report is offered", male.length === 5, `${male.length}`);
  check(
    "in HealthRay's print order",
    male.map((p) => p.testName).join(" | ") ===
      "Probe Cholesterol | Probe Triglyceride | Probe VLDL | Probe Panel | Probe Child",
    male.map((p) => p.testName).join(" | "),
  );
  check("the unit comes from the catalogue", male[0].unit === "mg/dl", male[0].unit);
  check("the man's range is used", male[0].refRange === "0 - 200", male[0].refRange);
  check("a formula row is marked calculated", male[2].calculated === true);
  check("and carries HealthRay's formula", male[2].formula === `#${TRIG} / 5`, male[2].formula);
  check("a heading is a heading, not an input", male[3].isGroup === true, male[3].inputType);
  check("its sub-field sits under it", male[4].depth === 1, `depth ${male[4].depth}`);

  console.log("\n── The same test, a different patient ──────────────────────");
  const female = (
    await catalogRowsFor([`${TAG} LIPIDS`], { sex: "Female", ageYears: 50 }, client)
  ).get(`${TAG} LIPIDS`);
  check("the woman's range is used", female[0].refRange === "0 - 190", female[0].refRange);
  check(
    "a range for children does not reach a 50-year-old",
    female[4].refRange === "" && female[4].range === null,
    female[4].refRange,
  );
  const child = (
    await catalogRowsFor([`${TAG} LIPIDS`], { sex: "Female", ageYears: 5 }, client)
  ).get(`${TAG} LIPIDS`);
  check("but it does reach a 5-year-old", child[4].refRange === "1 - 2", child[4].refRange);
  const unknownSex = (await catalogRowsFor([`${TAG} LIPIDS`], {}, client)).get(`${TAG} LIPIDS`);
  check(
    "with no gender on file, a gendered range is not guessed at",
    ["0 - 200", "0 - 190"].includes(unknownSex[0].refRange),
    unknownSex[0].refRange,
  );

  console.log("\n── Names the floor orders under ────────────────────────────");
  const alias = await catalogRowsFor([`${TAG} lipid PANEL`], { sex: "Male", ageYears: 50 }, client);
  check("an alias finds the report", (alias.get(`${TAG} lipid PANEL`) || []).length === 5);
  const spaced = await catalogRowsFor([`${TAG}   lipids`], { sex: "Male", ageYears: 50 }, client);
  check("so does a differently spaced name", (spaced.get(`${TAG}   lipids`) || []).length === 5);
  const missing = await catalogRowsFor(["ZZ nothing like this"], { sex: "Male" }, client);
  check("a test the catalogue never saw returns nothing", missing.size === 0);
  console.log("\n── Saving: the catalogue has the last word ────────────────");
  const { rows: p } = await client.query(
    `INSERT INTO patients (name, file_no, sex, age) VALUES ($1, $2, 'Male', 50) RETURNING id`,
    [`Probe Lab ${TAG}`, TAG],
  );
  const caseNo = `${TAG}_CASE`;
  await client.query(
    `INSERT INTO lab_cases (case_no, patient_case_no, case_uid, lab_case_id, case_date, patient_id,
                            test_names, raw_list_json, results_synced)
     VALUES ($1, $1, $1, 990000099, (NOW() AT TIME ZONE 'Asia/Kolkata')::date, $2, ARRAY[$3],
             '{}'::jsonb, FALSE)`,
    [caseNo, p[0].id, `${TAG} LIPIDS`],
  );
  let depth = 0;
  const nested = {
    query: (text, params) => {
      const sql = String(text).trim().toUpperCase();
      if (sql === "BEGIN") return client.query(`SAVEPOINT lr${++depth}`);
      if (sql === "COMMIT") return client.query(`RELEASE SAVEPOINT lr${depth--}`);
      if (sql === "ROLLBACK") return client.query(`ROLLBACK TO SAVEPOINT lr${depth--}`);
      return client.query(text, params);
    },
    release: () => {},
  };
  const db = { connect: async () => nested, query: (t, v) => client.query(t, v) };

  await saveCaseResults(
    caseNo,
    {
      rows: [
        { testId: String(CHOL), testName: "typed by hand", value: 220 },
        { testId: String(TRIG), testName: "Probe Triglyceride", value: 150 },
        { testId: String(VLDL), testName: "Probe VLDL", value: 999 },
      ],
    },
    db,
  );
  const { rows: saved } = await client.query(
    `SELECT test_name, result, unit, ref_range, flag FROM lab_results
      WHERE patient_id = $1 ORDER BY test_name`,
    [p[0].id],
  );
  const vldl = saved.find((r) => r.test_name === "Probe VLDL");
  const chol = saved.find((r) => r.test_name === "Probe Cholesterol");
  check(
    "a tampered formula value is replaced by the formula's answer",
    Number(vldl?.result) === 30,
    `${vldl?.result}`,
  );
  check("and carries its own range", vldl?.ref_range === "4.7 - 21.1", vldl?.ref_range);
  check("a value above the man's range is flagged H", chol?.flag === "H", `${chol?.flag}`);
  check(
    "the name comes from the catalogue, not the caller",
    !!chol,
    saved.map((r) => r.test_name).join(", "),
  );
  check("the unit comes from the catalogue", chol?.unit === "mg/dl", chol?.unit);
} catch (err) {
  check("the scenarios ran to the end", false, `threw: ${err.message}`);
} finally {
  await client.query("ROLLBACK");
  client.release();
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM lab_test_catalog WHERE id >= 990000001)
          + (SELECT count(*)::int FROM patients WHERE file_no LIKE $1) AS c`,
    [`${TAG}%`],
  );
  check("the probe rows left no trace", rows[0].c === 0, `${rows[0].c} rows`);
  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  await pool.end();
  process.exit(failures ? 1 : 0);
}
