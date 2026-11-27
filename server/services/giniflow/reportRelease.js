import pool from "../../config/db.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { writeAudit } from "../billing/audit.js";
import { auditFields } from "../billing/common.js";
import { MONEY_COLUMNS, moneyFrom } from "../billing/payments.js";
import { checkPending, lockRequest, olderWaitingCount } from "../billing/billingRequests.js";
import { publishBillingRequest } from "./realtimeBus.js";
import { HOME_COLLECTION_SQL } from "./homeCollection.js";
import {
  RELEASE_REASON_MAX,
  RELEASE_STATUS,
  RELEASE_STATUSES,
  REPORT_RELEASE_KIND,
} from "../../../shared/reportRelease.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LIST_LIMIT = 20;
const LIST_LIMIT_MAX = 100;
const SEARCH_MAX = 100;
const NOTE_MAX = 500;

function cleanId(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text;
}

function cleanText(value, { max, required, missing }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw httpError(400, missing);
    return null;
  }
  if (text.length > max) throw httpError(400, `Keep it under ${max} characters`);
  return text;
}

function cleanPage(value, fallback, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw httpError(400, "Page and limit must be whole numbers");
  return Math.min(n, max);
}

function actor(ctx, doing) {
  if (!ctx?.actorId) throw httpError(401, `Sign in again to ${doing}`);
  return ctx;
}

const HOME_VISIT_SQL = (v) => `(
  ${HOME_COLLECTION_SQL(v)}
  OR EXISTS (
    SELECT 1 FROM giniflow_lab_orders ho
      JOIN giniflow_lab_order_events he ON he.lab_order_id = ho.id
     WHERE ho.visit_id = ${v}.id AND he.track = 'sample'
       AND he.status = 'sample_collected' AND he.meta->>'site' = 'home'
  )
  OR EXISTS (
    SELECT 1 FROM lab_cases hc
      JOIN giniflow_lab_case_actions ha ON ha.case_no = hc.case_no
     WHERE hc.patient_id = ${v}.patient_id AND hc.case_date = ${v}.visit_date
       AND ha.action = 'sample_taken' AND ha.collected_at_site = 'home'
  )
)`;

const PAYMENT_PENDING_SQL = (v) => `(
  EXISTS (
    SELECT 1 FROM giniflow_lab_orders po
     WHERE po.visit_id = ${v}.id AND po.kind = 'lab' AND po.sample_status <> 'cancelled'
       AND po.payment_status NOT IN ('paid', 'claim_approved')
  )
  OR EXISTS (
    SELECT 1 FROM giniflow_visit_steps ps
     WHERE ps.visit_id = ${v}.id AND ps.step_catalog_id = 'lab_billing' AND ps.status <> 'done'
  )
)`;

export const RELEASE_APPROVED_SQL = (visitExpr) => `EXISTS (
  SELECT 1 FROM billing_requests rr
   WHERE rr.kind = '${REPORT_RELEASE_KIND}' AND rr.status = 'approved'
     AND rr.visit_id = ${visitExpr}
)`;

export const RELEASE_STATE_SQL = (visitExpr) => `(
  SELECT json_build_object('id', rr.id, 'status', rr.status,
                           'decidedAt', rr.decided_at, 'note', rr.decision_note)
    FROM billing_requests rr
   WHERE rr.kind = '${REPORT_RELEASE_KIND}' AND rr.visit_id = ${visitExpr}
     AND rr.status <> 'withdrawn'
   ORDER BY CASE rr.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
            rr.requested_at DESC
   LIMIT 1
)`;

export async function releaseApproved(db, visitId) {
  if (!visitId) return false;
  const { rows } = await db.query(`SELECT ${RELEASE_APPROVED_SQL("$1::uuid")} AS ok`, [visitId]);
  return !!rows[0]?.ok;
}

async function visitFacts(db, visitId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT v.id, v.patient_id, v.visit_date::text AS visit_date,
            ${HOME_VISIT_SQL("v")} AS home,
            ${PAYMENT_PENDING_SQL("v")} AS payment_pending
       FROM giniflow_visits v WHERE v.id = $1
       ${lock ? "FOR SHARE OF v" : ""}`,
    [visitId],
  );
  if (!rows.length) throw httpError(404, "That visit no longer exists");
  return rows[0];
}

async function billDue(db, visitId) {
  const { rows } = await db.query(
    `SELECT b.id, b.bill_no, ${MONEY_COLUMNS}
       FROM bills b
      WHERE b.visit_id = $1 AND b.status = 'final' AND b.bill_type = 'invoice'`,
    [visitId],
  );
  return rows.reduce(
    (acc, row) => {
      const balance = moneyFrom(row).balance;
      if (balance > 0) acc.bills.push(row.bill_no);
      acc.due += balance;
      return acc;
    },
    { due: 0, bills: [] },
  );
}

const LIST_SQL = `
  SELECT r.id, r.status, r.reason, r.visit_id, r.requested_at, r.decided_at, r.decision_note,
         r.requested_by, r.decided_by,
         p.id AS patient_id, p.name AS patient_name, p.file_no, p.age, p.sex,
         v.visit_date::text AS visit_date,
         rq.name AS requested_by_name, dq.name AS decided_by_name,
         (r.requested_at AT TIME ZONE 'Asia/Kolkata')::date::text AS asked_day,
         ${PAYMENT_PENDING_SQL("v")} AS payment_pending,
         COUNT(*) OVER () AS total
    FROM billing_requests r
    JOIN giniflow_visits v ON v.id = r.visit_id
    LEFT JOIN patients p ON p.id = r.patient_id
    LEFT JOIN doctors rq ON rq.id = r.requested_by
    LEFT JOIN doctors dq ON dq.id = r.decided_by`;

const shape = (row, money = null) => ({
  id: row.id,
  status: row.status,
  reason: row.reason,
  visit_id: row.visit_id,
  visit_date: row.visit_date,
  patient: {
    id: row.patient_id,
    name: row.patient_name,
    file_no: row.file_no,
    age: row.age,
    sex: row.sex,
  },
  requested_by: row.requested_by ? { id: row.requested_by, name: row.requested_by_name } : null,
  requested_at: row.requested_at,
  day: row.asked_day,
  decided_by: row.decided_by ? { id: row.decided_by, name: row.decided_by_name } : null,
  decided_at: row.decided_at,
  decision_note: row.decision_note,
  payment_pending: !!row.payment_pending,
  due: money?.due ?? null,
  bills: money?.bills ?? [],
});

async function readOne(db, id) {
  const { rows } = await db.query(`${LIST_SQL} WHERE r.id = $1 AND r.kind = $2`, [
    id,
    REPORT_RELEASE_KIND,
  ]);
  if (!rows.length) throw httpError(404, "That release request no longer exists");
  return shape(rows[0], await billDue(db, rows[0].visit_id));
}

function announce(action, request) {
  publishBillingRequest({
    kind: REPORT_RELEASE_KIND,
    action,
    date: request.visit_date ?? null,
    requestId: request.id,
    status: request.status,
    visitId: request.visit_id,
  }).catch((e) => console.warn("[report release] live update not sent:", action, e?.message));
}

async function audit(client, { id, action, before, after, ctx }) {
  await writeAudit(client, {
    entity: "billing_requests",
    entityId: id,
    action,
    before,
    after,
    ...auditFields(ctx),
  });
}

export async function raiseReleaseRequest(input, ctx, db = pool) {
  actor(ctx, "ask for a report release");
  const visitId = cleanId(input?.visit_id, "visit");
  const reason = cleanText(input?.reason, {
    max: RELEASE_REASON_MAX,
    required: true,
    missing: "Write why the report should be released before payment",
  });
  const request = await inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`report_release:${visitId}`]);
    const visit = await visitFacts(client, visitId, { lock: true });
    if (!visit.home) {
      throw httpError(
        409,
        "Only home-collection patients can have a report released before payment",
      );
    }
    if (!visit.payment_pending) {
      throw httpError(409, "The payment is already cleared — upload the report as usual");
    }
    const { rows: open } = await client.query(
      `SELECT status FROM billing_requests
        WHERE kind = $1 AND visit_id = $2 AND status IN ('pending', 'approved')
        LIMIT 1`,
      [REPORT_RELEASE_KIND, visitId],
    );
    if (open[0]?.status === RELEASE_STATUS.PENDING) {
      throw httpError(409, "A release request for this visit is already waiting for approval");
    }
    if (open[0]?.status === RELEASE_STATUS.APPROVED) {
      throw httpError(409, "The report release is already approved — upload the report");
    }
    const { rows } = await client.query(
      `INSERT INTO billing_requests
         (kind, visit_id, patient_id, reason, requested_by, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5, $5)
       RETURNING id`,
      [REPORT_RELEASE_KIND, visitId, visit.patient_id, reason, ctx.actorId],
    );
    const after = await readOne(client, rows[0].id);
    await audit(client, { id: after.id, action: "create", after, ctx });
    return after;
  }, db);
  announce("created", request);
  return request;
}

async function lockRelease(client, id) {
  const before = await lockRequest(client, cleanId(id, "request"));
  if (before.kind !== REPORT_RELEASE_KIND) {
    throw httpError(404, "That release request no longer exists");
  }
  return before;
}

async function closeIn(client, before, status, note, ctx) {
  await client.query(
    `UPDATE billing_requests
        SET status = $2, decision_note = $3, decided_by = $4, decided_at = NOW(),
            updated_at = NOW(), updated_by = $4
      WHERE id = $1`,
    [before.id, status, note, ctx.actorId],
  );
  return readOne(client, before.id);
}

const AUDIT_ACTION = {
  approved: "approve",
  rejected: "reject",
  withdrawn: "cancel",
};

async function decideIn(id, status, note, ctx, db, guard) {
  const request = await inTransaction(async (client) => {
    const before = await lockRelease(client, id);
    checkPending(before);
    await guard?.(client, before);
    const after = await closeIn(client, before, status, note, ctx);
    await audit(client, { id: before.id, action: AUDIT_ACTION[status], before, after, ctx });
    return after;
  }, db);
  announce(status, request);
  return request;
}

const cleanDecisionNote = (value, required) =>
  cleanText(value, { max: NOTE_MAX, required, missing: "Write why the release is rejected" });

export function approveReleaseRequest(id, input, ctx, db = pool) {
  actor(ctx, "answer the request");
  return decideIn(id, RELEASE_STATUS.APPROVED, cleanDecisionNote(input?.note, false), ctx, db);
}

export function rejectReleaseRequest(id, input, ctx, db = pool) {
  actor(ctx, "answer the request");
  return decideIn(id, RELEASE_STATUS.REJECTED, cleanDecisionNote(input?.note, true), ctx, db);
}

export function withdrawReleaseRequest(id, ctx, db = pool) {
  actor(ctx, "withdraw the request");
  return decideIn(id, RELEASE_STATUS.WITHDRAWN, null, ctx, db, (_, before) => {
    if (before.requested_by !== ctx.actorId && !ctx.canDecide) {
      throw httpError(403, "Only the person who asked, or an approver, can withdraw this request");
    }
  });
}

export async function listReleaseRequests(filters = {}, db = pool) {
  const where = ["r.kind = $1"];
  const params = [REPORT_RELEASE_KIND];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (filters.status) {
    if (!RELEASE_STATUSES.includes(filters.status)) {
      throw httpError(400, `Status must be one of: ${RELEASE_STATUSES.join(", ")}`);
    }
    add("r.status = ?", filters.status);
  }
  for (const [key, op] of [
    ["from", ">="],
    ["to", "<="],
  ]) {
    if (!filters[key]) continue;
    if (!DATE.test(filters[key])) throw httpError(400, "Dates must be YYYY-MM-DD");
    add(`(r.requested_at AT TIME ZONE 'Asia/Kolkata')::date ${op} ?::date`, filters[key]);
  }
  const q = typeof filters.q === "string" ? filters.q.trim() : "";
  if (q.length > SEARCH_MAX) throw httpError(400, `Keep the search under ${SEARCH_MAX} letters`);
  if (q.length >= 2) {
    add("(p.name ILIKE ? OR p.file_no ILIKE ?)", `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  const limit = cleanPage(filters.limit, LIST_LIMIT, LIST_LIMIT_MAX);
  const page = cleanPage(filters.page, 1, 100000);
  params.push(limit, (page - 1) * limit);
  const { rows } = await db.query(
    `${LIST_SQL}
      WHERE ${where.join(" AND ")}
      ORDER BY asked_day DESC,
               CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
               CASE WHEN r.status = 'pending' THEN r.requested_at END ASC,
               r.requested_at DESC, r.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const { rows: waiting } = await db.query(
    `SELECT COUNT(*)::int AS n FROM billing_requests WHERE kind = $1 AND status = 'pending'`,
    [REPORT_RELEASE_KIND],
  );
  const filterParams = params.slice(0, -2);
  const { rows: days } = await db.query(
    `SELECT (r.requested_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE r.status = 'pending')::int AS waiting
       FROM billing_requests r
       LEFT JOIN patients p ON p.id = r.patient_id
      WHERE ${where.join(" AND ")}
        AND (r.requested_at AT TIME ZONE 'Asia/Kolkata')::date::text = ANY($${filterParams.length + 1}::text[])
      GROUP BY 1 ORDER BY 1 DESC`,
    [...filterParams, [...new Set(rows.map((row) => row.asked_day))]],
  );
  const shaped = [];
  for (const row of rows) shaped.push(shape(row, await billDue(db, row.visit_id)));
  return {
    rows: shaped,
    days,
    total: Number(rows[0]?.total ?? 0),
    page,
    limit,
    waiting: waiting[0].n,
    olderWaiting: await olderWaitingCount(db, `r.kind = '${REPORT_RELEASE_KIND}'`, {
      from: filters.from || null,
      to: filters.to || null,
    }),
  };
}

export async function releaseStateFor(visitId, db = pool) {
  const id = cleanId(visitId, "visit");
  const visit = await visitFacts(db, id);
  const { rows } = await db.query(`SELECT ${RELEASE_STATE_SQL("$1::uuid")} AS state`, [id]);
  return {
    visit_id: id,
    home: !!visit.home,
    payment_pending: !!visit.payment_pending,
    request: rows[0]?.state ?? null,
    ...(await billDue(db, id)),
  };
}
