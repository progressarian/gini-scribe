// Results the lab types in rather than scans.
//
// What these checks are really about: a typed value has to be a real lab result
// — the same table, the same canonical name, the same flag rule as one that
// arrives from HealthRay — because the moment it is anything less, the doctor's
// trend has a hole in it that nobody can see.
//
//   npm run smoke:giniflow-lab-results   (from server/)
import "../loadEnv.js";
import pool from "../config/db.js";
import {
  suggestedRows,
  searchTestNames,
  getResults,
  saveResults,
} from "../services/giniflow/labResults.js";
import { parseRefRange, flagForRange } from "../utils/labFlag.js";
import { getCanonical } from "../utils/labCanonical.js";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok " : "FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

const TEST_DAY = "2019-01-04";
// ⚠️ Writes to the production database — these rows go on a patient's record, so
// they are removed whatever happens.
const made = { orders: [], patients: [] };
const cleanUp = async () => {
  try {
    if (made.orders.length) {
      await pool.query(`DELETE FROM lab_results WHERE lab_order_id = ANY($1::uuid[])`, [
        made.orders,
      ]);
    }
    // Visits before patients: a patient a visit still references cannot go.
    await pool.query(
      `DELETE FROM giniflow_visits WHERE patient_id IN
         (SELECT id FROM patients WHERE file_no LIKE 'ZZLR_%')`,
    );
    await pool.query(
      `DELETE FROM lab_results WHERE patient_id IN
         (SELECT id FROM patients WHERE file_no LIKE 'ZZLR_%')`,
    );
    await pool.query(`DELETE FROM patients WHERE file_no LIKE 'ZZLR_%'`);
  } catch (e) {
    console.error("cleanup failed:", e.message);
  } finally {
    await pool.end();
  }
};
for (const ev of ["uncaughtException", "unhandledRejection"]) {
  process.on(ev, async (e) => {
    console.error(e);
    await cleanUp();
    process.exit(1);
  });
}

// This suite builds the one patient and order it needs, so it does not seed the
// shared demo day — nothing here reads it, and seeding it only creates a
// collision with any other suite running at the same time.
// ── The flag rule, shared with the HealthRay feed ──────────────────────────
check("a range reads as a range", parseRefRange("13.0-17.0").min === 13);
check("an open-ended one too", parseRefRange("< 50").max === 50);
check("a value under its range is LOW", flagForRange(11, "13.0-17.0") === "LOW");
check("over it is HIGH", flagForRange(19, "13.0-17.0") === "HIGH");
check("inside it is neither", flagForRange(15, "13.0-17.0") === null);
check("and a range no arithmetic can read flags nothing", flagForRange(3, "Negative") === null);

// ── An order to type results against ──────────────────────────────────────
const patient = await one(
  `INSERT INTO patients (name, file_no, age, sex, phone)
   VALUES ('Demo Lab Values', 'ZZLR_1', 51, 'Male', '9888800001')
   ON CONFLICT (file_no) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
);
made.patients.push(patient.id);
const visit = await one(
  // NOT is_demo: this suite removes its own rows, and every other suite's
  // cleanDemoDay deletes is_demo visits — which would take this one out from
  // under the run whenever two suites overlap.
  `INSERT INTO giniflow_visits (patient_id, visit_date, current_status)
   VALUES ($1, $2::date, 'with_sd')
   ON CONFLICT (patient_id, visit_date) DO UPDATE SET current_status = 'with_sd'
   RETURNING id`,
  [patient.id, TEST_DAY],
);
const order = await one(
  `INSERT INTO giniflow_lab_orders
     (visit_id, urgency, payment_status, amount_total, amount_paid, sample_status)
   VALUES ($1, 'today', 'paid', 500, 500, 'results_ready') RETURNING id`,
  [visit.id],
);
made.orders.push(order.id);
await pool.query(
  `INSERT INTO giniflow_lab_order_tests (lab_order_id, test_name, price) VALUES ($1, 'CBC', 200)`,
  [order.id],
);

// ── The gate, before anything is written ──────────────────────────────────
// A result recorded against an order nobody cleared is a test the hospital did
// for free and a row on a patient's record that should not be there.
await pool.query(
  `UPDATE giniflow_lab_orders SET payment_status = 'pending', amount_paid = 0 WHERE id = $1`,
  [order.id],
);
const refused = await saveResults(order.id, {
  rows: [{ testName: "Hemoglobin", value: 12, unit: "gm/dL", refRange: "13.0-17.0" }],
})
  .then(() => false)
  .catch((e) => e.status === 409);
check("an uncleared order cannot take results", refused);
const nothingWritten = await one(
  `SELECT count(*)::int c FROM lab_results WHERE lab_order_id = $1`,
  [order.id],
);
check("and nothing was written before the refusal", nothingWritten.c === 0);
await pool.query(
  `UPDATE giniflow_lab_orders SET payment_status = 'paid', amount_paid = amount_total WHERE id = $1`,
  [order.id],
);

// ── The form the technician is given ──────────────────────────────────────
const groups = await suggestedRows(order.id);
check("the ordered test brings its own rows", groups.length === 1 && groups[0].test === "CBC");
const params = groups[0].params;
check("prefilled from this lab's own history", params.length > 0, `${params.length} rows`);
check(
  "each row carries the unit and range this lab reports",
  params.some((p) => p.unit && p.refRange),
  params[0] && `${params[0].testName} · ${params[0].unit} · ${params[0].refRange}`,
);
check("and not so many that nobody fills it in", params.length <= 12, `${params.length}`);

const found = await searchTestNames("hemog");
check(
  "a hand-typed name autocompletes from the same history",
  found.length > 0,
  found[0]?.testName,
);
check("carrying its unit with it", !!found[0]?.unit);
check("and two letters is not a search", (await searchTestNames("h")).length === 0);

// ── Saving ────────────────────────────────────────────────────────────────
const saved = await saveResults(order.id, {
  actorId: 18,
  panelName: "CBC",
  rows: [
    { testName: "Hemoglobin", value: 11.2, unit: "gm/dL", refRange: "13.0-17.0" },
    { testName: "WBC", value: 7.1, unit: "10^3/mm^3", refRange: "4.0-10.0" },
    { testName: "Blood Group", valueText: "B positive" },
    { testName: "", value: 9 },
  ],
});
check("every real row is written", saved.saved === 3, `${saved.saved}`);
check(
  "and a row with no test name is not",
  saved.results.every((r) => r.testName),
);

const hb = saved.results.find((r) => r.testName === "Hemoglobin");
check("the value is stored as a number", Number(hb.value) === 11.2);
check("flagged against its own range", hb.flag === "LOW", hb.flag);
check(
  "with the canonical name the feed would have used",
  hb.canonicalName === getCanonical("Hemoglobin"),
);
const text = saved.results.find((r) => r.testName === "Blood Group");
check("a worded result is a result too", text.valueText === "B positive");
check("and is not flagged", text.flag === null);

// The doctor's own query, not ours: this is the point of the whole feature.
const seenByDoctor = await pool.query(
  `SELECT test_name, result, unit, ref_range, flag, source
     FROM lab_results
    WHERE patient_id = $1 AND test_date = $2::date
    ORDER BY test_name`,
  [patient.id, TEST_DAY],
);
check(
  "the doctor's Labs query returns them",
  seenByDoctor.rows.length === 3,
  `${seenByDoctor.rows.length}`,
);
check(
  "as ordinary lab results, marked manual",
  seenByDoctor.rows.every((r) => r.source === "manual"),
);

// ── A word is a result too ────────────────────────────────────────────────
// One box on the form takes both, so "Positive" must not become 0 — a number
// that reads as real and would be flagged LOW on a patient's record.
const worded = await saveResults(order.id, {
  actorId: 18,
  rows: [{ testName: "Dengue NS1", value: "Positive" }],
});
const dengue = worded.results.find((r) => r.testName === "Dengue NS1");
check("a word typed in the value box is kept as a word", dengue.valueText === "Positive");
check("and leaves no number behind", dengue.value === null, String(dengue.value));
check("so nothing flags it", dengue.flag === null);

// A test the feed already sent today owns that row. Reporting it as saved would
// tell the technician their value took when the doctor will see another.
const feedName = "ZZ Feed Owned";
await pool.query(
  `INSERT INTO lab_results (patient_id, test_date, test_name, canonical_name, result, source)
   VALUES ($1, $2::date, $3, $4, 9.9, 'lab_healthray')`,
  [patient.id, TEST_DAY, feedName, "zz_feed_owned"],
);
const clash = await saveResults(order.id, {
  actorId: 18,
  rows: [
    { testName: feedName, value: 1.1 },
    { testName: "Platelets", value: 250, unit: "10^3/mm^3", refRange: "150-410" },
  ],
});
check("a value the feed already owns is not silently counted", clash.saved === 1, `${clash.saved}`);
check(
  "and is named so the desk knows which",
  clash.skipped.includes(feedName),
  clash.skipped.join(),
);
const feedRow = await one(
  `SELECT result, source FROM lab_results WHERE patient_id = $1 AND canonical_name = $2`,
  [patient.id, "zz_feed_owned"],
);
check("the feed's own value is left alone", Number(feedRow.result) === 9.9);
check("and stays the feed's", feedRow.source === "lab_healthray");

// ── Correcting a typo ─────────────────────────────────────────────────────
const corrected = await saveResults(order.id, {
  actorId: 18,
  panelName: "CBC",
  rows: [{ testName: "Hemoglobin", value: 14.5, unit: "gm/dL", refRange: "13.0-17.0" }],
});
const fixed = corrected.results.find((r) => r.testName === "Hemoglobin");
check("a corrected value replaces the old one", Number(fixed.value) === 14.5);
check("and its flag is recomputed", fixed.flag === null, fixed.flag);
const rowCount = await one(
  `SELECT count(*)::int c FROM lab_results
    WHERE patient_id = $1 AND canonical_name = $2 AND test_date = $3::date`,
  [patient.id, getCanonical("Hemoglobin"), TEST_DAY],
);
check("without leaving a second row behind", rowCount.c === 1, `${rowCount.c}`);

// ── Finishing the order ───────────────────────────────────────────────────
const after = await one(
  `SELECT sample_status, report_file_url FROM giniflow_lab_orders WHERE id = $1`,
  [order.id],
);
check("typed values finish the order", after.sample_status === "uploaded", after.sample_status);
check("with no file pretended", after.report_file_url === null);
const notified = await one(`SELECT results_status FROM giniflow_visits WHERE id = $1`, [visit.id]);
check(
  "and the MO is told the results are in",
  notified.results_status !== "none",
  notified.results_status,
);

const before = (await getResults(order.id)).length;
const again = await saveResults(order.id, {
  actorId: 18,
  rows: [{ testName: "ESR", value: 22, unit: "mm/hr", refRange: "0-20" }],
});
check("a value added afterwards still saves", again.results.length === before + 1);
check(
  "and is flagged like the rest",
  again.results.find((r) => r.testName === "ESR")?.flag === "HIGH",
);

await cleanUp();
console.log(failures ? `\n${failures} checks failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
