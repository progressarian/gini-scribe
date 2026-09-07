import pool from "../../config/db.js";
import { getCanonical } from "../../utils/labCanonical.js";
import { flagForRange } from "../../utils/labFlag.js";
import { advanceSample } from "./labStation.js";
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

export async function suggestedRows(orderId, db = pool) {
  const order = await orderContext(orderId, db);
  const tests = order.tests || [];
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
    if (claimed.has(r.canonical_name)) continue;
    claimed.add(r.canonical_name);
    group.push({
      testName: r.test_name,
      canonicalName: r.canonical_name,
      unit: r.unit,
      refRange: r.ref_range,
      panelName: r.panel_name,
      seen: Number(r.seen),
    });
  }
  return [...byTest.entries()].map(([test, params]) => ({ test, params }));
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
  const { rows } = await db.query(
    `SELECT id, test_name, canonical_name, result, result_text, unit, ref_range, flag,
            panel_name, test_date::text AS test_date
       FROM lab_results
      WHERE lab_order_id = $1
      ORDER BY test_name`,
    [orderId],
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
export async function saveResults(
  orderId,
  { rows = [], actorId = null, panelName = null },
  db = pool,
) {
  // One box on the form, two kinds of result. "Positive" is a result the doctor
  // needs; it simply cannot be trended or flagged, so it goes to result_text and
  // leaves `result` null rather than being coerced into a 0 that would read as a
  // real — and dangerously low — value.
  const entries = rows
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

  if (!entries.length) throw bad("Nothing to save — every row needs a test and a value");

  const order = await orderContext(orderId, db);
  let written = 0;
  const skipped = [];

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
                lab_order_id = $11, source = $12
          WHERE patient_id = $1 AND canonical_name = $2 AND test_date::date = $3::date
            AND (source = $12 OR lab_order_id = $11)`,
        [
          order.patient_id,
          canonical,
          order.visit_date,
          e.testName,
          e.value,
          e.valueText,
          e.unit,
          e.refRange,
          flag,
          e.panelName,
          orderId,
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
        [order.patient_id, canonical, order.visit_date],
      );
      if (owned.rowCount) {
        skipped.push(e.testName);
        continue;
      }

      const inserted = await client.query(
        `INSERT INTO lab_results
           (patient_id, appointment_id, lab_order_id, test_date, test_name, canonical_name,
            result, result_text, unit, ref_range, flag, panel_name, source)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT DO NOTHING`,
        [
          order.patient_id,
          order.appointment_id,
          orderId,
          order.visit_date,
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

  // Typed values finish the order exactly as a file does — same call, so the MO
  // is notified by one code path whether the result arrived as numbers or as a
  // scan, and a document can still be attached afterwards.
  if (order.sample_status !== "uploaded") {
    await advanceSample(orderId, { to: "uploaded", actorId }, db);
  }

  // The MO and doctor cards read appointments.biomarkers, not lab_results, so
  // without this the numbers would be in the chart and absent from the screens
  // the floor is actually looking at.
  if (order.appointment_id) {
    try {
      await syncBiomarkersFromLatestLabs(order.patient_id, order.appointment_id);
    } catch (e) {
      console.error("Lab results biomarker sync failed:", e.message);
    }
  }

  return {
    orderId,
    saved: written,
    // Named, not counted: the desk has to know WHICH value did not take, because
    // the one already on file came from somewhere else and may disagree.
    skipped,
    results: await getResults(orderId, db),
  };
}
