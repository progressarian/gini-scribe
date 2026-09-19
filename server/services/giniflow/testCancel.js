import pool from "../../config/db.js";
import { derivePaymentStatus, opensLabGate } from "../../../shared/labPayment.js";
import { machineForTest, machinesOnBillLine } from "../../../shared/machineStages.js";
import {
  CANCELLABLE_ORDER_STATUSES,
  NOTE_REQUIRED_CANCEL_REASON,
  TEST_CANCEL_REASON_VALUES,
  SYNC_CANCEL_REASONS,
  NOT_ON_BILL_REASON,
} from "../../../shared/testCancelReasons.js";
import { getMachines } from "./machineCatalog.js";
import {
  CASE_CANCELLABLE_SQL,
  CASE_STARTED_SQL,
  LIVE_LAB_CASE_SQL,
  ORDER_CANCELLABLE_SQL,
  ORDER_OUTPUT_SQL,
} from "./testsHold.js";
import { placeTestsBeforeDoctors, syncLabStepsFromLab } from "./journey.js";
import { billLineRef, isLiveBillItem } from "./patientBill.js";

const SYNC_REASON_VALUES = SYNC_CANCEL_REASONS.map((r) => r.value);

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

const money = (v) => Math.round(Number(v || 0) * 100) / 100;

export function checkCancelInput({ reason, note, refundAmount, source }) {
  const allowed = source === "healthray" ? SYNC_REASON_VALUES : TEST_CANCEL_REASON_VALUES;
  if (!allowed.includes(reason)) throw bad("Pick a reason for cancelling this test");
  if (reason === NOTE_REQUIRED_CANCEL_REASON && String(note || "").trim().length < 3) {
    throw bad("Say why — a few words are enough");
  }
  if (refundAmount != null && refundAmount !== "" && !(Number(refundAmount) >= 0)) {
    throw bad("The refund amount must be zero or more");
  }
}

const liveBillItems = (bill) => (bill?.items || []).filter(isLiveBillItem);

const billLineOf = (item) => (item ? billLineRef(item) : null);

const sameBillLine = (a, b) => {
  if (!a || !b) return false;
  if (a.itemId != null || b.itemId != null) {
    return a.itemId != null && b.itemId != null && String(a.itemId) === String(b.itemId);
  }
  const sameDesc =
    String(a.desc || "")
      .trim()
      .toLowerCase() ===
    String(b.desc || "")
      .trim()
      .toLowerCase();
  if (!sameDesc) return false;
  if (a.invoice != null || b.invoice != null) return a.invoice === b.invoice;
  return Number(a.amount) === Number(b.amount);
};

const sameTest = (a, b) =>
  String(a || "")
    .trim()
    .toLowerCase() ===
  String(b || "")
    .trim()
    .toLowerCase();

export async function billSuppressor(db, visitId) {
  const { rows } = await db.query(
    `SELECT kind, test_name, machine_id, bill_line
       FROM giniflow_test_cancellations
      WHERE visit_id = $1 AND reason <> $2`,
    [visitId, NOT_ON_BILL_REASON],
  );
  return ({ kind, testName, machineId, line }) =>
    rows.some(
      (c) =>
        (c.bill_line == null || sameBillLine(c.bill_line, line)) &&
        (kind === "machine"
          ? c.kind === "machine" && c.machine_id === machineId
          : c.kind === kind && sameTest(c.test_name, testName)),
    );
}

async function storedBillItems(client, patientId, date) {
  const { rows } = await client.query(
    `SELECT status, items FROM giniflow_patient_bills WHERE patient_id = $1 AND bill_date = $2::date`,
    [patientId, date],
  );
  return rows[0] || null;
}

function billLineForTest(bill, machines, { kind, testName, machineId }) {
  const items = liveBillItems(bill);
  const item =
    kind === "machine"
      ? items.find((i) => machinesOnBillLine(machines, i.desc).includes(machineId))
      : items.find(
          (i) =>
            i.category === "lab" &&
            String(i.desc).trim().toLowerCase() === String(testName).trim().toLowerCase(),
        );
  return billLineOf(item);
}

async function lockVisit(client, visitId) {
  const { rows } = await client.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date, v.current_status
       FROM giniflow_visits v WHERE v.id = $1 FOR UPDATE`,
    [visitId],
  );
  return rows[0] || null;
}

async function orderWithState(client, orderId) {
  const { rows } = await client.query(
    `SELECT o.*, ${ORDER_OUTPUT_SQL("o")} AS has_output,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.test_name,
                                                        'price', t.price, 'status', t.status)
                                      ORDER BY t.test_name)
                        FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id), '[]') AS tests,
            COALESCE((SELECT json_agg(e ORDER BY e.seq)
                        FROM giniflow_lab_order_events e WHERE e.lab_order_id = o.id), '[]') AS events
       FROM giniflow_lab_orders o WHERE o.id = $1 FOR UPDATE`,
    [orderId],
  );
  return rows[0] || null;
}

async function writeMarker(client, visitId, meta, actorRole, actorId) {
  if (!visitId) return;
  await client.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, 'test_cancelled', $2, $3, clock_timestamp(), $4)`,
    [visitId, actorRole || "system", actorId, meta],
  );
}

async function recordCancellation(client, row) {
  await client.query(
    `INSERT INTO giniflow_test_cancellations
       (visit_id, patient_id, visit_date, kind, order_id, case_no, charge_id, test_name, machine_id,
        price, payment_status, amount_paid, amount_claimed, refund_amount, bill_line, reason, note,
        source, actor_id, actor_role, snapshot)
     VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21)`,
    [
      row.visitId ?? null,
      row.patientId ?? null,
      row.visitDate,
      row.kind,
      row.orderId ?? null,
      row.caseNo ?? null,
      row.chargeId ?? null,
      row.testName,
      row.machineId ?? null,
      row.price ?? null,
      row.paymentStatus ?? null,
      row.amountPaid ?? null,
      row.amountClaimed ?? null,
      row.refundAmount ?? null,
      row.billLine ? JSON.stringify(row.billLine) : null,
      row.reason,
      row.note ? String(row.note).trim().slice(0, 160) : null,
      row.source,
      row.actorId ?? null,
      row.actorRole ?? null,
      row.snapshot ? JSON.stringify(row.snapshot) : null,
    ],
  );
}

async function tidyMachineStep(client, visitId, machineId, machines) {
  const { rows } = await client.query(
    `SELECT t.test_name FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.kind = 'machine' AND o.urgency = 'today'`,
    [visitId],
  );
  if (rows.some((r) => machineForTest(machines, r.test_name)?.id === machineId)) return;
  await client.query(
    `DELETE FROM giniflow_visit_steps
      WHERE visit_id = $1 AND step_catalog_id = $2 AND status = 'pending'`,
    [visitId, machineId],
  );
}

async function tidyLabSteps(client, visitId) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM giniflow_lab_orders o
                     WHERE o.visit_id = v.id AND o.urgency = 'today' AND o.kind = 'lab')
            OR EXISTS (SELECT 1 FROM lab_cases lc
                        WHERE lc.case_date = v.visit_date
                          AND (lc.patient_id = v.patient_id
                               OR (lc.patient_id IS NULL
                                   AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
                          AND ${LIVE_LAB_CASE_SQL("lc")}) AS still_lab
       FROM giniflow_visits v JOIN patients p ON p.id = v.patient_id
      WHERE v.id = $1`,
    [visitId],
  );
  if (rows[0]?.still_lab) return;
  await client.query(
    `DELETE FROM giniflow_visit_steps s
      WHERE s.visit_id = $1 AND s.status = 'pending'
        AND (s.step_catalog_id IN ('lab_billing', 'blood_sample')
             OR EXISTS (SELECT 1 FROM flow_step_catalog c
                         WHERE c.id = s.step_catalog_id
                           AND c.station = 'Lab'
                           AND NOT COALESCE(c.machine, FALSE)))`,
    [visitId],
  );
}

async function afterJourneyChange(client, visitId) {
  if (!visitId) return;
  await syncLabStepsFromLab(client, visitId);
  await placeTestsBeforeDoctors(client, visitId);
}

async function patientCases(client, { patientId, date, caseNos }) {
  const { rows } = await client.query(
    `SELECT lc.case_no, lc.test_names, lc.patient_id,
            ${LIVE_LAB_CASE_SQL("lc")} AS live, ${CASE_STARTED_SQL("lc")} AS started
       FROM lab_cases lc
       LEFT JOIN patients p ON p.id = $1
      WHERE lc.case_no = ANY($3::text[])
        AND lc.case_date = $2::date
        AND (lc.patient_id = $1
             OR (lc.patient_id IS NULL
                 AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      FOR UPDATE OF lc`,
    [patientId, date, caseNos],
  );
  return rows;
}

async function cancelCasesIn(client, { visit, patientId, date, caseNos, input }) {
  const cases = await patientCases(client, { patientId, date, caseNos });
  if (cases.length !== new Set(caseNos).size) {
    throw bad("That HealthRay case is not this patient's, or not today's", 404);
  }
  const started = cases.filter((c) => c.live && c.started);
  if (started.length) {
    throw bad(
      `Case ${started.map((c) => c.case_no).join(", ")} is already under way at the lab — it cannot be cancelled`,
      409,
    );
  }
  const todo = cases.filter((c) => c.live);
  for (const c of todo) {
    await client.query(
      `INSERT INTO giniflow_lab_case_actions (case_no, action, actor_role, actor_id, note)
       VALUES ($1, 'cancelled', $2, $3, $4)
       ON CONFLICT (case_no, action) DO NOTHING`,
      [c.case_no, input.actorRole || "system", input.actorId ?? null, input.reason],
    );
    await recordCancellation(client, {
      visitId: visit?.id,
      patientId,
      visitDate: date,
      kind: "healthray_case",
      caseNo: c.case_no,
      testName: (c.test_names || []).join(", ") || `Case ${c.case_no}`,
      reason: input.reason,
      note: input.note,
      refundAmount: input.refundAmount ?? null,
      source: input.source,
      actorId: input.actorId,
      actorRole: input.actorRole,
      snapshot: { caseNo: c.case_no, tests: c.test_names },
    });
  }
  return todo.map((c) => c.case_no);
}

const paidShare = (order, tests, test) => {
  const total = tests.reduce((s, t) => s + Number(t.price || 0), 0);
  const paid = Number(order.amount_paid) || 0;
  if (!total) return tests.length === 1 ? money(paid) : 0;
  return money((paid * Number(test.price || 0)) / total);
};

async function cancelOrderIn(client, visit, order, input, machines) {
  const tests = order.tests || [];
  const single = input.testId ? tests.find((t) => t.id === input.testId) : null;
  if (input.testId && !single) throw bad("That test is not on this order", 404);
  const partial = single && tests.length > 1;
  if (partial && order.claim_state && order.claim_state !== "none") {
    throw bad("This order has an insurance claim — settle or reject the claim first", 409);
  }
  const going = partial ? [single] : tests;
  const bill = await storedBillItems(client, visit.patient_id, visit.visit_date);
  const machineId =
    order.kind === "machine" ? machineForTest(machines, tests[0]?.name)?.id || null : null;
  const snapshot = {
    order: { ...order, tests: undefined, events: undefined, has_output: undefined },
    tests,
    events: order.events,
  };

  let refundLeft = null;
  let newPaid = Number(order.amount_paid) || 0;
  if (partial) {
    const remaining = tests.filter((t) => t.id !== single.id);
    const total = money(remaining.reduce((s, t) => s + Number(t.price || 0), 0));
    newPaid = Math.min(Number(order.amount_paid) || 0, total);
    const status = derivePaymentStatus({
      amount_total: total,
      amount_paid: newPaid,
      amount_claimed: Number(order.amount_claimed) || 0,
      claim_state: order.claim_state,
    });
    await client.query(`DELETE FROM giniflow_lab_order_tests WHERE id = $1`, [single.id]);
    await client.query(
      `UPDATE giniflow_lab_orders
          SET amount_total = $2, amount_paid = $3, payment_status = $4,
              version = version + 1, updated_at = NOW()
        WHERE id = $1`,
      [order.id, total, newPaid, status],
    );
    if (status !== order.payment_status) {
      await client.query(
        `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id, meta)
         VALUES ($1, 'payment', $2, $3, $4, $5)`,
        [
          order.id,
          status,
          input.actorRole || "system",
          input.actorId ?? null,
          { cancelledTest: single.name, reason: input.reason },
        ],
      );
    }
    if (opensLabGate(status) && !opensLabGate(order.payment_status)) {
      const { rowCount } = await client.query(
        `UPDATE giniflow_lab_orders SET sample_status = 'paid'
          WHERE id = $1 AND sample_status IN ('ordered', 'payment_pending')`,
        [order.id],
      );
      if (rowCount) {
        await client.query(
          `INSERT INTO giniflow_lab_order_events (lab_order_id, track, status, actor_role, actor_id)
           VALUES ($1, 'sample', 'paid', $2, $3)`,
          [order.id, input.actorRole || "system", input.actorId ?? null],
        );
      }
    }
    refundLeft = money((Number(order.amount_paid) || 0) - newPaid);
  } else {
    await client.query(`DELETE FROM giniflow_lab_orders WHERE id = $1`, [order.id]);
  }

  for (const t of going) {
    const share = partial ? refundLeft : paidShare(order, tests, t);
    await recordCancellation(client, {
      visitId: visit.id,
      patientId: visit.patient_id,
      visitDate: visit.visit_date,
      kind: order.kind,
      orderId: order.id,
      testName: t.name,
      machineId,
      price: t.price,
      paymentStatus: order.payment_status,
      amountPaid: order.amount_paid,
      amountClaimed: order.amount_claimed,
      refundAmount:
        input.refundAmount != null && input.refundAmount !== ""
          ? money(input.refundAmount)
          : input.reason === "refunded" || input.source === "healthray"
            ? share
            : null,
      billLine:
        input.billLine ||
        billLineForTest(bill, machines, { kind: order.kind, testName: t.name, machineId }),
      reason: input.reason,
      note: input.note,
      source: input.source,
      actorId: input.actorId,
      actorRole: input.actorRole,
      snapshot,
    });
  }
  return { tests: going.map((t) => t.name), machineId, wholeOrder: !partial };
}

export async function cancelTest(input, db = pool) {
  checkCancelInput(input);
  const own = typeof db.release !== "function";
  const client = own ? await db.connect() : db;
  try {
    if (own) await client.query("BEGIN");
    const result = await cancelTestIn(client, input);
    if (own) await client.query("COMMIT");
    return result;
  } catch (e) {
    if (own) await client.query("ROLLBACK");
    throw e;
  } finally {
    if (own) client.release();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function cancelTestIn(client, input) {
  checkCancelInput(input);
  const { target } = input;
  for (const id of [target.orderId, target.testId, target.chargeId]) {
    if (id != null && !UUID_RE.test(String(id)))
      throw bad("This test is no longer on the list", 404);
  }
  const machines = await getMachines(client);

  if (target.orderId) {
    const { rows: head } = await client.query(
      `SELECT visit_id FROM giniflow_lab_orders WHERE id = $1`,
      [target.orderId],
    );
    if (!head.length)
      throw bad("This test is no longer on the list — it may already be cancelled", 404);
    const visit = await lockVisit(client, head[0].visit_id);
    const order = await orderWithState(client, target.orderId);
    if (!order) throw bad("This test is no longer on the list — it may already be cancelled", 404);
    if (input.expectKind && order.kind !== input.expectKind) {
      throw bad(`This is a ${order.kind} test — cancel it from its own station`, 409);
    }
    if (!CANCELLABLE_ORDER_STATUSES.includes(order.sample_status)) {
      throw bad(
        order.kind === "machine"
          ? order.sample_status === "in_progress"
            ? "The test is on the machine — cancel the start first"
            : "The test is already done — it cannot be cancelled"
          : order.sample_status === "drawing"
            ? "The sample is being drawn — cancel the start first"
            : "The sample is already taken — it cannot be cancelled",
        409,
      );
    }
    if (order.has_output) {
      throw bad("A report or result is already on this test — it cannot be cancelled", 409);
    }
    const done = await cancelOrderIn(
      client,
      visit,
      order,
      { ...input, testId: target.testId },
      machines,
    );
    let casesCancelled = [];
    if (order.kind === "lab" && target.caseNos?.length) {
      const { rows: left } = await client.query(
        `SELECT 1 FROM giniflow_lab_orders WHERE visit_id = $1 AND urgency = 'today' AND kind = 'lab'`,
        [visit.id],
      );
      if (!left.length) {
        casesCancelled = await cancelCasesIn(client, {
          visit,
          patientId: visit.patient_id,
          date: visit.visit_date,
          caseNos: target.caseNos,
          input,
        });
      }
    }
    await writeMarker(
      client,
      visit.id,
      {
        kind: order.kind,
        tests: done.tests,
        cases: casesCancelled,
        reason: input.reason,
        note: input.note || null,
        source: input.source,
      },
      input.actorRole,
      input.actorId,
    );
    if (order.kind === "machine" && done.machineId) {
      await tidyMachineStep(client, visit.id, done.machineId, machines);
    } else if (order.kind === "lab") {
      await tidyLabSteps(client, visit.id);
    }
    await afterJourneyChange(client, visit.id);
    return {
      visitId: visit.id,
      kind: order.kind,
      tests: done.tests,
      cases: casesCancelled,
      wholeOrder: done.wholeOrder,
    };
  }

  if (target.caseNos?.length) {
    const { patientId, date } = target;
    if (!patientId || !date) throw bad("Which patient and day is this case for?");
    const { rows: vrows } = await client.query(
      `SELECT id FROM giniflow_visits
        WHERE patient_id = $1 AND visit_date = $2::date AND merged_into_visit_id IS NULL
        ORDER BY merged_into_visit_id NULLS FIRST, created_at LIMIT 1`,
      [patientId, date],
    );
    const visit = vrows.length ? await lockVisit(client, vrows[0].id) : null;
    const cases = await cancelCasesIn(client, {
      visit,
      patientId,
      date,
      caseNos: target.caseNos,
      input,
    });
    if (!cases.length)
      return { visitId: visit?.id ?? null, kind: "healthray_case", cases, unchanged: true };
    await writeMarker(
      client,
      visit?.id,
      {
        kind: "healthray_case",
        cases,
        reason: input.reason,
        note: input.note || null,
        source: input.source,
      },
      input.actorRole,
      input.actorId,
    );
    if (visit) {
      await tidyLabSteps(client, visit.id);
      await afterJourneyChange(client, visit.id);
    }
    return { visitId: visit?.id ?? null, kind: "healthray_case", cases };
  }

  if (target.chargeId) {
    const { rows } = await client.query(
      `SELECT c.*, v.patient_id, v.visit_date::text AS visit_date
         FROM giniflow_bill_charges c JOIN giniflow_visits v ON v.id = c.visit_id
        WHERE c.id = $1 FOR UPDATE OF c`,
      [target.chargeId],
    );
    const charge = rows[0];
    if (!charge) throw bad("Charge not found", 404);
    if (charge.payment_status !== "pending") {
      throw bad("This charge is already paid — the refund is done in HealthRay", 409);
    }
    await lockVisit(client, charge.visit_id);
    await client.query(`DELETE FROM giniflow_bill_charges WHERE id = $1`, [charge.id]);
    await recordCancellation(client, {
      visitId: charge.visit_id,
      patientId: charge.patient_id,
      visitDate: charge.visit_date,
      kind: "charge",
      chargeId: charge.id,
      testName: charge.item_name,
      price: charge.amount,
      paymentStatus: charge.payment_status,
      refundAmount: input.refundAmount ?? null,
      billLine: input.billLine ||
        billLineOf(
          liveBillItems(await storedBillItems(client, charge.patient_id, charge.visit_date)).find(
            (i) =>
              String(i.desc).trim().toLowerCase() === String(charge.item_name).trim().toLowerCase(),
          ),
        ) || { itemId: null, invoice: null, desc: charge.item_name, amount: Number(charge.amount) },
      reason: input.reason,
      note: input.note,
      source: input.source,
      actorId: input.actorId,
      actorRole: input.actorRole,
      snapshot: { charge },
    });
    await writeMarker(
      client,
      charge.visit_id,
      {
        kind: "charge",
        tests: [charge.item_name],
        reason: input.reason,
        note: input.note || null,
        source: input.source,
      },
      input.actorRole,
      input.actorId,
    );
    return { visitId: charge.visit_id, kind: "charge", tests: [charge.item_name] };
  }

  throw bad("Nothing to cancel");
}

export async function markCasesCancelledInHealthray(caseNos, db = pool) {
  const ids = [...new Set((caseNos || []).map(String).filter(Boolean))];
  if (!ids.length) return 0;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE lab_cases lc
          SET case_status = 'Cancelled'
        WHERE lc.case_no = ANY($1::text[])
          AND lower(COALESCE(lc.case_status, '')) <> 'cancelled'
      RETURNING lc.case_no, lc.patient_id, lc.case_date::text AS case_date, lc.test_names,
                EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                         WHERE a.case_no = lc.case_no AND a.action = 'cancelled') AS scribe_cancelled`,
      [ids],
    );
    for (const c of rows.filter((r) => !r.scribe_cancelled)) {
      const { rows: v } = c.patient_id
        ? await client.query(
            `SELECT id FROM giniflow_visits
              WHERE patient_id = $1 AND visit_date = $2::date AND merged_into_visit_id IS NULL
              ORDER BY merged_into_visit_id NULLS FIRST, created_at LIMIT 1`,
            [c.patient_id, c.case_date],
          )
        : { rows: [] };
      const visitId = v[0]?.id ?? null;
      await recordCancellation(client, {
        visitId,
        patientId: c.patient_id,
        visitDate: c.case_date,
        kind: "healthray_case",
        caseNo: c.case_no,
        testName: (c.test_names || []).join(", ") || `Case ${c.case_no}`,
        reason: "cancelled_in_healthray",
        source: "healthray",
        snapshot: { caseNo: c.case_no, tests: c.test_names },
      });
      if (visitId) {
        await writeMarker(
          client,
          visitId,
          {
            kind: "healthray_case",
            cases: [c.case_no],
            reason: "cancelled_in_healthray",
            source: "healthray",
          },
          "system",
          null,
        );
        await tidyLabSteps(client, visitId);
        await afterJourneyChange(client, visitId);
      }
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const normName = (v) =>
  String(v || "")
    .trim()
    .toLowerCase();

const syncReasonOf = (line) =>
  line.cancelled
    ? "cancelled_in_healthray"
    : line.removed
      ? "removed_from_bill"
      : "refunded_in_healthray";

const refundOf = (line, parts = 1) =>
  line.refunded != null && Number(line.refunded) > 0
    ? money(Number(line.refunded) / Math.max(1, parts))
    : null;

export const autoCancelMode = () =>
  String(process.env.SCRIBE_BILL_AUTO_CANCEL ?? "1").toLowerCase();

const orderedBeforeDeath = (createdAt, line) =>
  !line.deadSince || !createdAt || new Date(createdAt) <= new Date(line.deadSince);

export async function cancelDeadBillTests(client, visitId, bill, machines) {
  const result = { cancelled: 0, kept: [], wouldCancel: [], failed: [] };
  const mode = autoCancelMode();
  if (mode === "0" || mode === "off") return result;
  if (bill?.status !== "billed") return result;
  const items = bill.items || [];
  const dead = items.filter((i) => !isLiveBillItem(i));
  if (!dead.length) return result;
  const live = items.filter(isLiveBillItem);
  const liveMachines = new Set(live.flatMap((i) => machinesOnBillLine(machines, i.desc)));
  const liveLab = new Set(live.filter((i) => i.category === "lab").map((i) => normName(i.desc)));
  const liveNames = new Set(live.map((i) => normName(i.desc)));

  const { rows: orders } = await client.query(
    `SELECT o.id, o.kind, o.created_at, COALESCE(o.claim_state, 'none') AS claim_state,
            ${ORDER_CANCELLABLE_SQL("o")} AS can_cancel,
            json_agg(json_build_object('id', t.id, 'name', t.test_name)) AS tests
       FROM giniflow_lab_orders o
       JOIN giniflow_lab_order_tests t ON t.lab_order_id = o.id
      WHERE o.visit_id = $1 AND o.urgency = 'today'
      GROUP BY o.id`,
    [visitId],
  );
  const run = async (target, line, parts, what) => {
    if (mode === "dry") {
      result.wouldCancel.push({ test: what, line: line.desc, reason: syncReasonOf(line) });
      return true;
    }
    await client.query("SAVEPOINT auto_cancel");
    try {
      await cancelTestIn(client, {
        target,
        reason: syncReasonOf(line),
        source: "healthray",
        actorRole: "system",
        refundAmount: refundOf(line, parts),
        billLine: billLineRef(line),
      });
      await client.query("RELEASE SAVEPOINT auto_cancel");
      result.cancelled += 1;
      return true;
    } catch (e) {
      await client.query("ROLLBACK TO SAVEPOINT auto_cancel");
      result.failed.push({ test: what, line: line.desc, error: e.message });
      return false;
    }
  };

  for (const line of dead) {
    const onLine = machinesOnBillLine(machines, line.desc);
    if (onLine.length) {
      for (const machineId of onLine) {
        if (liveMachines.has(machineId)) continue;
        const order = orders.find(
          (o) =>
            !o.gone &&
            o.kind === "machine" &&
            o.tests.some((t) => machineForTest(machines, t.name)?.id === machineId),
        );
        if (!order || !orderedBeforeDeath(order.created_at, line)) continue;
        if (!order.can_cancel) {
          result.kept.push({ test: order.tests[0]?.name, line: line.desc });
          continue;
        }
        if (await run({ orderId: order.id }, line, onLine.length, order.tests[0]?.name)) {
          order.gone = true;
        }
      }
      continue;
    }
    if (line.category === "lab") {
      if (liveLab.has(normName(line.desc))) continue;
      for (const order of orders.filter((o) => !o.gone && o.kind === "lab")) {
        const test = order.tests.find((t) => normName(t.name) === normName(line.desc));
        if (!test || !orderedBeforeDeath(order.created_at, line)) continue;
        const claimed = order.claim_state !== "none" && order.tests.length > 1;
        if (!order.can_cancel || claimed) {
          result.kept.push({ test: test.name, line: line.desc });
          continue;
        }
        if (await run({ orderId: order.id, testId: test.id }, line, 1, test.name)) {
          order.tests = order.tests.filter((t) => t.id !== test.id);
          if (!order.tests.length) order.gone = true;
        }
      }
      continue;
    }
    if (liveNames.has(normName(line.desc))) continue;
    const { rows: charges } = await client.query(
      `SELECT id, created_at FROM giniflow_bill_charges
        WHERE visit_id = $1 AND payment_status = 'pending' AND lower(btrim(item_name)) = $2`,
      [visitId, normName(line.desc)],
    );
    for (const c of charges) {
      if (orderedBeforeDeath(c.created_at, line)) await run({ chargeId: c.id }, line, 1, line.desc);
    }
  }

  if (dead.some((i) => i.category === "lab") && !live.some((i) => i.category === "lab")) {
    const { rows } = await client.query(
      `SELECT lc.case_no, v.patient_id, v.visit_date::text AS visit_date
         FROM giniflow_visits v
         JOIN patients p ON p.id = v.patient_id
         JOIN lab_cases lc
           ON lc.case_date = v.visit_date
          AND (lc.patient_id = v.patient_id
               OR (lc.patient_id IS NULL
                   AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
        WHERE v.id = $1 AND ${CASE_CANCELLABLE_SQL("lc")}`,
      [visitId],
    );
    if (rows.length) {
      const line = dead.find((i) => i.category === "lab");
      await run(
        {
          caseNos: rows.map((r) => r.case_no),
          patientId: rows[0].patient_id,
          date: rows[0].visit_date,
        },
        line,
        rows.length,
        `cases ${rows.map((r) => r.case_no).join(", ")}`,
      );
    }
  }
  return result;
}
