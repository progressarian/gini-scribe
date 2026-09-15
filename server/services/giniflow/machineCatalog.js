import pool from "../../config/db.js";
import { shapeMachine } from "../../../shared/machineStages.js";
import { createLogger } from "../logger.js";

const { error } = createLogger("Machine Catalog");

const TTL_MS = Number(process.env.MACHINE_CATALOG_TTL_MS) || 60 * 1000;

let cached = null;
let cachedAt = 0;
let loading = null;

async function load(db) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, default_duration_min, machine_short_name, machine_full_name, machine_icon,
              order_test_name, bill_names, value_fields, report_doc_types, hands_over,
              machine_station, machine_requires_before
         FROM flow_step_catalog
        WHERE machine AND COALESCE(is_active, TRUE)
        ORDER BY machine_order NULLS LAST, name`,
    );
    const machines = rows.map(shapeMachine);
    if (!machines.length && cached?.length) {
      error("load", "catalogue returned no machines — keeping the last known list");
      return cached;
    }
    cached = machines;
    cachedAt = Date.now();
    return machines;
  } catch (e) {
    if (cached) {
      error("load", `${e.message} — keeping the last known list`);
      return cached;
    }
    throw e;
  }
}

export async function getMachines(db = pool) {
  if (cached && Date.now() - cachedAt < TTL_MS) return cached;
  if (!loading) loading = load(db).finally(() => (loading = null));
  return loading;
}

export function clearMachineCache() {
  cachedAt = 0;
}

const MACHINE_KEYS = [
  "machine",
  "machine_order",
  "machine_short_name",
  "machine_full_name",
  "machine_icon",
  "order_test_name",
  "bill_names",
  "value_fields",
  "report_doc_types",
  "hands_over",
];

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const flatName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const cleanText = (value, max) => {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : null;
};

const cleanList = (value, { max = 20, length = 60 } = {}) => {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[\n,]/);
  const seen = new Set();
  const out = [];
  for (const raw of items) {
    const item = String(raw ?? "")
      .trim()
      .slice(0, length);
    const key = item.toLowerCase().replace(/\s+/g, " ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, max);
};

export const touchesMachineSettings = (body = {}) =>
  MACHINE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));

export async function openMachineOrders(stepId, db = pool) {
  const machine = (await getMachines(db)).find((m) => m.id === stepId);
  if (!machine) return 0;
  const { rows } = await db.query(
    `SELECT count(DISTINCT o.id)::int AS open
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.kind = 'machine'
        AND o.sample_status <> 'reported'
        AND v.visit_date = (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        AND lower(regexp_replace(t.test_name, '[^a-zA-Z0-9]+', '', 'g')) = ANY($1::text[])`,
    [machine.tests.map(flatName)],
  );
  return rows[0].open;
}

// Waiting / running / unreported counts for a set of machines, scoped by test
// name the way `openMachineOrders` scopes a single machine — reused by the
// station launcher tiles to split one combined "machine" count into one per
// station without duplicating the flatName matching.
export async function stationOrderCounts(machines, visitDate, db = pool) {
  const names = machines.flatMap((m) => m.tests.map(flatName));
  if (!names.length) return { waiting: 0, running: 0, unreported: 0 };
  const { rows } = await db.query(
    `SELECT
       count(DISTINCT o.id) FILTER (
         WHERE o.sample_status IN ('ordered', 'payment_pending', 'paid'))::int AS waiting,
       count(DISTINCT o.id) FILTER (WHERE o.sample_status = 'in_progress')::int AS running,
       count(DISTINCT o.id) FILTER (WHERE o.sample_status = 'done')::int AS unreported
       FROM giniflow_lab_orders o
       JOIN giniflow_visits v ON v.id = o.visit_id
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.kind = 'machine'
        AND v.visit_date = $1::date
        AND lower(regexp_replace(t.test_name, '[^a-zA-Z0-9]+', '', 'g')) = ANY($2::text[])`,
    [visitDate, names],
  );
  return rows[0];
}

export async function assertMachineCanStop(stepId, db = pool) {
  const open = await openMachineOrders(stepId, db);
  if (open > 0) {
    throw bad(
      `${open} open test${open === 1 ? "" : "s"} on this machine today — finish or remove ${open === 1 ? "it" : "them"} before switching the machine off`,
      409,
    );
  }
}

export async function machineOptions(reportTypes, db = pool) {
  const { rows } = await db.query(
    `SELECT test_name, price FROM giniflow_test_catalog
      WHERE category = 'machine' AND COALESCE(is_active, TRUE)
      ORDER BY test_name`,
  );
  return {
    reportTypes,
    tests: rows.map((r) => ({ testName: r.test_name, price: Number(r.price) })),
  };
}

export async function saveMachineSettings(stepId, body, { reportTypes }, db = pool) {
  const { rows } = await db.query(`SELECT * FROM flow_step_catalog WHERE id = $1`, [stepId]);
  if (!rows.length) throw bad("Catalog step not found", 404);
  const current = rows[0];
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const pick = (key, clean) => (has(key) ? clean(body[key]) : current[key]);

  const next = {
    machine: has("machine") ? body.machine === true : current.machine,
    machine_order: pick("machine_order", (v) =>
      Number.isInteger(Number(v)) && v !== "" && v !== null ? Number(v) : null,
    ),
    machine_short_name: pick("machine_short_name", (v) => cleanText(v, 40)),
    machine_full_name: pick("machine_full_name", (v) => cleanText(v, 80)),
    machine_icon: pick("machine_icon", (v) => cleanText(v, 8)),
    order_test_name: pick("order_test_name", (v) => cleanText(v, 120)),
    bill_names: pick("bill_names", (v) => cleanList(v)),
    value_fields: pick("value_fields", (v) => cleanList(v, { max: 20, length: 80 })),
    report_doc_types: pick("report_doc_types", (v) => cleanList(v, { max: 10, length: 30 })),
    hands_over: has("hands_over") ? body.hands_over === true : current.hands_over,
  };

  if (current.machine && !next.machine) await assertMachineCanStop(stepId, db);

  if (next.machine) {
    if (!next.order_test_name) throw bad("Pick the priced test this machine bills against");
    const { rows: priced } = await db.query(
      `SELECT test_name FROM giniflow_test_catalog
        WHERE lower(test_name) = lower($1) AND category = 'machine' AND COALESCE(is_active, TRUE)`,
      [next.order_test_name],
    );
    if (!priced.length) {
      throw bad(`"${next.order_test_name}" is not a priced machine test in the test catalogue`);
    }
    next.order_test_name = priced[0].test_name;

    const unknownTypes = next.report_doc_types.filter((t) => !reportTypes.includes(t));
    if (unknownTypes.length) throw bad(`Unknown report type: ${unknownTypes.join(", ")}`);

    const mine = [next.order_test_name, ...next.bill_names];
    clearMachineCache();
    const others = (await getMachines(db)).filter((m) => m.id !== stepId);
    for (const name of mine) {
      const owner = others.find((m) => m.tests.some((t) => flatName(t) === flatName(name)));
      if (owner) {
        throw bad(`"${name}" already belongs to ${owner.name} — one bill name, one machine`, 409);
      }
    }
  }

  const { rows: saved } = await db.query(
    `UPDATE flow_step_catalog
        SET machine = $2, machine_order = $3, machine_short_name = $4, machine_full_name = $5,
            machine_icon = $6, order_test_name = $7, bill_names = $8, value_fields = $9,
            report_doc_types = $10, hands_over = $11
      WHERE id = $1
      RETURNING *`,
    [
      stepId,
      next.machine,
      next.machine_order,
      next.machine_short_name,
      next.machine_full_name,
      next.machine_icon,
      next.order_test_name,
      next.bill_names,
      next.value_fields,
      next.report_doc_types,
      next.hands_over,
    ],
  );
  clearMachineCache();
  return saved[0];
}
