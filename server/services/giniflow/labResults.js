import pool from "../../config/db.js";
import { getCanonical } from "../../utils/labCanonical.js";
import { flagForRange } from "../../utils/labFlag.js";
import { advanceSample, markCaseResultsReady } from "./labStation.js";
import { opensLabGate } from "../../../shared/labPayment.js";
import { syncBiomarkersFromLatestLabs } from "../healthray/db.js";

// Results the lab types in, rather than scans.
// docs/gini-flow/32-LAB-TYPED-RESULTS-PLAN.md
//
// The technician has the numbers on the analyser in front of them. Making them
// produce a PDF so the system will accept it hands the doctor a picture of a
// value instead of the value — one that cannot be trended, flagged or compared.
//
// So the values go where every lab number in this system already goes:
// lab_results, with source='manual' and a canonical name, exactly as a
// consultation's typed labs do (routes/consultations.js). Nothing downstream
// needs a new screen — the Labs tab, the trends, the MO/SD chips and the
// patient's app read that table already.

const SOURCE = "manual";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const trimmed = (v, max = 200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const orderContext = async (orderId, db) => {
  const { rows } = await db.query(
    `SELECT o.id, o.sample_status, o.report_file_url, o.payment_status,
            v.id AS visit_id, v.visit_date::text AS visit_date,
            v.patient_id, v.appointment_id,
            COALESCE(json_agg(t.test_name ORDER BY t.test_name)
                     FILTER (WHERE t.test_name IS NOT NULL), '[]'::json) AS tests
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       LEFT JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.id = $1
      GROUP BY o.id, v.id`,
    [orderId],
  );
  if (!rows.length) throw bad("Order not found", 404);
  return rows[0];
};

// The same, for a case the hospital raised on HealthRay — which is every lab at
// this hospital. `giniflow_lab_orders` has six rows in its whole history, so the
// typed-results feature shipped reachable only through a path nobody uses.
//
// The patient is the delicate part. `lab_cases.patient_id` is stamped only by the
// DETAIL sync, which does not run until results come back, so almost every case
// the lab is working on has none. The UHID in the payload is the fallback the
// board and the lab station already group by — but HealthRay REASSIGNS a UHID to
// a different person over time, and this write puts numbers on a clinical record.
// So the resolved patient is NAMED back to the caller, and a case that resolves to
// nobody is refused rather than guessed at.
const caseContext = async (caseNo, db) => {
  const { rows } = await db.query(
    `SELECT lc.case_no,
            lc.case_date::text AS visit_date,
            lc.test_names,
            lc.raw_list_json->'patient'->>'healthray_uid' AS uhid,
            COALESCE(lc.patient_id, uid.id) AS patient_id,
            COALESCE(p.name, uid.name) AS patient_name,
            v.id            AS visit_id,
            v.appointment_id
       FROM lab_cases lc
       LEFT JOIN patients uid ON uid.file_no = lc.raw_list_json->'patient'->>'healthray_uid'
       LEFT JOIN patients p ON p.id = lc.patient_id
       LEFT JOIN LATERAL (
         -- One row, deterministically. A patient with two appointments in a day
         -- can hold two visit rows (one per appointment), and an unordered join
         -- would take an arbitrary one — putting the results against whichever
         -- appointment the planner happened to return.
         SELECT gv.id, gv.appointment_id
           FROM giniflow_visits gv
          WHERE gv.visit_date = lc.case_date
            AND gv.patient_id = COALESCE(lc.patient_id, uid.id)
          ORDER BY gv.appointment_time NULLS LAST, gv.created_at
          LIMIT 1
       ) v ON TRUE
      WHERE lc.case_no = $1`,
    [caseNo],
  );
  if (!rows.length) throw bad("Lab case not found", 404);
  const r = rows[0];
  if (!r.patient_id) {
    throw bad(
      "This case is not linked to a patient yet — values cannot be recorded against it",
      409,
    );
  }
  return {
    kind: "case",
    caseNo: r.case_no,
    patient_id: r.patient_id,
    patientName: r.patient_name,
    visit_date: r.visit_date,
    appointment_id: r.appointment_id ?? null,
    uhid: r.uhid,
    tests: r.test_names || [],
  };
};

// What this lab has actually reported before under the panels this order asks
// for — each parameter's name, and the unit and range it most often carries.
// The hospital's own history rather than a catalogue somebody would have to
// build and then keep up to date.
//
// Capped per test, because a CBC with an LFT and a KFT has 192 parameters on
// file between them and that is a form nobody fills in. Each ordered test brings
// the handful this lab reports most often for it; everything else stays one
// autocomplete away, and every prefilled row can be deleted.
const PREFILL_PER_TEST = 12;

// One parameter, however it was typed. Case, punctuation and spacing are the
// only differences between the variants in `lab_results.canonical_name`.
const flattenName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

export async function suggestedRows(orderId, db = pool) {
  const order = await orderContext(orderId, db);
  return suggestionsForTests(order.tests || [], db);
}

// A hospital case carries its panels in `lab_cases.test_names`, an order carries
// them in a join table; past that point the question — what does this lab report
// under these panels — is identical, so it is asked once.
export async function suggestedCaseRows(caseNo, db = pool) {
  const c = await caseContext(caseNo, db);
  return suggestionsForTests(c.tests || [], db);
}

async function suggestionsForTests(tests, db = pool) {
  if (!tests.length) return [];

  const { rows } = await db.query(
    `SELECT ordered.name AS ordered_test, p.test_name, p.canonical_name,
            p.unit, p.ref_range, p.panel_name, p.seen
       FROM unnest($1::text[]) AS ordered(name)
       JOIN LATERAL (
         SELECT DISTINCT ON (lr.canonical_name)
                lr.test_name, lr.canonical_name, lr.unit, lr.ref_range, lr.panel_name,
                count(*) OVER (PARTITION BY lr.canonical_name) AS seen
           FROM lab_results lr
          WHERE lr.canonical_name IS NOT NULL
            AND lr.test_date > NOW() - INTERVAL '2 years'
            AND (lr.panel_name ILIKE '%' || ordered.name || '%'
                 OR lr.test_name ILIKE ordered.name)
          ORDER BY lr.canonical_name, lr.created_at DESC
       ) p ON TRUE
      ORDER BY ordered.name, p.seen DESC, p.test_name`,
    [tests],
  );

  const byTest = new Map(tests.map((t) => [t, []]));
  const claimed = new Set();
  for (const r of rows) {
    const group = byTest.get(r.ordered_test);
    if (!group || group.length >= PREFILL_PER_TEST) continue;
    // A parameter belongs to the first ordered test that claims it — creatinine
    // asked for by both a KFT and an LFT is one row on the form, not two.
    //
    // Matched on a flattened name, because `canonical_name` is not canonical:
    // the column holds "DHEA Sulphate" (143 rows), "DHEA sulphate" (2) and
    // "DHEA SULPHATE" (1) as three different values, and "Potassium, Serum"
    // under both "potassium,_serum" (806) and "Potassium Serum" (6). Comparing
    // them literally put the same parameter on the form three times over,
    // burning the per-test prefill budget on spellings of one test. Ordering is
    // already `seen DESC`, so the variant that survives is the one the lab
    // actually uses.
    // The label too, not just the canonical name. "Potassium, Serum" is stored
    // under both `potassium,_serum` (806 rows) and `Potassium` (4138) — two
    // genuinely different canonical names whose most recent rows carry the same
    // test_name, so the form printed one analyte twice with identical unit and
    // range. Two rows a technician cannot tell apart are a duplicate whatever
    // the column underneath them says.
    const parameter = flattenName(r.canonical_name);
    const label = flattenName(r.test_name);
    if (claimed.has(parameter) || claimed.has(label)) continue;
    claimed.add(parameter);
    claimed.add(label);
    group.push({
      testName: r.test_name,
      canonicalName: r.canonical_name,
      unit: r.unit,
      refRange: r.ref_range,
      panelName: r.panel_name,
      seen: Number(r.seen),
    });
  }
  // A test nobody has ever reported has no history to prefill from, and the
  // LATERAL join is an inner one — so it used to vanish from the form entirely
  // and the technician had to know to re-add it by hand. That is exactly the
  // rare endocrine work this hospital sends out (ALDOSTERONE PRA, METANEPHRINES
  // FREE PLASMA, CREATININE EGFR), so the ordered test carries its own blank
  // row: no unit, no range, nothing claimed about it beyond the name it was
  // ordered under. Skipped when another test on the same case already covers
  // that name, so the fallback cannot itself become a duplicate.
  return [...byTest.entries()].map(([test, params]) => {
    if (params.length) return { test, params };
    const label = flattenName(test);
    if (claimed.has(label)) return { test, params };
    claimed.add(label);
    return {
      test,
      params: [
        {
          testName: test,
          canonicalName: null,
          unit: null,
          refRange: null,
          panelName: test,
          seen: 0,
        },
      ],
    };
  });
}

// Autocomplete for a row the technician adds by hand, over the same history —
// so a name typed here canonicalises the way the feed's does.
export async function searchTestNames(q, db = pool) {
  const term = String(q || "").trim();
  if (term.length < 2) return [];
  const { rows } = await db.query(
    `SELECT DISTINCT ON (canonical_name) test_name, canonical_name, unit, ref_range
       FROM lab_results
      WHERE canonical_name IS NOT NULL AND test_name ILIKE '%' || $1 || '%'
      ORDER BY canonical_name, created_at DESC
      LIMIT 15`,
    [term],
  );
  return rows.map((r) => ({
    testName: r.test_name,
    canonicalName: r.canonical_name,
    unit: r.unit,
    refRange: r.ref_range,
  }));
}

export async function getResults(orderId, db = pool) {
  return resultsLinkedTo("lab_order_id", orderId, db);
}

export async function getCaseResults(caseNo, db = pool) {
  return resultsLinkedTo("lab_case_no", caseNo, db);
}

// The link column is chosen here, never interpolated from a caller: the two
// literals are the only values this ever takes.
async function resultsLinkedTo(column, value, db = pool) {
  const where = column === "lab_case_no" ? "lab_case_no = $1" : "lab_order_id = $1";
  const { rows } = await db.query(
    `SELECT id, test_name, canonical_name, result, result_text, unit, ref_range, flag,
            panel_name, test_date::text AS test_date
       FROM lab_results
      WHERE ${where}
      ORDER BY test_name`,
    [value],
  );
  return rows.map((r) => ({
    id: r.id,
    testName: r.test_name,
    canonicalName: r.canonical_name,
    value: r.result,
    valueText: r.result_text,
    unit: r.unit,
    refRange: r.ref_range,
    flag: r.flag,
    panelName: r.panel_name,
    testDate: r.test_date,
  }));
}

// One transaction: the values onto the patient's record, the order finished the
// same way an upload finishes it, and the biomarkers the MO and doctor screens
// read brought up to date.
const normalise = (rows, panelName) =>
  rows
    .map((r) => {
      const raw = r.value;
      const numeric = typeof raw === "number" ? raw : null;
      const worded = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      return {
        testName: trimmed(r.testName, 120),
        value: numeric,
        valueText: trimmed(r.valueText, 120) || (worded ? worded.slice(0, 120) : null),
        unit: trimmed(r.unit, 40),
        refRange: trimmed(r.refRange, 60),
        panelName: trimmed(r.panelName, 120) || trimmed(panelName, 120),
      };
    })
    .filter((r) => r.testName && (Number.isFinite(r.value) || r.valueText));

// The write itself, identical for an order and for a hospital case — only the
// column that links a row back to what produced it differs. `column` is one of
// two literals chosen here and never taken from a caller.
async function writeEntries(db, ctx, entries, column) {
  const link = column === "lab_case_no" ? ctx.caseNo : ctx.id;
  let written = 0;
  const skipped = [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      const canonical = getCanonical(e.testName) || e.testName.toLowerCase().replace(/\s+/g, "_");
      const flag = e.value === null ? null : flagForRange(e.value, e.refRange);

      // uq_lab_results_per_date is a partial unique index over
      // (patient_id, canonical_name, test_date) that covers 'manual', so a
      // correction — or a test HealthRay had already sent — has to update the
      // row that is there rather than collide with it.
      const updated = await client.query(
        `UPDATE lab_results
            SET test_name = $4, result = $5, result_text = $6, unit = $7,
                ref_range = $8, flag = $9, panel_name = COALESCE($10, panel_name),
                ${column} = $11, source = $12
          WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date
            AND (source = $12 OR ${column} = $11)`,
        [
          ctx.patient_id,
          canonical,
          ctx.visit_date,
          e.testName,
          e.value,
          e.valueText,
          e.unit,
          e.refRange,
          flag,
          e.panelName,
          link,
          SOURCE,
        ],
      );
      if (updated.rowCount) {
        written += 1;
        continue;
      }

      // Another source already reported this test today — a HealthRay feed, an
      // OPD entry, a report extract. Writing a second row would put two values
      // for one test on one day in front of the doctor with nothing to say which
      // is right, so the desk is told instead.
      //
      // Checked explicitly rather than leaning on uq_lab_results_per_date:
      // schema.sql declares that index but THIS database does not have it, so a
      // conflict clause alone would silently write the duplicate.
      const owned = await client.query(
        `SELECT 1 FROM lab_results
          WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date
          LIMIT 1`,
        [ctx.patient_id, canonical, ctx.visit_date],
      );
      if (owned.rowCount) {
        skipped.push(e.testName);
        continue;
      }

      const inserted = await client.query(
        `INSERT INTO lab_results
           (patient_id, appointment_id, ${column}, test_date, test_name, canonical_name,
            result, result_text, unit, ref_range, flag, panel_name, source)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING`,
        [
          ctx.patient_id,
          ctx.appointment_id,
          link,
          ctx.visit_date,
          e.testName,
          canonical,
          e.value,
          e.valueText,
          e.unit,
          e.refRange,
          flag,
          e.panelName,
          SOURCE,
        ],
      );
      // Saying "3 results saved" when one of them was dropped is the worst of
      // the three possible answers.
      if (inserted.rowCount) written += 1;
      else skipped.push(e.testName);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { written, skipped };
}

// The MO and doctor cards read appointments.biomarkers, not lab_results, so
// without this the numbers would be in the chart and absent from the screens the
// floor is actually looking at. Best-effort: a biomarker sync that fails must not
// lose the results.
const syncBiomarkers = async (patientId, appointmentId) => {
  if (!appointmentId) return;
  try {
    await syncBiomarkersFromLatestLabs(patientId, appointmentId);
  } catch (e) {
    console.error("Lab results biomarker sync failed:", e.message);
  }
};

export async function saveResults(
  orderId,
  { rows = [], actorId = null, panelName = null },
  db = pool,
) {
  const entries = normalise(rows, panelName);
  if (!entries.length) throw bad("Nothing to save — every row needs a test and a value");

  const order = await orderContext(orderId, db);

  // The same gate uploadReport enforces, checked BEFORE anything is written: the
  // upload path refuses an uncleared order, and advanceSample would refuse this
  // one too — but only after the values had already landed on the patient's
  // permanent record, leaving rows behind and an error on the screen.
  if (!opensLabGate(order.payment_status)) {
    throw bad(
      order.payment_status === "insurance_claim"
        ? "The insurance claim is not approved yet — results cannot be recorded against this order"
        : "Payment is not cleared for this order",
      409,
    );
  }

  const { written, skipped } = await writeEntries(
    db,
    { ...order, id: orderId },
    entries,
    "lab_order_id",
  );

  // Typed values finish the order exactly as a file does — same call, so the MO
  // is notified by one code path whether the result arrived as numbers or as a
  // scan, and a document can still be attached afterwards.
  if (order.sample_status !== "uploaded") {
    await advanceSample(orderId, { to: "uploaded", actorId }, db);
  }
  await syncBiomarkers(order.patient_id, order.appointment_id);

  return {
    orderId,
    saved: written,
    // Named, not counted: the desk has to know WHICH value did not take, because
    // the one already on file came from somewhere else and may disagree.
    skipped,
    results: await getResults(orderId, db),
  };
}

// The same, for a case the hospital raised on HealthRay.
//
// No payment gate: a HealthRay case is billed in HealthRay and this system has no
// say in it — the lab station has never gated one, and inventing a gate here
// would block the values for a bill we cannot read.
//
// Nothing is written back to HealthRay, so the case is finished the only way this
// system can finish one: the floor's own `results_ready` step, which is what moves
// it out of the lab queue, plus the visit-level results flag the upload path sets.
export async function saveCaseResults(
  caseNo,
  { rows = [], actorId = null, actorRole = "lab", panelName = null },
  db = pool,
) {
  const entries = normalise(rows, panelName);
  if (!entries.length) throw bad("Nothing to save — every row needs a test and a value");

  const c = await caseContext(caseNo, db);
  const { written, skipped } = await writeEntries(db, c, entries, "lab_case_no");

  // Both only when something actually landed. A save whose every row was already
  // owned by another source has written nothing, and the results-ready check
  // deliberately excludes THIS case — so calling it here would clear the visit on
  // the strength of a case that still has nothing against it.
  let ready = { rowCount: 0 };
  if (written) {
    await db.query(
      `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id)
       VALUES ($1, 'results_ready', $2, $3)
       ON CONFLICT (case_no, action) DO NOTHING`,
      [caseNo, actorRole, actorId],
    );
    ready = await markCaseResultsReady(db, {
      patientId: c.patient_id,
      caseDate: c.visit_date,
      caseNo,
      uhid: c.uhid,
    });
  }
  if (written) await syncBiomarkers(c.patient_id, c.appointment_id);

  return {
    caseNo,
    // Whose record this went on. The patient may have been resolved through a
    // reassignable UHID, so the desk is told the name rather than trusting it.
    patientName: c.patientName,
    saved: written,
    skipped,
    markedResultsReady: ready.rowCount > 0,
    results: await getCaseResults(caseNo, db),
  };
}
