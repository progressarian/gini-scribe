import pool from "../../config/db.js";
import { linesForOrder } from "../billing/visitLines.js";
import { machinesForStation } from "../../../shared/machineStages.js";
import { opensLabGate } from "../../../shared/labPayment.js";
import { NOT_ON_BILL_REASON, testCancelReasonLabel } from "../../../shared/testCancelReasons.js";
import { getMachines } from "./machineCatalog.js";
import {
  insertMachineStepsForOrders,
  placeTestsBeforeDoctors,
  syncLabStepsFromLab,
} from "./journey.js";
import { reopenResultsForNewOrder } from "./statusEngine.js";

export const RESTORE_WINDOW_DAYS = 3;

export const CANCELLED_ON_FINAL_BILL = "The test was cancelled on the floor";

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const OFF_THE_FLOOR = ["dispensed", "exited", "no_show", "cancelled"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function stationFilter(db, station) {
  if (station === "lab") return { kind: "lab", machineIds: null };
  const machines = machinesForStation(await getMachines(db), station);
  return { kind: "machine", machineIds: machines.map((m) => m.id) };
}

const ON_FINAL_BILL_SQL = (orderExpr) => `EXISTS (
  SELECT 1 FROM billing_audit fa
   WHERE fa.entity = 'bill_lines' AND fa.action = 'update'
     AND fa.before ->> 'lab_order_id' = ${orderExpr}::text
     AND fa.after ->> 'lab_order_id' IS NULL
     AND fa.after ->> 'reason' = '${CANCELLED_ON_FINAL_BILL}')`;

const WHY_NOT_SQL = `CASE
  WHEN c.restored_at IS NOT NULL THEN NULL
  WHEN c.source = 'healthray' THEN 'healthray'
  WHEN c.snapshot IS NULL OR c.order_id IS NULL THEN 'no_snapshot'
  WHEN EXISTS (SELECT 1 FROM giniflow_lab_orders lo WHERE lo.id = c.order_id) THEN 'partial'
  WHEN c.visit_date < (now() AT TIME ZONE 'Asia/Kolkata')::date - ${RESTORE_WINDOW_DAYS - 1}
    THEN 'too_old'
  WHEN ${ON_FINAL_BILL_SQL("c.order_id")} THEN 'final_bill'
END`;

export const RESTORE_REFUSALS = {
  healthray: "Cancelled because HealthRay refunded or removed it — bill it again in HealthRay",
  no_snapshot: "This cancel kept no copy of the test — order the test again",
  partial: "Only this test was taken off a larger lab order — order the test again",
  too_old: `Only the last ${RESTORE_WINDOW_DAYS} days' cancels can be restored — order the test again`,
  final_bill: "The test was on a final bill, so its money went to a refund — order the test again",
};

export async function listCancelled(station, db = pool) {
  const { kind, machineIds } = await stationFilter(db, station);
  const { rows } = await db.query(
    `SELECT c.order_id, c.visit_id, c.visit_date::text AS visit_date, c.kind, c.machine_id,
            string_agg(c.test_name, ', ' ORDER BY c.test_name) AS tests,
            sum(c.price)::float AS price,
            min(c.payment_status) AS payment_status,
            max(c.amount_paid)::float AS amount_paid,
            min(c.reason) AS reason, min(c.note) AS note, min(c.source) AS source,
            min(c.cancelled_at) AS cancelled_at, min(cd.name) AS cancelled_by,
            min(c.actor_role) AS cancelled_role,
            min(c.restored_at) AS restored_at, min(rd.name) AS restored_by,
            p.id AS patient_id, p.name AS patient_name, p.file_no, p.age, p.sex,
            v.current_status,
            min(${WHY_NOT_SQL}) AS why_not,
            EXISTS (SELECT 1 FROM giniflow_lab_orders lo WHERE lo.id = c.order_id
                       AND c.restored_at IS NOT NULL
                       AND lo.sample_status = 'reported') AS reported
       FROM giniflow_test_cancellations c
       JOIN patients p ON p.id = c.patient_id
       LEFT JOIN giniflow_visits v ON v.id = c.visit_id
       LEFT JOIN doctors cd ON cd.id = c.actor_id
       LEFT JOIN doctors rd ON rd.id = c.restored_by
      WHERE c.kind = $1
        AND ($2::text[] IS NULL OR c.machine_id = ANY($2::text[]))
        AND c.visit_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${RESTORE_WINDOW_DAYS - 1}
        AND c.order_id IS NOT NULL
        AND c.reason <> $3
      GROUP BY c.order_id, c.visit_id, c.visit_date, c.kind, c.machine_id, c.restored_at,
               p.id, p.name, p.file_no, p.age, p.sex, v.current_status
      ORDER BY min(c.cancelled_at) DESC`,
    [kind, machineIds, NOT_ON_BILL_REASON],
  );
  return rows.map((row) => ({
    orderId: row.order_id,
    visitId: row.visit_id,
    visitDate: row.visit_date,
    kind: row.kind,
    machineId: row.machine_id,
    tests: row.tests,
    price: row.price,
    paymentStatus: row.payment_status,
    amountPaid: row.amount_paid,
    reason: row.reason,
    reasonLabel: testCancelReasonLabel(row.reason) || row.reason,
    note: row.note,
    source: row.source,
    cancelledAt: row.cancelled_at,
    cancelledBy: row.cancelled_by,
    cancelledRole: row.cancelled_role,
    restoredAt: row.restored_at,
    restoredBy: row.restored_by,
    reported: row.reported,
    patient: {
      id: row.patient_id,
      name: row.patient_name,
      fileNo: row.file_no,
      age: row.age,
      sex: row.sex,
    },
    canRestore: !row.restored_at && !row.why_not,
    whyNot: row.why_not ? RESTORE_REFUSALS[row.why_not] : null,
  }));
}

async function tableColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`,
    [table],
  );
  return new Set(rows.map((row) => row.column_name));
}

async function insertRow(client, table, row, columns, skip = []) {
  const keys = Object.keys(row).filter((key) => columns.has(key) && !skip.includes(key));
  await client.query(
    `INSERT INTO ${table} (${keys.join(", ")})
     SELECT ${keys.map((key) => `r.${key}`).join(", ")}
       FROM jsonb_populate_record(NULL::${table}, $1::jsonb) r`,
    [JSON.stringify(row)],
  );
}

async function cancellationsOf(client, orderId) {
  const { rows } = await client.query(
    `SELECT c.*, ${WHY_NOT_SQL} AS why_not
       FROM giniflow_test_cancellations c
      WHERE c.order_id = $1
      ORDER BY c.cancelled_at
      FOR UPDATE OF c`,
    [orderId],
  );
  return rows;
}

async function restoreIn(client, { orderId, station, actorId, actorRole }) {
  if (!UUID_RE.test(String(orderId || "")))
    throw bad("That cancelled test is not on the list", 404);
  const rows = await cancellationsOf(client, orderId);
  if (!rows.length) throw bad("That cancelled test is not on the list", 404);
  const { kind, machineIds } = await stationFilter(client, station);
  const first = rows[0];
  if (first.kind !== kind || (machineIds && !machineIds.includes(first.machine_id))) {
    throw bad("This test belongs to another station — restore it there", 409);
  }
  if (rows.every((row) => row.restored_at)) throw bad("This test is already restored", 409);
  const refusal = rows.map((row) => row.why_not).find(Boolean);
  if (refusal) throw bad(RESTORE_REFUSALS[refusal], 409);

  const { rows: visits } = await client.query(
    `SELECT id, current_status,
            visit_date = (now() AT TIME ZONE 'Asia/Kolkata')::date AS today
       FROM giniflow_visits WHERE id = $1 FOR NO KEY UPDATE`,
    [first.visit_id],
  );
  if (!visits.length) throw bad("That patient's visit no longer exists", 409);

  const snapshot = first.snapshot;
  const order = { ...snapshot.order };
  order.version = Number(order.version || 0) + 1;
  order.updated_at = new Date().toISOString();
  await insertRow(
    client,
    "giniflow_lab_orders",
    order,
    await tableColumns(client, "giniflow_lab_orders"),
  );

  const testColumns = await tableColumns(client, "giniflow_lab_order_tests");
  for (const test of snapshot.tests || []) {
    await insertRow(
      client,
      "giniflow_lab_order_tests",
      {
        id: test.id,
        lab_order_id: orderId,
        test_name: test.name,
        price: test.price,
        status: test.status,
      },
      testColumns,
    );
  }
  const eventColumns = await tableColumns(client, "giniflow_lab_order_events");
  for (const event of snapshot.events || []) {
    await insertRow(client, "giniflow_lab_order_events", event, eventColumns, ["seq"]);
  }
  await client.query(
    `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, meta)
     VALUES ($1, 'station', 'restored', $2, $3, $4)`,
    [orderId, actorRole || "system", actorId ?? null, { cancelledReason: first.reason }],
  );

  await client.query(
    `UPDATE giniflow_test_cancellations
        SET restored_at = clock_timestamp(), restored_by = $2, restored_role = $3
      WHERE order_id = $1 AND restored_at IS NULL`,
    [orderId, actorId ?? null, actorRole || null],
  );
  const tests = rows.map((row) => row.test_name);
  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, 'test_restored', $2, $3, clock_timestamp(), $4)`,
    [
      first.visit_id,
      actorRole || "system",
      actorId ?? null,
      { kind: first.kind, tests, cancelledReason: first.reason },
    ],
  );

  if (visits[0].today && !OFF_THE_FLOOR.includes(visits[0].current_status)) {
    await reopenResultsForNewOrder(client, first.visit_id);
    if (first.kind === "machine" && first.machine_id) {
      await insertMachineStepsForOrders(client, first.visit_id, [first.machine_id]);
    }
    await syncLabStepsFromLab(client, first.visit_id);
    await placeTestsBeforeDoctors(client, first.visit_id);
  }

  const settled = Number(order.amount_paid) > 0 || opensLabGate(order.payment_status);
  const billing = settled
    ? { added: [] }
    : await linesForOrder(
        first.visit_id,
        { labOrderId: orderId, testNames: tests },
        { actorId },
        client,
      );

  return {
    orderId,
    visitId: first.visit_id,
    visitDate: first.visit_date,
    tests,
    paymentStatus: order.payment_status,
    amountPaid: Number(order.amount_paid) || 0,
    billLines: billing?.added ?? [],
  };
}

export async function restoreTest(input, db = pool) {
  const own = typeof db.release !== "function";
  const client = own ? await db.connect() : db;
  try {
    if (own) await client.query("BEGIN");
    const result = await restoreIn(client, input);
    if (own) await client.query("COMMIT");
    return result;
  } catch (error) {
    if (own) await client.query("ROLLBACK");
    throw error;
  } finally {
    if (own) client.release();
  }
}
