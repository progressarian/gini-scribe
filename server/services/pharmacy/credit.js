import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { nextNumber } from "../billing/billNumber.js";
import { getBill } from "./bills.js";
import { recordBillPayments } from "./accounts.js";
import { DUE_SQL, PATIENT_DUE_SQL } from "./billDue.js";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney.js";
import { PHARMACY_SERIES } from "../../../shared/pharmacyVocab.js";
import { CAPABILITIES as CAP } from "../../../shared/permissions.js";
import { raiseNotification, resolveNotifications } from "../notifications.js";

const ENTITY = "pharmacy_credit_requests";

const toRupeeText = (paise) => `₹${toRupees(paise)}`;

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

const audit = (client, ctx, id, action, before, after) =>
  writeAudit(client, {
    entity: ENTITY,
    entityId: id,
    action,
    before,
    after,
    actorId: ctx.actorId,
    ip: ctx.ip,
  });

async function creditRoom(client, patientId, billId) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('pharmacy_credit_patient:' || $1))`, [
    patientId,
  ]);
  const { rows } = await client.query(
    `SELECT (SELECT credit_limit FROM pharmacy_settings WHERE id) AS credit_limit,
            ${PATIENT_DUE_SQL("$1::int")} AS due,
            COALESCE((SELECT SUM(r.approved_amount) FROM pharmacy_credit_requests r
                       WHERE r.patient_id = $1 AND r.status = 'approved'
                         AND r.bill_id <> $2), 0) AS reserved`,
    [patientId, billId],
  );
  const limit = rows[0].credit_limit === null ? null : toPaise(rows[0].credit_limit);
  const due = toPaise(rows[0].due);
  const reserved = toPaise(rows[0].reserved);
  const room = limit === null ? null : Math.max(limit - due - reserved, 0);
  return { limit, due, reserved, room };
}

function assertWithinLimit(space, wanted) {
  if (space.limit === null || wanted <= space.room) return;
  const owes = `this patient already owes ${toRupeeText(space.due)}${
    space.reserved
      ? ` and has ${toRupeeText(space.reserved)} of credit approved but not yet billed`
      : ""
  }`;
  throw httpError(
    409,
    space.room
      ? `The credit limit is ${toRupeeText(space.limit)} and ${owes}, so at most ${toRupeeText(space.room)} more can be given on credit`
      : `The credit limit is ${toRupeeText(space.limit)} and ${owes}. Collect what is due before giving more credit`,
  );
}

async function lockBill(client, billId) {
  const { rows } = await client.query(`SELECT * FROM pharmacy_bills WHERE id = $1 FOR UPDATE`, [
    billId,
  ]);
  if (!rows.length) throw httpError(404, "Pharmacy bill not found");
  return rows[0];
}

async function bumpBill(client, billId, ctx) {
  await client.query(
    `UPDATE pharmacy_bills SET version = version + 1, updated_at = NOW(), updated_by = $2
      WHERE id = $1`,
    [billId, ctx.actorId ?? null],
  );
}

async function lockRequest(client, id) {
  const { rows: found } = await client.query(
    `SELECT bill_id FROM pharmacy_credit_requests WHERE id = $1`,
    [id],
  );
  if (!found.length) throw httpError(404, "Credit request not found");
  const bill = await lockBill(client, found[0].bill_id);
  const { rows } = await client.query(
    `SELECT * FROM pharmacy_credit_requests WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return { request: rows[0], bill };
}

export async function requestCredit(billId, { version, amount, reason }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const bill = await lockBill(client, billId);
    if (bill.version !== version) {
      throw httpError(409, "This bill changed while you were working on it. Reload it first");
    }
    if (bill.status !== "draft" || bill.bill_type !== "invoice") {
      throw httpError(409, "Credit can only be asked for on a draft bill");
    }
    const net = toPaise(bill.net_amount);
    if (!net) throw httpError(409, "Add medicines to the bill before asking for credit");
    const wanted = toPaise(amount);
    assertWithinLimit(await creditRoom(client, bill.patient_id, billId), wanted);
    if (wanted > net) {
      throw httpError(400, `Credit cannot be more than the bill total of ₹${toRupees(net)}`);
    }
    const { rows: open } = await client.query(
      `SELECT status FROM pharmacy_credit_requests
        WHERE bill_id = $1 AND status IN ('pending', 'approved')`,
      [billId],
    );
    if (open.length) {
      throw httpError(409, `This bill already has a credit request that is ${open[0].status}`);
    }
    const { rows } = await client.query(
      `INSERT INTO pharmacy_credit_requests
         (bill_id, patient_id, bill_amount, amount, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [billId, bill.patient_id, bill.net_amount, toRupees(wanted), reason, ctx.actorId ?? null],
    );
    await bumpBill(client, billId, ctx);
    const { rows: who } = await client.query(`SELECT name FROM patients WHERE id = $1`, [
      bill.patient_id,
    ]);
    await raiseNotification(client, {
      kind: "credit_request",
      severity: "warning",
      capability: CAP.PHARMACY_CREDIT_APPROVE,
      title: `Credit asked: ${toRupeeText(wanted)} for ${who[0]?.name ?? "a patient"}`,
      body: reason,
      link: "/pharmacy/credit",
      entityType: ENTITY,
      entityId: rows[0].id,
      dedupeKey: `pharmacy:credit:${rows[0].id}`,
    });
    await audit(client, ctx, rows[0].id, "create", null, {
      bill_id: billId,
      bill_amount: bill.net_amount,
      amount: rows[0].amount,
      reason,
    });
    return getBill(billId, client);
  }, db);
}

export async function withdrawCredit(id, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { request, bill } = await lockRequest(client, id);
    if (!["pending", "approved"].includes(request.status)) {
      throw httpError(409, `This credit request is already ${request.status}`);
    }
    if (bill.status !== "draft") {
      throw httpError(
        409,
        "The bill is already finalised, so its credit can no longer be withdrawn",
      );
    }
    await client.query(
      `UPDATE pharmacy_credit_requests SET status = 'withdrawn', approved_amount = NULL
        WHERE id = $1`,
      [id],
    );
    await bumpBill(client, bill.id, ctx);
    await resolveNotifications(client, `pharmacy:credit:${id}`);
    await audit(client, ctx, id, "cancel", { status: request.status }, { status: "withdrawn" });
    return getBill(bill.id, client);
  }, db);
}

export async function decideCredit(id, input, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { request, bill } = await lockRequest(client, id);
    if (request.status !== "pending") {
      throw httpError(409, `This credit request is already ${request.status}`);
    }
    if (request.requested_by && request.requested_by === ctx.actorId) {
      throw httpError(403, "Someone else must approve or reject a credit request you raised");
    }
    if (bill.status !== "draft") throw httpError(409, "The bill is no longer a draft");
    const approve = input.decision === "approve";
    const approved = approve ? toPaise(input.approved_amount ?? request.amount) : null;
    if (approve && (approved <= 0 || approved > toPaise(request.amount))) {
      throw httpError(
        400,
        `The approved credit must be more than 0 and at most the ₹${toRupees(toPaise(request.amount))} asked for`,
      );
    }
    if (approve)
      assertWithinLimit(await creditRoom(client, request.patient_id, request.bill_id), approved);
    const { rows } = await client.query(
      `UPDATE pharmacy_credit_requests
          SET status = $2, approved_amount = $3, decision_note = $4, decided_by = $5,
              decided_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        id,
        approve ? "approved" : "rejected",
        approve ? toRupees(approved) : null,
        input.note ?? null,
        ctx.actorId ?? null,
      ],
    );
    await bumpBill(client, bill.id, ctx);
    await resolveNotifications(client, `pharmacy:credit:${id}`);
    if (request.requested_by) {
      await raiseNotification(client, {
        kind: "credit_decided",
        severity: approve ? "info" : "warning",
        doctorId: request.requested_by,
        title: approve ? `Credit approved: ${toRupeeText(approved)}` : "Credit refused",
        body: input.note ?? null,
        link: `/pharmacy/billing/${bill.id}`,
        entityType: ENTITY,
        entityId: id,
      });
    }
    await audit(
      client,
      ctx,
      id,
      approve ? "approve" : "reject",
      { status: "pending" },
      {
        status: rows[0].status,
        approved_amount: rows[0].approved_amount,
        note: rows[0].decision_note,
      },
    );
    return rows[0];
  }, db);
}

export async function listCreditRequests(
  { status = "pending", limit = 50, offset = 0 } = {},
  db = pool,
) {
  const params = [limit, offset];
  const where = status === "all" ? "TRUE" : "r.status = $3";
  if (status !== "all") params.push(status);
  const { rows } = await db.query(
    `SELECT r.id, r.bill_id, r.status, r.amount, r.approved_amount, r.bill_amount, r.reason,
            r.decision_note, r.requested_at, r.decided_at, r.requested_by,
            (SELECT name FROM doctors d WHERE d.id = r.requested_by) AS requested_by_name,
            (SELECT name FROM doctors d WHERE d.id = r.decided_by) AS decided_by_name,
            p.id AS patient_id, p.name AS patient_name, p.file_no AS patient_file_no,
            p.phone AS patient_phone, ${PATIENT_DUE_SQL("p.id")} AS patient_due,
            b.sale_type, b.ipd_number, b.status AS bill_status, b.bill_no,
            count(*) OVER()::int AS total
       FROM pharmacy_credit_requests r
       JOIN patients p ON p.id = r.patient_id
       JOIN pharmacy_bills b ON b.id = r.bill_id
      WHERE ${where}
      ORDER BY (r.status = 'pending') DESC, r.requested_at DESC
      LIMIT $1 OFFSET $2`,
    params,
  );
  return { rows: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
}

export async function listDues({ q, limit = 50, offset = 0 } = {}, db = pool) {
  const params = [limit, offset, today()];
  let search = "";
  if (q) {
    params.push(`%${q.toLowerCase()}%`);
    search = `AND (lower(p.name) LIKE $4 OR lower(COALESCE(p.file_no, '')) LIKE $4
                   OR lower(COALESCE(b.bill_no, '')) LIKE $4 OR COALESCE(p.phone, '') LIKE $4)`;
  }
  const { rows } = await db.query(
    `WITH due AS (
       SELECT b.id, b.bill_no, b.bill_date, b.net_amount, b.paid_amount, b.sale_type,
              b.ipd_number, b.version, ${DUE_SQL} AS due_amount,
              p.id AS patient_id, p.name AS patient_name, p.file_no AS patient_file_no,
              p.phone AS patient_phone
         FROM pharmacy_bills b
         JOIN patients p ON p.id = b.patient_id
        WHERE b.bill_type = 'invoice' AND b.status = 'final' AND b.pay_later
          AND b.paid_amount < b.net_amount ${search}
     )
     SELECT *, ($3::date - bill_date) AS age_days, count(*) OVER()::int AS total,
            SUM(due_amount) OVER() AS total_due
       FROM due WHERE due_amount > 0
      ORDER BY bill_date, bill_no
      LIMIT $1 OFFSET $2`,
    params,
  );
  return {
    rows: rows.map(({ total, total_due, ...r }) => r),
    total: rows[0]?.total ?? 0,
    total_due: rows[0]?.total_due ?? "0.00",
  };
}

export async function collectDue(billId, { version, payments }, ctx = {}, db = pool, options = {}) {
  return inTransaction(async (client) => {
    const bill = await lockBill(client, billId);
    if (bill.bill_type !== "invoice" || bill.status !== "final") {
      throw httpError(409, "Dues are collected on a finalised bill");
    }
    if (bill.version !== version) {
      throw httpError(409, "This bill changed while you were working on it. Reload it first");
    }
    const { rows } = await client.query(
      `SELECT ${DUE_SQL} AS due FROM pharmacy_bills b WHERE b.id = $1`,
      [billId],
    );
    const due = toPaise(rows[0].due);
    if (!due) throw httpError(409, `Nothing is due on bill ${bill.bill_no}`);
    const paid = payments.reduce((sum, p) => sum + toPaise(p.amount), 0);
    if (!paid) throw httpError(400, "Enter the amount being collected");
    if (paid > due) {
      throw httpError(
        409,
        `Only ₹${toRupees(due)} is due on bill ${bill.bill_no}, so ₹${toRupees(paid)} cannot be taken`,
      );
    }
    const receipts = await recordBillPayments(
      client,
      { billId, patientId: bill.patient_id, payments },
      ctx,
      { requireShiftForCash: Boolean(options.requireShiftForCash) },
    );
    await client.query(
      `UPDATE pharmacy_bills
          SET paid_amount = paid_amount + $2, version = version + 1, updated_at = NOW(),
              updated_by = $3
        WHERE id = $1`,
      [billId, toRupees(paid), ctx.actorId ?? null],
    );
    await writeAudit(client, {
      entity: "pharmacy_bills",
      entityId: billId,
      action: "update",
      before: { paid_amount: bill.paid_amount, due: toRupees(due) },
      after: { collected: toRupees(paid), receipts, due: toRupees(due - paid) },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return getBill(billId, client);
  }, db);
}

export async function patientCreditHistory(patientId, db = pool) {
  const { rows: patients } = await db.query(
    `SELECT id, name, file_no, phone FROM patients WHERE id = $1`,
    [patientId],
  );
  if (!patients.length) throw httpError(404, "Patient not found");
  const [{ rows: summary }, { rows: open }, { rows: requests }, { rows: cleared }] =
    await Promise.all([
      db.query(
        `SELECT (SELECT credit_limit FROM pharmacy_settings WHERE id) AS credit_limit,
                ${PATIENT_DUE_SQL("$1::int")} AS due,
                COALESCE((SELECT SUM(r.approved_amount) FROM pharmacy_credit_requests r
                           WHERE r.patient_id = $1 AND r.status = 'approved'), 0)::numeric(12, 2)
                  AS reserved`,
        [patientId],
      ),
      db.query(
        `SELECT * FROM (
           SELECT b.id, b.bill_no, b.bill_date, b.net_amount, b.paid_amount, ${DUE_SQL} AS due_amount,
                  ($2::date - b.bill_date)::int AS age_days
             FROM pharmacy_bills b
            WHERE b.patient_id = $1 AND b.bill_type = 'invoice' AND b.status = 'final'
              AND b.pay_later AND b.paid_amount < b.net_amount
         ) d WHERE due_amount > 0
         ORDER BY bill_date`,
        [patientId, today()],
      ),
      db.query(
        `SELECT r.id, r.status, r.amount, r.approved_amount, r.bill_amount, r.reason,
                r.decision_note, r.requested_at, r.decided_at, b.bill_no, b.id AS bill_id,
                (SELECT name FROM doctors d WHERE d.id = r.requested_by) AS requested_by_name,
                (SELECT name FROM doctors d WHERE d.id = r.decided_by) AS decided_by_name
           FROM pharmacy_credit_requests r
           JOIN pharmacy_bills b ON b.id = r.bill_id
          WHERE r.patient_id = $1
          ORDER BY r.requested_at DESC
          LIMIT 20`,
        [patientId],
      ),
      db.query(
        `SELECT count(*)::int AS bills,
                COALESCE(SUM(b.net_amount - b.paid_amount), 0) AS still_due,
                count(*) FILTER (WHERE b.paid_amount >= b.net_amount)::int AS paid_off
           FROM pharmacy_bills b
          WHERE b.patient_id = $1 AND b.bill_type = 'invoice' AND b.status = 'final'
            AND b.pay_later`,
        [patientId],
      ),
    ]);
  const { credit_limit: limit, due, reserved } = summary[0];
  return {
    patient: patients[0],
    credit_limit: limit,
    due,
    reserved,
    room:
      limit === null
        ? null
        : toRupees(Math.max(toPaise(limit) - toPaise(due) - toPaise(reserved), 0)),
    credit_bills: cleared[0].bills,
    credit_bills_paid_off: cleared[0].paid_off,
    open_bills: open,
    requests,
  };
}
