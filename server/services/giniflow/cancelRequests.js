import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import {
  CANCEL_STAGE,
  caseCancelKey,
  caseCancelStage,
  chargeOf,
  orderCancelKey,
  orderCancelStage,
} from "../../../shared/testCancelStages.js";
import {
  NOTE_REQUIRED_CANCEL_REASON,
  URGENT_AFTER_COLLECTION,
  URGENT_CANCEL_REASON_VALUES,
  urgentCancelReasonLabel,
} from "../../../shared/testCancelReasons.js";
import { AS_PAID } from "../../../shared/billingVocab.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import {
  announceRequest,
  audit,
  checkPending,
  finishCreate,
  insertRequest,
  lockRequest,
  readRequestIn,
} from "../billing/billingRequests.js";
import { chargeKeptCreditIn } from "../billing/creditNotes.js";
import { restoreDepositLegs } from "../billing/payments.js";
import { allocate } from "../billing/priceBill.js";
import { TEST_MATCHES_SQL } from "../billing/testMatch.js";
import { cancelTestIn, finaliseTakenDraft } from "./testCancel.js";
import { LIVE_LAB_CASE_SQL, ORDER_OUTPUT_SQL } from "./testsHold.js";
export {
  assertNotHeld,
  HELD_CASE_SQL,
  HELD_ORDER_SQL,
  PENDING_HOLD_MESSAGE,
} from "./cancelHold.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 300;
const DECISION_MAX = 500;
const LIST_LIMIT = 20;
const LIST_LIMIT_MAX = 100;
const SEARCH_MAX = 100;
const CASE_COLLECTED_ACTIONS = ["sample_taken", "sample_sent", "sample_received"];
export const CANCEL_LIST_STATUSES = ["pending", "approved", "rejected", "withdrawn"];

const bad = (status, message, extra) => httpError(status, message, extra);

function cleanId(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw bad(404, `This ${label} is no longer on the list`);
  return text.toLowerCase();
}

function cleanText(value, { min, max, required, missing }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw bad(400, missing);
    return null;
  }
  if (text.length < min) throw bad(400, missing);
  if (text.length > max) throw bad(400, `Keep it under ${max} characters`);
  return text;
}

export function cleanTarget(target) {
  if (target?.orderId) {
    return {
      orderId: cleanId(target.orderId, "test"),
      testId: target.testId ? cleanId(target.testId, "test") : null,
    };
  }
  const caseNo = typeof target?.caseNo === "string" ? target.caseNo.trim() : "";
  const patientId = Number(target?.patientId);
  const date = typeof target?.date === "string" ? target.date.trim() : "";
  if (
    !caseNo ||
    caseNo.length > 40 ||
    !Number.isInteger(patientId) ||
    patientId <= 0 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date)
  ) {
    throw bad(404, "This test is no longer on the list");
  }
  return { caseNo, patientId, date };
}

function cleanRaise(input) {
  const reasonCode = input?.reason_code;
  if (!URGENT_CANCEL_REASON_VALUES.includes(reasonCode)) {
    throw bad(400, "Pick why this test must be cancelled");
  }
  const note = cleanText(input?.note, {
    min: 3,
    max: NOTE_MAX,
    required: reasonCode === NOTE_REQUIRED_CANCEL_REASON,
    missing: "Say why — at least 3 characters",
  });
  return { target: cleanTarget(input?.target), reasonCode, note };
}

const cleanDecisionNote = (value) =>
  cleanText(value, {
    min: 3,
    max: DECISION_MAX,
    required: true,
    missing: "Write a short note for the record — at least 3 characters",
  });

function cleanCharge(input) {
  const type = input?.charge_type;
  if (type !== "percent" && type !== "fixed") {
    throw bad(400, "Choose a percentage or a fixed amount");
  }
  return { type, value: input?.charge_value };
}

async function orderFacts(db, { orderId, testId }, { lock }) {
  const { rows } = await db.query(
    `SELECT o.id, o.kind, o.sample_status, o.visit_id, v.patient_id, v.visit_date::text AS visit_date,
            ${ORDER_OUTPUT_SQL("o")} AS has_output,
            COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.test_name)
                                      ORDER BY t.test_name)
                        FROM giniflow_lab_order_tests t WHERE t.lab_order_id = o.id), '[]') AS tests
       FROM giniflow_lab_orders o JOIN giniflow_visits v ON v.id = o.visit_id
      WHERE o.id = $1
      ${lock ? "FOR UPDATE OF o" : ""}`,
    [orderId],
  );
  const order = rows[0];
  if (!order) throw bad(404, "This test is no longer on the list — it may already be cancelled");
  const test = testId ? order.tests.find((t) => t.id === testId) : null;
  if (testId && !test) throw bad(404, "That test is not on this order");
  const names = test ? [test.name] : order.tests.map((t) => t.name);
  return {
    kind: order.kind,
    visitId: order.visit_id,
    patientId: order.patient_id,
    date: order.visit_date,
    testNames: names,
    key: orderCancelKey(order.id, test && order.tests.length > 1 ? test.id : null),
    stage: orderCancelStage({
      kind: order.kind,
      sampleStatus: order.sample_status,
      hasOutput: order.has_output,
    }),
    target: {
      kind: order.kind,
      order_id: order.id,
      test_id: test && order.tests.length > 1 ? test.id : null,
      test_name: names.join(", "),
      sample_status: order.sample_status,
    },
  };
}

async function caseFacts(db, { caseNo, patientId, date }, { lock }) {
  const { rows } = await db.query(
    `SELECT lc.case_no, lc.test_names,
            ${LIVE_LAB_CASE_SQL("lc")} AS live,
            (COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'reported_on' IS NOT NULL
             OR COALESCE(lc.results_synced, FALSE)
             OR EXISTS (SELECT 1 FROM lab_results r WHERE r.lab_case_no = lc.case_no)) AS reported,
            (EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                      WHERE a.case_no = lc.case_no AND a.action = ANY($4::text[]))
             OR lc.raw_list_json->>'phlebotomy_status' = 'Completed'
             OR COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'collected_on' IS NOT NULL
             OR COALESCE(lc.raw_detail_json, lc.raw_list_json)->>'received_on' IS NOT NULL)
              AS collected,
            EXISTS (SELECT 1 FROM giniflow_lab_case_actions a
                     WHERE a.case_no = lc.case_no AND a.action = 'drawing_started') AS drawing,
            v.id AS visit_id
       FROM lab_cases lc
       JOIN patients p ON p.id = $2
       LEFT JOIN LATERAL (
         SELECT gv.id FROM giniflow_visits gv
          WHERE gv.patient_id = p.id AND gv.visit_date = $3::date AND gv.merged_into_visit_id IS NULL
          ORDER BY gv.created_at LIMIT 1
       ) v ON TRUE
      WHERE lc.case_no = $1 AND lc.case_date = $3::date
        AND (lc.patient_id = p.id
             OR (lc.patient_id IS NULL AND lc.raw_list_json->'patient'->>'healthray_uid' = p.file_no))
      ${lock ? "FOR UPDATE OF lc" : ""}`,
    [caseNo, patientId, date, CASE_COLLECTED_ACTIONS],
  );
  const found = rows[0];
  if (!found) throw bad(404, "That HealthRay case is not this patient's, or not that day's");
  if (!found.visit_id) throw bad(409, "This patient has no visit on the floor that day");
  const names = found.test_names || [];
  return {
    kind: "healthray_case",
    visitId: found.visit_id,
    patientId,
    date,
    testNames: names,
    key: caseCancelKey(caseNo),
    stage: caseCancelStage(found),
    target: {
      kind: "healthray_case",
      case_no: caseNo,
      patient_id: patientId,
      date,
      test_name: names.join(", ") || `Case ${caseNo}`,
    },
  };
}

const factsOf = (db, target, options) =>
  target.orderId ? orderFacts(db, target, options) : caseFacts(db, target, options);

const targetFromRequest = (request) => {
  const t = request.cancel_target;
  return t.order_id
    ? { orderId: t.order_id, testId: t.test_id }
    : { caseNo: t.case_no, patientId: t.patient_id, date: t.date };
};

const STAGE_REFUSAL = {
  [CANCEL_STAGE.direct]: "This test can still be cancelled directly — use Cancel test",
  [CANCEL_STAGE.cancelStartFirst]: "The sample is being drawn — cancel the start first",
  [CANCEL_STAGE.locked]: "A report is already on this test — it can't be cancelled",
};

const matchedLinesSql = (statusFilter) => `
  WITH m AS (${TEST_MATCHES_SQL("$2::text[]")})
  SELECT l.id, l.bill_id, b.status AS bill_status, b.bill_no, l.bill_name,
         l.patient_payable - COALESCE((SELECT SUM(x.patient_payable) FROM bill_lines x
                                        WHERE x.credited_line_id = l.id), 0) AS left_amount
    FROM bill_lines l
    JOIN bills b ON b.id = l.bill_id AND b.bill_type = 'invoice' AND b.status ${statusFilter}
    JOIN service_items i ON i.id = l.service_item_id
   WHERE l.is_live AND l.visit_id = $1
     AND ($3::uuid IS NULL OR l.lab_order_id = $3::uuid)
     AND ($3::uuid IS NOT NULL OR i.kind = 'test')
     AND i.test_catalog_id IN (SELECT m.catalog_id FROM m WHERE m.catalog_id IS NOT NULL)
   ORDER BY l.line_no`;

async function linesFor(db, facts, { finalOnly }) {
  const { rows } = await db.query(
    matchedLinesSql(finalOnly ? "= 'final'" : "IN ('draft', 'final')"),
    [facts.visitId, facts.testNames, facts.target.order_id ?? null],
  );
  return rows.map((row) => ({ ...row, left: paise(row.left_amount) }));
}

async function linesById(db, ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT l.id, l.bill_id, b.status AS bill_status, b.bill_no, l.bill_name,
            l.patient_payable - COALESCE((SELECT SUM(x.patient_payable) FROM bill_lines x
                                           WHERE x.credited_line_id = l.id), 0) AS left_amount
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.id = ANY($1::uuid[]) ORDER BY l.line_no`,
    [ids],
  );
  return rows.map((row) => ({ ...row, left: paise(row.left_amount) }));
}

async function writeVisitMarker(db, visitId, status, meta, ctx) {
  await db.query(
    `INSERT INTO giniflow_visit_events (visit_id, status, actor_role, actor_id, occurred_at, meta)
     VALUES ($1, $2, $3, $4, clock_timestamp(), $5)`,
    [visitId, status, ctx?.role || "system", ctx?.actorId ?? null, meta],
  );
}

async function chargeDefaults(db) {
  const { rows } = await db.query(
    `SELECT cancel_charge_type, cancel_charge_pct, cancel_charge_amount FROM billing_settings`,
  );
  return {
    type: rows[0]?.cancel_charge_type ?? "percent",
    percent: Number(rows[0]?.cancel_charge_pct ?? 10),
    fixed: Number(rows[0]?.cancel_charge_amount ?? 50),
  };
}

async function pendingFor(db, key) {
  const { rows } = await db.query(
    `SELECT id FROM billing_requests
      WHERE kind = 'test_cancel' AND status = 'pending' AND cancel_key = $1`,
    [key],
  );
  return rows[0]?.id ?? null;
}

export async function cancelStage(target, db = pool) {
  const facts = await factsOf(db, cleanTarget(target), { lock: false });
  const lines = await linesFor(db, facts, { finalOnly: false });
  return {
    stage: facts.stage,
    test_name: facts.target.test_name,
    paid: lines.reduce((sum, line) => sum + line.left, 0),
    pending_request_id: await pendingFor(db, facts.key),
    defaults: await chargeDefaults(db),
  };
}

async function raiseIn(client, wanted, ctx) {
  const facts = await factsOf(client, wanted.target, { lock: true });
  if (facts.stage !== CANCEL_STAGE.request) throw bad(409, STAGE_REFUSAL[facts.stage]);
  const label = urgentCancelReasonLabel(wanted.reasonCode);
  await client.query("SAVEPOINT test_cancel_request");
  let id;
  try {
    id = await insertRequest(
      client,
      {
        kind: "test_cancel",
        patient_id: facts.patientId,
        visit_id: facts.visitId,
        reason: wanted.note ? `${label} — ${wanted.note}` : label,
        cancel_reason_code: wanted.reasonCode,
        cancel_target: JSON.stringify({ ...facts.target, stage: facts.stage }),
        cancel_key: facts.key,
        requested_by: ctx.actorId,
      },
      ctx,
    );
  } catch (error) {
    if (error.code !== "23505") throw error;
    await client.query("ROLLBACK TO SAVEPOINT test_cancel_request");
    throw bad(409, "A cancellation is already waiting for admin for this test", {
      code: "cancel_pending",
    });
  }
  await client.query("RELEASE SAVEPOINT test_cancel_request");
  await writeVisitMarker(
    client,
    facts.visitId,
    "cancel_requested",
    { tests: facts.testNames, reason: wanted.reasonCode, note: wanted.note, request_id: id },
    ctx,
  );
  return finishCreate(client, id, ctx);
}

function actor(ctx, doing) {
  if (!ctx?.actorId) throw bad(401, `Sign in again to ${doing}`);
  return ctx;
}

export async function raiseCancelRequest(input, ctx, db = pool) {
  actor(ctx, "ask for a cancellation");
  const wanted = cleanRaise(input);
  const request = await inTransaction((client) => raiseIn(client, wanted, ctx), db);
  await announceRequest("created", request.id, db);
  return request;
}

async function closeIn(client, before, status, note, marker, ctx) {
  await client.query(
    `UPDATE billing_requests
        SET status = $2, decision_note = $3, decided_by = $4, decided_at = NOW(),
            updated_at = NOW(), updated_by = $4
      WHERE id = $1`,
    [before.id, status, note, ctx?.actorId ?? null],
  );
  await writeVisitMarker(
    client,
    before.visit_id,
    marker,
    {
      tests: [before.cancel_target.test_name],
      note,
      request_id: before.id,
    },
    ctx,
  );
  const after = await readRequestIn(client, before.id);
  await audit(client, {
    id: before.id,
    action: status === "withdrawn" ? "cancel" : "reject",
    before,
    after,
    ctx,
  });
  return after;
}

async function lockCancelRequest(client, id) {
  const before = await lockRequest(client, id);
  if (before.kind !== "test_cancel") throw bad(404, "That cancellation request no longer exists");
  return before;
}

export async function withdrawCancelRequest(id, ctx, db = pool) {
  actor(ctx, "withdraw the request");
  const request = await inTransaction(async (client) => {
    const before = await lockCancelRequest(client, id);
    checkPending(before);
    if (before.requested_by !== ctx.actorId && !ctx.canDecide) {
      throw bad(403, "Only the person who asked, or an admin, can withdraw this request");
    }
    return closeIn(client, before, "withdrawn", null, "cancel_withdrawn", ctx);
  }, db);
  await announceRequest("withdrawn", request.id, db);
  return request;
}

export async function rejectCancelRequest(id, input, ctx, db = pool) {
  actor(ctx, "answer the request");
  const note = cleanDecisionNote(input?.note);
  const request = await inTransaction(async (client) => {
    const before = await lockCancelRequest(client, id);
    checkPending(before);
    return closeIn(client, before, "rejected", note, "cancel_rejected", ctx);
  }, db);
  await announceRequest("rejected", request.id, db);
  return request;
}

async function finaliseDrafts(client, lines, ctx) {
  const drafts = [...new Set(lines.filter((l) => l.bill_status === "draft").map((l) => l.bill_id))];
  for (const billId of drafts) {
    await finaliseTakenDraft(client, billId, { actorId: ctx?.actorId, actorRole: ctx?.role });
  }
}

async function cancelTheTest(client, before, facts, ctx) {
  const target = targetFromRequest(before);
  const done = await cancelTestIn(client, {
    target: target.orderId
      ? { orderId: target.orderId, testId: target.testId }
      : { caseNos: [target.caseNo], patientId: target.patientId, date: target.date },
    reason: URGENT_AFTER_COLLECTION,
    note: before.reason,
    source: "station",
    stationLabel: "admin",
    actorId: ctx.actorId,
    actorRole: ctx.role,
    allowCollected: true,
    skipRefund: true,
  });
  if (target.orderId)
    return linesById(
      client,
      (done.billedLines || []).map((l) => l.line_id),
    );
  return linesFor(client, facts, { finalOnly: true });
}

async function approveIn(client, before, decision, ctx) {
  checkPending(before);
  const facts = await factsOf(client, targetFromRequest(before), { lock: true });
  if (facts.stage === CANCEL_STAGE.locked) {
    throw bad(
      409,
      "A report arrived on this test, so it can't be cancelled now — reject the request",
      {
        code: "report_arrived",
      },
    );
  }
  if (!facts.target.order_id)
    await finaliseDrafts(client, await linesFor(client, facts, { finalOnly: false }), ctx);
  const lines = (await cancelTheTest(client, before, facts, ctx)).filter((line) => line.left > 0);
  const bills = [...new Set(lines.map((line) => line.bill_id))];
  if (bills.length > 1) {
    throw bad(
      409,
      "This test is on more than one bill — refund it from the Billing Counter instead",
    );
  }
  const paid = lines.reduce((sum, line) => sum + line.left, 0);
  const charge = chargeOf({ type: decision.type, value: decision.value, paid: paid / 100 });
  if (charge.error) throw bad(400, charge.error);
  let note = null;
  if (charge.refund > 0) {
    const shares = allocate(
      charge.refund,
      lines.map((_, index) => index),
      lines.map((line) => line.left),
    );
    note = await chargeKeptCreditIn(
      client,
      {
        billId: bills[0],
        credits: shares.map(({ index, share }) => ({ lineId: lines[index].id, amount: share })),
      },
      ctx,
    );
  }
  await client.query(
    `UPDATE billing_requests
        SET status = 'approved', decision_note = $2, decided_by = $3, decided_at = NOW(),
            updated_at = NOW(), updated_by = $3, paid_amount = $4, charge_type = $5,
            charge_value = $6, charge_amount = $7, bill_id = $8, credit_note_id = $9,
            requested_mode = $10, approved_mode = $10
      WHERE id = $1`,
    [
      before.id,
      decision.note,
      ctx.actorId,
      (paid / 100).toFixed(2),
      decision.type,
      Number(decision.value),
      (charge.charge / 100).toFixed(2),
      bills[0] ?? null,
      note?.credit_note_id ?? null,
      note ? AS_PAID : null,
    ],
  );
  if (note) await restoreDepositLegs(client, note.credit_note_id, ctx);
  await client.query(
    `UPDATE giniflow_visit_events
        SET meta = meta || jsonb_build_object('charge', $3::int, 'request_id', $4::text)
      WHERE id = (SELECT id FROM giniflow_visit_events
                   WHERE visit_id = $1 AND status = 'test_cancelled' AND meta->>'reason' = $2
                   ORDER BY occurred_at DESC LIMIT 1)`,
    [before.visit_id, URGENT_AFTER_COLLECTION, charge.charge, before.id],
  );
  const after = await readRequestIn(client, before.id);
  await audit(client, { id: before.id, action: "approve", before, after, ctx });
  return { ...after, refund: charge.refund, charge: charge.charge, paid };
}

function cleanApproval(input) {
  const { type, value } = cleanCharge(input);
  return { type, value, note: cleanDecisionNote(input?.note) };
}

export async function approveCancelRequest(id, input, ctx, db = pool) {
  actor(ctx, "answer the request");
  const decision = cleanApproval(input);
  const result = await inTransaction(async (client) => {
    const before = await lockCancelRequest(client, id);
    return approveIn(client, before, decision, ctx);
  }, db);
  await announceRequest("approved", result.id, db);
  return result;
}

export async function cancelNow(input, ctx, db = pool) {
  actor(ctx, "cancel the test");
  const wanted = cleanRaise({ ...input, note: input?.request_note });
  const decision = cleanApproval(input);
  const result = await inTransaction(async (client) => {
    const created = await raiseIn(client, wanted, ctx);
    const before = await lockCancelRequest(client, created.id);
    return approveIn(client, before, decision, ctx);
  }, db);
  await announceRequest("approved", result.id, db);
  return result;
}

function cleanPage(value, fallback, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw bad(400, "Page and limit must be whole numbers");
  return Math.min(n, max);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function listCancelRequests(filters = {}, db = pool) {
  const where = ["r.kind = 'test_cancel'"];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (filters.status) {
    if (!CANCEL_LIST_STATUSES.includes(filters.status)) {
      throw bad(400, `Status must be one of: ${CANCEL_LIST_STATUSES.join(", ")}`);
    }
    add("r.status = ?", filters.status);
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<="],
  ]) {
    if (!filters[key]) continue;
    if (!DATE.test(filters[key])) throw bad(400, "Dates must be YYYY-MM-DD");
    add(`(r.requested_at AT TIME ZONE 'Asia/Kolkata')::date ${op} ?::date`, filters[key]);
  }
  const q = typeof filters.q === "string" ? filters.q.trim() : "";
  if (q.length > SEARCH_MAX) throw bad(400, `Keep the search under ${SEARCH_MAX} letters`);
  if (q.length >= 2) {
    add(
      "(p.name ILIKE ? OR p.file_no ILIKE ? OR r.cancel_target->>'test_name' ILIKE ?)",
      `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    );
  }
  const limit = cleanPage(filters.limit, LIST_LIMIT, LIST_LIMIT_MAX);
  const page = cleanPage(filters.page, 1, 100000);
  params.push(limit, (page - 1) * limit);
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.reason, r.cancel_reason_code, r.cancel_target, r.requested_at,
            r.decided_at, r.decision_note, r.paid_amount, r.charge_type, r.charge_value,
            r.charge_amount, r.visit_id, r.requested_by, r.decided_by,
            p.id AS patient_id, p.name AS patient_name, p.file_no, p.age, p.sex,
            rq.name AS requested_by_name, dq.name AS decided_by_name,
            b.bill_no, cn.bill_no AS credit_note_no, cn.patient_payable AS credit_note_payable,
            COUNT(*) OVER () AS total
       FROM billing_requests r
       LEFT JOIN patients p ON p.id = r.patient_id
       LEFT JOIN doctors rq ON rq.id = r.requested_by
       LEFT JOIN doctors dq ON dq.id = r.decided_by
       LEFT JOIN bills b ON b.id = r.bill_id
       LEFT JOIN bills cn ON cn.id = r.credit_note_id
      WHERE ${where.join(" AND ")}
      ORDER BY CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
               CASE WHEN r.status = 'pending' THEN r.requested_at END ASC,
               r.requested_at DESC, r.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const { rows: waiting } = await db.query(
    `SELECT COUNT(*)::int AS n FROM billing_requests WHERE kind = 'test_cancel' AND status = 'pending'`,
  );
  return {
    rows: rows.map((row) => ({
      id: row.id,
      status: row.status,
      reason: row.reason,
      reason_code: row.cancel_reason_code,
      reason_label: urgentCancelReasonLabel(row.cancel_reason_code),
      target: row.cancel_target,
      patient: {
        id: row.patient_id,
        name: row.patient_name,
        file_no: row.file_no,
        age: row.age,
        sex: row.sex,
      },
      requested_by: row.requested_by ? { id: row.requested_by, name: row.requested_by_name } : null,
      requested_at: row.requested_at,
      decided_by: row.decided_by ? { id: row.decided_by, name: row.decided_by_name } : null,
      decided_at: row.decided_at,
      decision_note: row.decision_note,
      paid: row.paid_amount === null ? null : paise(row.paid_amount),
      charge_type: row.charge_type,
      charge_value: row.charge_value === null ? null : Number(row.charge_value),
      charge: row.charge_amount === null ? null : paise(row.charge_amount),
      bill_no: row.bill_no,
      credit_note: row.credit_note_no
        ? { bill_no: row.credit_note_no, amount: paise(row.credit_note_payable) }
        : null,
    })),
    total: Number(rows[0]?.total ?? 0),
    page,
    limit,
    waiting: waiting[0].n,
  };
}

export async function cancelRequestDetail(id, db = pool) {
  const { rows } = await db.query(
    `SELECT r.id, r.status, r.cancel_target FROM billing_requests r
      WHERE r.id = $1 AND r.kind = 'test_cancel'`,
    [cleanId(id, "request")],
  );
  const request = rows[0];
  if (!request) throw bad(404, "That cancellation request no longer exists");
  const facts = await factsOf(db, targetFromRequest(request), { lock: false });
  const lines = await linesFor(db, facts, { finalOnly: false });
  return {
    id: request.id,
    status: request.status,
    stage: facts.stage,
    paid: lines.reduce((sum, line) => sum + line.left, 0),
    bills: [...new Set(lines.map((line) => line.bill_no || "draft"))],
    defaults: await chargeDefaults(db),
  };
}
