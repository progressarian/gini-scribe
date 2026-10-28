import pool from "../../config/db.js";
import { getCanonical } from "../../utils/labCanonical.js";
import { flagForRange } from "../../utils/labFlag.js";
import { advanceSample, assertSampleDrawn, markCaseResultsReady } from "./labStation.js";
import { syncLabStepsFromLab } from "./journey.js";
import { advanceMachineTest } from "./machineStation.js";
import { machineForTest } from "../../../shared/machineStages.js";
import { getMachines } from "./machineCatalog.js";
import { opensLabGate } from "../../../shared/labPayment.js";
import { syncBiomarkersFromLatestLabs } from "../healthray/db.js";
import { catalogRowsFor, catalogTestsByIds, patientFor } from "./labCatalog.js";
import { computeFormulas, formulaInputs, rangeText, flagFor } from "../../../shared/labFormula.js";
import { assertNotHeld } from "./cancelHold.js";

const SOURCE = "manual";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const trimmed = (v, max = 200) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const orderContext = async (orderId, db) => {
  const { rows } = await db.query(
    `SELECT o.id, o.kind, o.sample_status, o.report_file_url, o.payment_status,
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
const PREFILL_PER_TEST = 12;

const flattenName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

export async function suggestedRows(orderId, db = pool) {
  const order = await orderContext(orderId, db);
  const groups = await suggestionsForTests(order.tests || [], db, order.patient_id);
  if (order.kind !== "machine") return groups;
  const machines = await getMachines(db);
  return groups.map((group) => {
    const presets = machineForTest(machines, group.test)?.values || [];
    if (!presets.length) return group;
    const taken = new Set([flattenName(group.test), ...presets.map(flattenName)]);
    return {
      test: group.test,
      params: [
        ...presets.map((name) => ({
          testName: name,
          canonicalName: null,
          unit: null,
          refRange: null,
          panelName: group.test,
          seen: 0,
        })),
        ...group.params.filter((p) => !taken.has(flattenName(p.testName))),
      ],
    };
  });
}
export async function suggestedCaseRows(caseNo, db = pool) {
  const c = await caseContext(caseNo, db);
  return suggestionsForTests(c.tests || [], db, c.patient_id);
}
async function suggestionsForTests(tests, db = pool, patientId = null) {
  if (!tests.length) return [];

  const patient = patientId ? await patientFor(patientId, db) : {};
  const fromCatalog = await catalogRowsFor(tests, patient, db);
  const missing = tests.filter((t) => !fromCatalog.get(t)?.length);
  const guessed = missing.length ? await guessedRowsForTests(missing, db) : [];
  const byGuess = new Map(guessed.map((g) => [g.test, g.params]));

  return tests.map((test) => ({
    test,
    params: fromCatalog.get(test)?.length ? fromCatalog.get(test) : byGuess.get(test) || [],
  }));
}

async function guessedRowsForTests(tests, db = pool) {
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
const normalise = (rows, panelName) =>
  rows
    .map((r) => {
      const raw = r.value;
      const numeric = typeof raw === "number" ? raw : null;
      const worded = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
      return {
        testId: /^\d+$/.test(String(r.testId ?? "")) ? String(r.testId) : null,
        testName: trimmed(r.testName, 120),
        value: numeric,
        valueText: trimmed(r.valueText, 120) || (worded ? worded.slice(0, 120) : null),
        unit: trimmed(r.unit, 40),
        refRange: trimmed(r.refRange, 60),
        panelName: trimmed(r.panelName, 120) || trimmed(panelName, 120),
      };
    })
    .filter(
      (r) => r.testName && (Number.isFinite(r.value) || r.valueText || r.calculatedPlaceholder),
    );

async function applyCatalog(entries, patientId, db) {
  const ids = entries.map((e) => e.testId).filter(Boolean);
  if (!ids.length) return entries;

  const patient = patientId ? await patientFor(patientId, db) : {};
  const direct = await catalogTestsByIds(ids, patient, db);
  const inputIds = direct.flatMap((t) => formulaInputs(t.formula)).map(String);
  const extra = inputIds.filter((id) => !ids.includes(id));
  const catalog = [...direct, ...(extra.length ? await catalogTestsByIds(extra, patient, db) : [])];
  const byId = new Map(catalog.map((t) => [t.id, t]));

  const typed = {};
  for (const e of entries) if (e.testId) typed[e.testId] = e.value ?? e.valueText;
  const computed = computeFormulas(catalog, typed);

  return entries
    .map((e) => {
      const test = e.testId ? byId.get(e.testId) : null;
      if (!test) return e;
      const value = test.formula ? computed[test.id] : e.value;
      if (test.formula && value === null) return null;
      const { flag, critical } = flagFor(value ?? e.valueText, test.range);
      return {
        ...e,
        testName: test.name || e.testName,
        value: test.formula ? value : e.value,
        valueText: test.formula ? null : e.valueText,
        unit: test.unit ?? e.unit,
        refRange: rangeText(test.range) || null,
        flag,
        isCritical: critical,
      };
    })
    .filter(Boolean);
}

async function writeEntries(db, ctx, entries, column) {
  const link = column === "lab_case_no" ? ctx.caseNo : ctx.id;
  let written = 0;
  const skipped = [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    for (const e of entries) {
      const canonical = getCanonical(e.testName) || e.testName.toLowerCase().replace(/\s+/g, "_");
      const flag =
        e.flag !== undefined ? e.flag : e.value === null ? null : flagForRange(e.value, e.refRange);

      const updated = await client.query(
        `UPDATE lab_results
            SET test_name = $4, result = $5, result_text = $6, unit = $7,
                ref_range = $8, flag = $9, panel_name = COALESCE($10, panel_name),
                ${column} = $11, source = $12, is_critical = $13
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
          e.isCritical === true,
        ],
      );
      if (updated.rowCount) {
        written += 1;
        continue;
      }
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
            result, result_text, unit, ref_range, flag, panel_name, source, is_critical)
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
          e.isCritical === true,
        ],
      );
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
  await assertNotHeld(db, { orderId });
  if (!opensLabGate(order.payment_status)) {
    throw bad(
      order.payment_status === "insurance_claim"
        ? "The insurance claim is not approved yet — results cannot be recorded against this order"
        : "Payment is not cleared for this order",
      409,
    );
  }
  assertSampleDrawn(order);

  const { written, skipped } = await writeEntries(
    db,
    { ...order, id: orderId },
    await applyCatalog(entries, order.patient_id, db),
    "lab_order_id",
  );
  if (order.kind === "machine") {
    if (order.sample_status !== "reported") {
      await advanceMachineTest(orderId, { to: "reported", actorId }, db);
    }
  } else if (order.sample_status !== "uploaded") {
    await advanceSample(orderId, { to: "uploaded", actorId }, db);
  }
  await syncBiomarkers(order.patient_id, order.appointment_id);

  return {
    orderId,
    saved: written,
    skipped,
    results: await getResults(orderId, db),
  };
}

export async function saveCaseResults(
  caseNo,
  { rows = [], actorId = null, actorRole = "lab", panelName = null },
  db = pool,
) {
  const entries = normalise(rows, panelName);
  if (!entries.length) throw bad("Nothing to save — every row needs a test and a value");

  const c = await caseContext(caseNo, db);
  const { written, skipped } = await writeEntries(
    db,
    c,
    await applyCatalog(entries, c.patient_id, db),
    "lab_case_no",
  );

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
  if (written && c.visit_id) await syncLabStepsFromLab(db, c.visit_id);

  return {
    caseNo,
    patientName: c.patientName,
    saved: written,
    skipped,
    markedResultsReady: ready.rowCount > 0,
    results: await getCaseResults(caseNo, db),
  };
}
