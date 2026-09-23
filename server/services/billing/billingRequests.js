import pool from "../../config/db.js";
import { writeAudit } from "./audit.js";
import { createItem } from "./serviceItems.js";
import { httpError, inTransaction } from "./transaction.js";
import { auditFields, cleanName, hasField, INT_MAX, lockRow, readNumber } from "./common.js";
import { publishBillingRequest } from "../giniflow/realtimeBus.js";

const COLUMNS = [
  "id",
  "kind",
  "status",
  "reason",
  "proposed_name",
  "proposed_group",
  "patient_id",
  "visit_id",
  "bill_id",
  "service_item_id",
  "created_item_id",
  "requested_by",
  "requested_at",
  "decided_by",
  "decided_at",
  "decision_note",
];

const SPEC = {
  table: "billing_requests",
  noun: "request",
  columns: COLUMNS.join(", "),
};

export const KINDS = { new_item: "new item", repeat_item: "repeat" };
const PRICE_FIELDS = ["base_price", "price", "rate", "amount", "mrp", "discount"];
export const TEXT_MAX = 1000;
const LIST_LIMIT = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

function cleanOptionalUuid(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return cleanUuid(value, label);
}

function cleanWholeId(value, label) {
  const message = `Choose a valid ${label}`;
  const id = readNumber(value, message);
  if (id === undefined || !Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, message);
  }
  return id;
}

const cleanItemId = (value) => cleanWholeId(value, "item");

function cleanText(value, label, { required }) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw httpError(400, label);
    return null;
  }
  if (text.length > TEXT_MAX) throw httpError(400, `${label} — keep it under ${TEXT_MAX} letters`);
  return text;
}

const cleanReason = (value) =>
  cleanText(value, "Say why this is needed, so the admin can answer", { required: true });

const cleanNote = (value, required) =>
  cleanText(value, "Write a note saying why, so the desk knows", { required });

function refusePrice(input) {
  const named = PRICE_FIELDS.filter((key) => hasField(input, key));
  if (!named.length) return;
  throw httpError(
    400,
    `A request can't carry a price (${named.join(", ")}) — the admin sets the price when the item is created`,
  );
}

function actorOf(ctx, doing) {
  const id = ctx?.actorId ?? null;
  if (!id) throw httpError(401, `Sign in again to ${doing}`);
  return id;
}

const person = (id, name) => (id === null || id === undefined ? null : { id, name });

const shape = (row) =>
  row && {
    id: row.id,
    kind: row.kind,
    status: row.status,
    reason: row.reason,
    proposed_name: row.proposed_name,
    proposed_group: row.proposed_group,
    visit_id: row.visit_id,
    bill_id: row.bill_id,
    bill_no: row.bill_no ?? null,
    patient: row.patient_id
      ? {
          id: row.patient_id,
          name: row.patient_name ?? null,
          file_no: row.patient_file_no ?? null,
          age: row.patient_age ?? null,
        }
      : null,
    item: row.service_item_id
      ? { id: row.service_item_id, code: row.item_code ?? null, name: row.item_name ?? null }
      : null,
    created_item: row.created_item_id
      ? {
          id: row.created_item_id,
          code: row.created_item_code ?? null,
          name: row.created_item_name ?? null,
        }
      : null,
    requested_by: person(row.requested_by, row.requested_by_name ?? null),
    requested_at: row.requested_at,
    decided_by: person(row.decided_by, row.decided_by_name ?? null),
    decided_at: row.decided_at ?? null,
    decision_note: row.decision_note ?? null,
    visit_date: row.visit_date ?? null,
    usable: Boolean(row.usable),
    used_on: row.used_line_id
      ? { line_id: row.used_line_id, bill_id: row.used_bill_id, bill_no: row.used_bill_no ?? null }
      : null,
  };

const LIST_SQL = `
  SELECT ${COLUMNS.map((c) => `r.${c}`).join(", ")},
         p.name AS patient_name, p.file_no AS patient_file_no, p.age AS patient_age,
         i.code AS item_code, i.name AS item_name,
         ci.code AS created_item_code, ci.name AS created_item_name,
         b.bill_no,
         rq.name AS requested_by_name, dq.name AS decided_by_name,
         l.id AS used_line_id, l.bill_id AS used_bill_id, ub.bill_no AS used_bill_no,
         v.visit_date::text AS visit_date,
         (r.status = 'approved' AND l.id IS NULL) AS usable
    FROM billing_requests r
    LEFT JOIN patients p ON p.id = r.patient_id
    LEFT JOIN giniflow_visits v ON v.id = r.visit_id
    LEFT JOIN service_items i ON i.id = r.service_item_id
    LEFT JOIN service_items ci ON ci.id = r.created_item_id
    LEFT JOIN bills b ON b.id = r.bill_id
    LEFT JOIN doctors rq ON rq.id = r.requested_by
    LEFT JOIN doctors dq ON dq.id = r.decided_by
    LEFT JOIN bill_lines l ON l.repeat_request_id = r.id
    LEFT JOIN bills ub ON ub.id = l.bill_id`;

function cleanLimit(value) {
  const limit = readNumber(value, "Limit must be a whole number");
  if (limit === undefined) return LIST_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw httpError(400, "Limit must be a whole number");
  return Math.min(limit, LIST_LIMIT);
}

export const STATUSES = ["pending", "approved", "rejected", "used"];

function cleanStatuses(value) {
  if (value === undefined || value === null || value === "") return null;
  const wanted = Array.isArray(value) ? value : [value];
  const unknown = wanted.filter((s) => !STATUSES.includes(s));
  if (unknown.length) {
    throw httpError(400, `Status must be from: ${STATUSES.join(", ")}`);
  }
  return wanted;
}

export async function listRequests(filters = {}, db = pool) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const statuses = cleanStatuses(filters.status);
  if (statuses) add("r.status = ANY(?)", statuses);
  if (filters.requestedBy !== undefined && filters.requestedBy !== null) {
    add("r.requested_by = ?", cleanWholeId(filters.requestedBy, "user"));
  }
  if (filters.visitId) add("r.visit_id = ?", cleanUuid(filters.visitId, "visit"));
  if (filters.kind) {
    if (!KINDS[filters.kind]) {
      throw httpError(400, `Kind must be one of: ${Object.keys(KINDS).join(", ")}`);
    }
    add("r.kind = ?", filters.kind);
  }
  params.push(cleanLimit(filters.limit));
  const { rows } = await db.query(
    `${LIST_SQL}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY r.requested_at ${filters.newestFirst ? "DESC" : "ASC"}, r.id
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(shape);
}

export async function listPendingRequests(db = pool) {
  return listRequests({ status: "pending" }, db);
}

export async function listMyRequests(filters = {}, ctx, db = pool) {
  return listRequests(
    { ...filters, requestedBy: actorOf(ctx, "see your requests"), newestFirst: true },
    db,
  );
}

export async function announceUsed(requestId, db = pool) {
  if (!requestId || joinedToCaller(db)) return;
  try {
    announce("used", await getRequest(requestId, db), db);
  } catch (e) {
    console.warn("[billing requests] live update not sent:", "used", requestId, e?.message);
  }
}

export async function getRequest(id, db = pool) {
  const { rows } = await db.query(`${LIST_SQL} WHERE r.id = $1`, [cleanUuid(id, "request")]);
  if (!rows.length) throw httpError(404, "That request no longer exists");
  return shape(rows[0]);
}

async function readVisit(client, visitId) {
  const { rows } = await client.query(
    `SELECT id, patient_id FROM giniflow_visits WHERE id = $1 FOR SHARE`,
    [visitId],
  );
  if (!rows.length) throw httpError(404, "That visit no longer exists");
  return rows[0];
}

async function readBill(client, billId, visitId) {
  if (!billId) return null;
  const { rows } = await client.query(
    `SELECT id, visit_id, status, bill_no FROM bills WHERE id = $1 FOR SHARE`,
    [billId],
  );
  if (!rows.length) throw httpError(404, "That bill no longer exists");
  if (visitId && rows[0].visit_id !== visitId) {
    throw httpError(409, "That bill belongs to another visit");
  }
  return rows[0];
}

async function readItem(client, itemId) {
  const { rows } = await client.query(
    `SELECT id, code, name, is_active FROM service_items WHERE id = $1 FOR SHARE`,
    [itemId],
  );
  if (!rows.length) throw httpError(404, "That item doesn't exist");
  return rows[0];
}

export async function liveLineFor(client, { visitId, serviceItemId }) {
  const { rows } = await client.query(
    `SELECT l.id, l.bill_id, l.bill_name, b.bill_no, b.status AS bill_status
       FROM bill_lines l JOIN bills b ON b.id = l.bill_id
      WHERE l.visit_id = $1 AND l.service_item_id = $2 AND l.is_live
      ORDER BY l.created_at, l.id
      LIMIT 1`,
    [visitId, serviceItemId],
  );
  return rows[0] ?? null;
}

export async function repeatApprovalFor(client, { visitId, serviceItemId }) {
  const { rows } = await client.query(
    `SELECT r.id, r.reason, r.decided_at
       FROM billing_requests r
       LEFT JOIN bill_lines l ON l.repeat_request_id = r.id
      WHERE r.kind = 'repeat_item' AND r.status = 'approved'
        AND r.visit_id = $1 AND r.service_item_id = $2 AND l.id IS NULL
      ORDER BY r.decided_at, r.id
      LIMIT 1`,
    [visitId, serviceItemId],
  );
  return rows[0] ?? null;
}

const billLabel = (bill) => (bill?.bill_no ? `bill ${bill.bill_no}` : "this visit's draft bill");

async function insertRequest(client, values, ctx) {
  const keys = Object.keys(values);
  const { rows } = await client.query(
    `INSERT INTO billing_requests (${keys.join(", ")}, created_by, updated_by)
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}, $${keys.length + 1}, $${keys.length + 1})
     RETURNING id`,
    [...keys.map((k) => values[k]), ctx?.actorId ?? null],
  );
  return rows[0].id;
}

async function finishCreate(client, id, ctx) {
  const { rows } = await client.query(`${LIST_SQL} WHERE r.id = $1`, [id]);
  const request = shape(rows[0]);
  await writeAudit(client, {
    entity: SPEC.table,
    entityId: id,
    action: "create",
    after: request,
    ...auditFields(ctx),
  });
  return request;
}

export const requestEvent = (action, request) => ({
  kind: "billing_request",
  action,
  date: request.visit_date ?? null,
  requestId: request.id,
  requestKind: request.kind,
  status: request.status,
  visitId: request.visit_id,
  billId: request.bill_id,
  itemId: request.item?.id ?? null,
  createdItemId: request.created_item?.id ?? null,
});

const joinedToCaller = (db) => typeof db?.release === "function";

function announce(action, request, db) {
  if (joinedToCaller(db)) return;
  try {
    publishBillingRequest(requestEvent(action, request)).catch((e) =>
      console.warn("[billing requests] live update not sent:", action, request?.id, e?.message),
    );
  } catch (e) {
    console.warn("[billing requests] live update not sent:", action, request?.id, e?.message);
  }
}

export async function createNewItemRequest(input, ctx, db = pool) {
  refusePrice(input);
  const actorId = actorOf(ctx, "send a request");
  const values = {
    kind: "new_item",
    proposed_name: cleanName(input?.proposed_name),
    proposed_group: cleanText(input?.proposed_group, "Group hint", { required: false }),
    reason: cleanReason(input?.reason),
    visit_id: cleanOptionalUuid(input?.visit_id, "visit"),
    bill_id: cleanOptionalUuid(input?.bill_id, "bill"),
    patient_id: null,
    requested_by: actorId,
  };
  const request = await inTransaction(async (client) => {
    if (values.visit_id) values.patient_id = (await readVisit(client, values.visit_id)).patient_id;
    await readBill(client, values.bill_id, values.visit_id);
    const id = await insertRequest(client, values, ctx);
    return finishCreate(client, id, ctx);
  }, db);
  announce("created", request, db);
  return request;
}

export async function createRepeatRequest(input, ctx, db = pool) {
  refusePrice(input);
  const actorId = actorOf(ctx, "send a request");
  const serviceItemId = cleanItemId(input?.service_item_id);
  const visitId = cleanUuid(input?.visit_id, "visit");
  const billId = cleanOptionalUuid(input?.bill_id, "bill");
  const reason = cleanReason(input?.reason);
  const request = await inTransaction(async (client) => {
    const visit = await readVisit(client, visitId);
    const bill = await readBill(client, billId, visitId);
    const item = await readItem(client, serviceItemId);
    const line = await liveLineFor(client, { visitId, serviceItemId });
    if (!line) {
      throw httpError(
        409,
        `That item isn't on this visit's bill yet, so it doesn't need an approval — add ${item.name} to the bill as usual`,
      );
    }
    const waiting = await client.query(
      `SELECT id FROM billing_requests
        WHERE kind = 'repeat_item' AND status = 'pending'
          AND visit_id = $1 AND service_item_id = $2
        LIMIT 1`,
      [visitId, serviceItemId],
    );
    if (waiting.rows.length) {
      throw httpError(409, `${item.name} is already waiting for an admin's answer on this visit`);
    }
    const approval = await repeatApprovalFor(client, { visitId, serviceItemId });
    if (approval) {
      throw httpError(
        409,
        `An admin has already approved billing ${item.name} again on this visit — add it to the bill`,
      );
    }
    const id = await insertRequest(
      client,
      {
        kind: "repeat_item",
        service_item_id: serviceItemId,
        patient_id: visit.patient_id,
        visit_id: visitId,
        bill_id: bill ? bill.id : line.bill_id,
        reason,
        requested_by: actorId,
      },
      ctx,
    );
    return finishCreate(client, id, ctx);
  }, db);
  announce("created", request, db);
  return request;
}

const DECIDED = { approved: "approved", rejected: "rejected", used: "approved and used" };

function checkPending(before) {
  if (before.status === "pending") return;
  const when = before.decided_at
    ? ` on ${new Date(before.decided_at).toISOString().slice(0, 10)}`
    : "";
  throw httpError(409, `That request was already ${DECIDED[before.status]}${when}`);
}

async function decide(client, id, { status, note, createdItemId = null }, ctx) {
  const { rows } = await client.query(
    `UPDATE billing_requests
        SET status = $2, decision_note = $3, created_item_id = COALESCE($4, created_item_id),
            decided_by = $5, decided_at = NOW(), updated_at = NOW(), updated_by = $5
      WHERE id = $1
      RETURNING id`,
    [id, status, note, createdItemId, ctx?.actorId ?? null],
  );
  if (!rows.length) throw httpError(404, "That request no longer exists");
  const listed = await client.query(`${LIST_SQL} WHERE r.id = $1`, [id]);
  return shape(listed.rows[0]);
}

async function audit(client, { id, action, before, after, ctx }) {
  await writeAudit(client, {
    entity: SPEC.table,
    entityId: id,
    action,
    before,
    after,
    ...auditFields(ctx),
  });
}

export async function approveRequest(id, input, ctx, db = pool) {
  const requestId = cleanUuid(id, "request");
  const actorId = actorOf(ctx, "answer a request");
  const note = cleanNote(input?.note, false);
  const request = await inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, requestId);
    checkPending(before);
    let createdItemId = null;
    if (before.kind === "new_item") {
      const item = await createItem(
        { name: before.proposed_name, ...(input?.item ?? {}) },
        { ...ctx, actorId },
        client,
      );
      createdItemId = item.id;
    } else {
      const line = await liveLineFor(client, {
        visitId: before.visit_id,
        serviceItemId: before.service_item_id,
      });
      if (!line) {
        throw httpError(
          409,
          "That item is no longer on this visit's bill, so there is nothing to bill again",
        );
      }
    }
    const after = await decide(client, requestId, { status: "approved", note, createdItemId }, ctx);
    await audit(client, { id: requestId, action: "approve", before, after, ctx });
    return after;
  }, db);
  announce("approved", request, db);
  return request;
}

export async function rejectRequest(id, input, ctx, db = pool) {
  const requestId = cleanUuid(id, "request");
  actorOf(ctx, "answer a request");
  const note = cleanNote(input?.note, true);
  const request = await inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, requestId);
    checkPending(before);
    const after = await decide(client, requestId, { status: "rejected", note }, ctx);
    await audit(client, { id: requestId, action: "reject", before, after, ctx });
    return after;
  }, db);
  announce("rejected", request, db);
  return request;
}

export async function useRepeatApproval(id, { visitId, serviceItemId }, ctx, db = pool) {
  const requestId = cleanUuid(id, "approval");
  const wantedVisit = cleanUuid(visitId, "visit");
  const wantedItem = cleanItemId(serviceItemId);
  const used = await inTransaction(async (client) => {
    const before = await lockRow(client, SPEC, requestId);
    if (before.kind !== "repeat_item") {
      throw httpError(409, "That approval is for a new item, not for billing an item again");
    }
    if (before.status === "pending") {
      throw httpError(409, "An admin hasn't answered that request yet");
    }
    if (before.status === "rejected") {
      throw httpError(409, "That request was rejected, so the item can't be billed again");
    }
    if (before.status === "used") {
      const line = await client.query(
        `SELECT b.bill_no FROM bill_lines l LEFT JOIN bills b ON b.id = l.bill_id
          WHERE l.repeat_request_id = $1 LIMIT 1`,
        [requestId],
      );
      throw httpError(
        409,
        `That approval has already been used on ${billLabel(line.rows[0])} — one approval allows one extra line`,
      );
    }
    if (before.visit_id !== wantedVisit) {
      throw httpError(409, "That approval was given for another visit");
    }
    if (before.service_item_id !== wantedItem) {
      throw httpError(409, "That approval was given for another item");
    }
    const taken = await client.query(
      `SELECT id FROM bill_lines WHERE repeat_request_id = $1 LIMIT 1`,
      [requestId],
    );
    if (taken.rows.length) {
      throw httpError(
        409,
        "That approval has already been used — one approval allows one extra line",
      );
    }
    const { rowCount } = await client.query(
      `UPDATE billing_requests
          SET status = 'used', updated_at = NOW(), updated_by = $2
        WHERE id = $1 AND status = 'approved'`,
      [requestId, ctx?.actorId ?? null],
    );
    if (!rowCount) {
      throw httpError(
        409,
        "That approval has already been used — one approval allows one extra line",
      );
    }
    const listed = await client.query(`${LIST_SQL} WHERE r.id = $1`, [requestId]);
    const after = shape(listed.rows[0]);
    await audit(client, { id: requestId, action: "update", before, after, ctx });
    return after;
  }, db);
  announce("used", used, db);
  return used;
}
