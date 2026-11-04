import pool from "../../config/db.js";
import { TESTS_DUE } from "../../../shared/testsDue.js";
import { machineFor, machinesOnBillLine } from "../../../shared/machineStages.js";
import { isLiveBillItem } from "./patientBill.js";
import { getMachines } from "./machineCatalog.js";
import { orderTests } from "./moStation.js";
import { ONLINE_VISIT_SQL } from "./rxFollowups.js";

const fail = (status, message) => Object.assign(new Error(message), { status });

const addMonths = (ymd, months) => {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(d, lastDay));
  return date.toISOString().slice(0, 10);
};

const later = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

const flatName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

function testsWithMachines(machines) {
  return TESTS_DUE.map((test) => {
    const machine = machineFor(machines, test.key);
    return {
      ...test,
      orderName: machine?.tests?.[0] || null,
      names: (machine?.tests || []).map(flatName).filter(Boolean),
      docTypes: [...new Set([...test.docTypes, ...(machine?.docTypes || [])])],
    };
  }).filter((test) => test.orderName);
}

async function loadVisit(db, visitId) {
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.visit_date, ${ONLINE_VISIT_SQL("v")} AS online
       FROM giniflow_visits v WHERE v.id = $1`,
    [visitId],
  );
  if (!rows.length) throw fail(404, "Visit not found");
  return rows[0];
}

async function lastReports(db, visit, tests) {
  const wanted = tests.map((t) => ({
    key: t.key,
    doc_types: t.docTypes,
    pattern: t.docPattern || null,
  }));
  const { rows } = await db.query(
    `SELECT w.key, MAX(COALESCE(d.doc_date, d.created_at::date))::text AS last_done
       FROM jsonb_to_recordset($2::jsonb) AS w(key text, doc_types jsonb, pattern text)
       JOIN documents d
         ON d.patient_id = $1
        AND d.doc_type IN (SELECT jsonb_array_elements_text(w.doc_types))
        AND COALESCE(d.doc_date, d.created_at::date) <= $3::date
        AND (w.pattern IS NULL
             OR concat_ws(' ', d.title, d.file_name, left(d.extracted_text, 20000)) ~* w.pattern)
      GROUP BY w.key`,
    [visit.patient_id, JSON.stringify(wanted), visit.visit_date],
  );
  return new Map(rows.map((r) => [r.key, r.last_done]));
}

async function machineOrders(db, visit, names) {
  const { rows } = await db.query(
    `SELECT regexp_replace(lower(t.test_name), '[^a-z0-9]+', '', 'g') AS flat_name,
            v.visit_date::text AS visit_date, v.id = $2 AS this_visit
       FROM giniflow_lab_order_tests t
       JOIN giniflow_lab_orders o ON o.id = t.lab_order_id
       JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE v.patient_id = $1
        AND regexp_replace(lower(t.test_name), '[^a-z0-9]+', '', 'g') = ANY($4)
        AND ((v.id = $2 AND o.sample_status <> 'cancelled')
             OR (v.visit_date < $3::date
                 AND (o.sample_status = 'reported' OR t.status = 'reported')))`,
    [visit.patient_id, visit.id, visit.visit_date, names],
  );
  return rows;
}

async function lastResults(db, visit, tests) {
  const wanted = tests.flatMap((t) => (t.resultNames || []).map((name) => ({ key: t.key, name })));
  if (!wanted.length) return new Map();
  const { rows } = await db.query(
    `SELECT w.key, MAX(r.test_date)::text AS last_done
       FROM jsonb_to_recordset($2::jsonb) AS w(key text, name text)
       JOIN lab_results r
         ON r.patient_id = $1
        AND COALESCE(r.canonical_name, r.test_name) = w.name
        AND r.test_date <= $3::date
      GROUP BY w.key`,
    [visit.patient_id, JSON.stringify(wanted), visit.visit_date],
  );
  return new Map(rows.map((r) => [r.key, r.last_done]));
}

async function billedLines(db, visit) {
  const { rows } = await db.query(
    `SELECT i AS item, b.bill_date::text AS billed_on
       FROM giniflow_patient_bills b, jsonb_array_elements(b.items) i
      WHERE b.patient_id = $1 AND b.status = 'billed' AND b.bill_date <= $2::date
     UNION ALL
     SELECT jsonb_build_object('desc', l.bill_name), v.visit_date::text
       FROM bill_lines l
       JOIN bills b ON b.id = l.bill_id
       JOIN giniflow_visits v ON v.id = l.visit_id
      WHERE v.patient_id = $1 AND v.visit_date <= $2::date
        AND l.is_live AND b.status = 'final'`,
    [visit.patient_id, visit.visit_date],
  );
  return rows;
}

async function decidedKeys(db, visitId) {
  const { rows } = await db.query(
    `SELECT test_key FROM giniflow_tests_due_decisions WHERE visit_id = $1`,
    [visitId],
  );
  return new Set(rows.map((r) => r.test_key));
}

export async function getTestsDue(visitId, db = pool) {
  const visit = await loadVisit(db, visitId);
  if (visit.online) return { due: [] };
  const machines = await getMachines(db);
  const tests = testsWithMachines(machines);
  if (!tests.length) return { due: [] };

  const [reports, results, bills, orders, decided] = await Promise.all([
    lastReports(db, visit, tests),
    lastResults(db, visit, tests),
    billedLines(db, visit),
    machineOrders(
      db,
      visit,
      tests.flatMap((t) => t.names),
    ),
    decidedKeys(db, visitId),
  ]);

  const orderedNow = new Set();
  const floorLast = new Map();
  const keyOfName = new Map(tests.flatMap((t) => t.names.map((n) => [n, t.key])));
  for (const row of orders) {
    const key = keyOfName.get(row.flat_name);
    if (!key) continue;
    if (row.this_visit) orderedNow.add(key);
    else floorLast.set(key, later(floorLast.get(key), row.visit_date));
  }

  const billLast = new Map();
  for (const { item, billed_on: billedOn } of bills) {
    if (!item?.desc || !isLiveBillItem(item)) continue;
    for (const key of machinesOnBillLine(machines, item.desc))
      billLast.set(key, later(billLast.get(key), billedOn));
  }

  const due = tests.flatMap((test) => {
    if (orderedNow.has(test.key) || decided.has(test.key)) return [];
    const recorded = [
      ["result", results.get(test.key)],
      ["floor", floorLast.get(test.key)],
      ["bill", billLast.get(test.key)],
    ].reduce((best, entry) => (entry[1] && (!best || entry[1] > best[1]) ? entry : best), null);
    const report = reports.get(test.key) || null;
    const [source, lastDone] =
      recorded && !(report && report > recorded[1]) ? recorded : report ? ["report", report] : [];
    if (!lastDone || addMonths(lastDone, test.months) > visit.visit_date) return [];
    return [
      {
        key: test.key,
        label: test.label,
        months: test.months,
        testName: test.orderName,
        lastDone,
        source,
      },
    ];
  });

  return { due, visitDate: visit.visit_date };
}

export async function decideTestsDue(
  visitId,
  { order = [], decline = [], urgency = null, actorId = null, station },
  db = pool,
) {
  const keys = [...order, ...decline];
  if (!keys.length) throw fail(400, "Choose the tests to order or decline");
  if (new Set(keys).size !== keys.length) throw fail(400, "A test is listed twice");
  if (order.length && !urgency) throw fail(400, "Choose when the tests are for");

  const { due } = await getTestsDue(visitId, db);
  const byKey = new Map(due.map((t) => [t.key, t]));
  const gone = keys.filter((k) => !byKey.has(k));
  if (gone.length)
    throw fail(
      409,
      "These tests are no longer due — they may have been ordered or answered from another screen",
    );

  const ordered = order.length
    ? await orderTests(
        visitId,
        { urgency, tests: order.map((k) => byKey.get(k).testName), actorId },
        db,
      )
    : null;
  const orderIdOf = (testName) =>
    ordered?.orders?.find((o) => o.tests.includes(testName))?.orderId ?? null;

  const visit = await loadVisit(db, visitId);
  const rows = keys.map((key) => {
    const test = byKey.get(key);
    const isOrder = order.includes(key);
    return {
      test_key: key,
      last_done: test.lastDone,
      decision: isOrder ? "ordered" : "declined",
      urgency: isOrder ? urgency : null,
      lab_order_id: isOrder ? orderIdOf(test.testName) : null,
    };
  });
  await db.query(
    `INSERT INTO giniflow_tests_due_decisions
       (visit_id, patient_id, test_key, last_done, decision, urgency, lab_order_id, decided_by, station)
     SELECT $1, $2, r.test_key, r.last_done, r.decision, r.urgency, r.lab_order_id, $3, $4
       FROM jsonb_to_recordset($5::jsonb)
         AS r(test_key text, last_done date, decision text, urgency text, lab_order_id uuid)
     ON CONFLICT (visit_id, test_key) DO NOTHING`,
    [visitId, visit.patient_id, actorId, station, JSON.stringify(rows)],
  );

  return {
    ordered: order.map((k) => byKey.get(k).label),
    declined: decline.map((k) => byKey.get(k).label),
    reachesReceptionToday: ordered?.reachesReceptionToday ?? false,
  };
}
