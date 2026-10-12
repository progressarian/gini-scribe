import pool from "../../config/db.js";
import { opensLabGate } from "../../../shared/labPayment.js";
import { UNDRAWN_SAMPLE_STATUSES } from "../../../shared/labStages.js";
import { machineForTest } from "../../../shared/machineStages.js";
import { dropOrderFromDraftsIn } from "../billing/bills.js";
import { linesForOrder } from "../billing/visitLines.js";
import { getMachines } from "./machineCatalog.js";
import { insertLabStepsForOrder, insertMachineStepsForOrders } from "./journey.js";

export const CARRY_STATE = {
  PAID: "paid",
  DUE: "due",
  DRAFT: "draft",
  UNBILLED: "unbilled",
};

const LATER_URGENCIES = ["next_visit", "tomorrow"];

const fail = (status, message) => Object.assign(new Error(message), { status });

const CHOICES_SQL = `
  WITH this AS (
    SELECT id, patient_id, visit_date FROM giniflow_visits WHERE id = $1
  ), last AS (
    SELECT lv.id, lv.visit_date
      FROM this JOIN giniflow_visits lv
        ON lv.patient_id = this.patient_id AND lv.visit_date < this.visit_date
     ORDER BY lv.visit_date DESC, lv.created_at DESC
     LIMIT 1
  )
  SELECT o.id, o.kind, o.urgency, o.payment_status, o.created_at,
         last.id AS from_visit_id, last.visit_date::text AS from_date,
         ARRAY(SELECT t.test_name FROM giniflow_lab_order_tests t
                WHERE t.lab_order_id = o.id ORDER BY t.test_name) AS tests,
         bl.bill_id, bl.bill_no, bl.status AS bill_status,
         bl.paid_amount, bl.patient_payable
    FROM last
    JOIN giniflow_lab_orders o ON o.visit_id = last.id
    LEFT JOIN LATERAL (
      SELECT b.id AS bill_id, b.bill_no, b.status, b.paid_amount, b.patient_payable
        FROM bill_lines l JOIN bills b ON b.id = l.bill_id
       WHERE l.lab_order_id = o.id AND l.is_live
         AND b.bill_type = 'invoice' AND b.status <> 'cancelled'
       ORDER BY (b.status = 'final') DESC, b.created_at DESC
       LIMIT 1
    ) bl ON TRUE
   WHERE o.urgency = ANY($2) AND o.sample_status = ANY($3)
   ORDER BY o.created_at, o.id`;

function stateOf(row) {
  if (opensLabGate(row.payment_status)) return CARRY_STATE.PAID;
  if (!row.bill_id) return CARRY_STATE.UNBILLED;
  const paid = Number(row.paid_amount);
  const payable = Number(row.patient_payable);
  if (row.bill_status === "final") return paid >= payable ? CARRY_STATE.PAID : CARRY_STATE.DUE;
  if (paid > 0 && paid >= payable) return CARRY_STATE.PAID;
  return paid > 0 ? CARRY_STATE.DUE : CARRY_STATE.DRAFT;
}

const shape = (row) => ({
  orderId: row.id,
  kind: row.kind,
  urgency: row.urgency,
  orderedOn: row.from_date,
  fromVisitId: row.from_visit_id,
  tests: row.tests,
  state: stateOf(row),
  billId: row.bill_id ?? null,
  billNo: row.bill_no ?? null,
});

export async function carryOverChoices(visitId, db = pool) {
  const { rows } = await db.query(CHOICES_SQL, [visitId, LATER_URGENCIES, UNDRAWN_SAMPLE_STATUSES]);
  return rows.map(shape).filter((order) => order.tests.length);
}

async function addStationSteps(client, visitId, moved) {
  if (moved.some((order) => order.kind === "lab")) await insertLabStepsForOrder(client, visitId);
  const machineTests = moved.filter((order) => order.kind === "machine").flatMap((o) => o.tests);
  if (!machineTests.length) return;
  const machines = await getMachines(client);
  const machineIds = [
    ...new Set(machineTests.map((name) => machineForTest(machines, name)?.id).filter(Boolean)),
  ];
  if (machineIds.length) await insertMachineStepsForOrders(client, visitId, machineIds);
}

export async function carryOverIn(client, visitId, orderIds, ctx = {}) {
  const wanted = [...new Set((orderIds || []).filter(Boolean))];
  if (!wanted.length) return [];
  const { rows: visits } = await client.query(
    `SELECT visit_date::text AS visit_date FROM giniflow_visits WHERE id = $1`,
    [visitId],
  );
  if (!visits.length) throw fail(404, "Visit not found");
  await client.query(
    `SELECT id FROM giniflow_lab_orders WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [wanted],
  );
  const offered = new Map((await carryOverChoices(visitId, client)).map((o) => [o.orderId, o]));
  const moved = [];
  for (const orderId of wanted) {
    const order = offered.get(orderId);
    if (!order) throw fail(409, "That test is no longer waiting from the last visit");
    if (order.state === CARRY_STATE.DUE) {
      throw fail(
        409,
        `${order.tests.join(", ")} is still due on bill ${order.billNo || "of the last visit"} — settle it on Dues first`,
      );
    }
    if (order.state === CARRY_STATE.DRAFT) {
      await dropOrderFromDraftsIn(
        client,
        orderId,
        `Carried to the visit of ${visits[0].visit_date}`,
        ctx,
      );
    }
    await client.query(
      `UPDATE giniflow_lab_orders
          SET visit_id = $2, urgency = 'today', version = version + 1, updated_at = NOW()
        WHERE id = $1`,
      [orderId, visitId],
    );
    await client.query(
      `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, meta)
       VALUES ($1, 'visit', 'carried_over', $2, $3, $4)`,
      [
        orderId,
        ctx.role || "reception",
        ctx.actorId ?? null,
        { fromVisitId: order.fromVisitId, toVisitId: visitId, billState: order.state },
      ],
    );
    if (order.state !== CARRY_STATE.PAID) {
      await linesForOrder(visitId, { labOrderId: orderId, testNames: order.tests }, ctx, client);
    }
    moved.push(order);
  }
  await addStationSteps(client, visitId, moved);
  return moved;
}
