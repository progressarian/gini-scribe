import pool from "../../config/db.js";
import { writeAudit } from "./audit.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  auditFields,
  cleanDate,
  cleanMoney,
  hasField,
  INT_MAX,
  MONEY_MAX,
  readNumber,
} from "./common.js";
import { CAPABILITIES, hasAnyCapability } from "../../../shared/permissions.js";
import { paise } from "../../../shared/labPayment.js";

export const PAYMENT_MODES = ["cash", "card", "upi"];
export const DRAWER_MODE = "cash";

export const NOTE_MAX = 500;
const LIST_LIMIT = 200;
export const STATUSES = ["open", "closed"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IST_MOMENT = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  dateStyle: "medium",
  timeStyle: "short",
});

const istMoment = (value) => IST_MOMENT.format(value instanceof Date ? value : new Date(value));

function cleanUuid(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(text)) throw httpError(400, `Choose a valid ${label}`);
  return text.toLowerCase();
}

function cleanUserId(value, label = "user") {
  const message = `Choose a valid ${label}`;
  const id = readNumber(value, message);
  if (id === undefined || !Number.isInteger(id) || id <= 0 || id > INT_MAX) {
    throw httpError(400, message);
  }
  return id;
}

function cleanNote(value) {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > NOTE_MAX) {
    throw httpError(400, `The note is too long — keep it under ${NOTE_MAX} letters`);
  }
  return text;
}

function cleanLimit(value) {
  const limit = readNumber(value, "Limit must be a whole number");
  if (limit === undefined) return LIST_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw httpError(400, "Limit must be a whole number");
  return Math.min(limit, LIST_LIMIT);
}

function cleanStatus(value) {
  if (value === undefined || value === null || value === "") return null;
  if (!STATUSES.includes(value)) {
    throw httpError(400, `Status must be one of: ${STATUSES.join(", ")}`);
  }
  return value;
}

const closesAnyDesk = (ctx) => hasAnyCapability(ctx?.role, CAPABILITIES.BILLING_MASTER);

function actorOf(ctx, doing) {
  const id = ctx?.actorId ?? null;
  if (!id) throw httpError(401, `Sign in again to ${doing}`);
  return id;
}

const money = (value) => Number(Number(value ?? 0).toFixed(2));

const FLOWS = { collected: "in", refunded: "out" };

const TOTALS = Object.entries(FLOWS)
  .flatMap(([flow, direction]) =>
    PAYMENT_MODES.map(
      (mode) =>
        `COALESCE(SUM(p.amount) FILTER (WHERE p.direction = '${direction}' AND p.mode = '${mode}'), 0) AS ${mode}_${flow}`,
    ),
  )
  .join(",\n           ");

const TOTAL_COLUMNS = Object.keys(FLOWS)
  .flatMap((flow) => PAYMENT_MODES.map((mode) => `t.${mode}_${flow}`))
  .join(", ");

const DRAWER_SQL = `
  SELECT s.opening_cash
         + COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'in'), 0)
         - COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'out'), 0) AS cash
    FROM cash_shifts s
    LEFT JOIN payments p ON p.shift_id = s.id AND p.mode = $2
   WHERE s.id = $1
   GROUP BY s.opening_cash`;

const SHIFT_SQL = `
  SELECT s.id, s.user_id, s.opened_at, s.closed_at, s.opening_cash, s.expected_cash,
         s.counted_cash, s.difference, s.note, s.updated_by,
         u.name AS user_name, u.short_name AS user_short_name,
         ${TOTAL_COLUMNS},
         t.payment_count, t.bill_count, t.refund_count, t.credit_note_count
    FROM cash_shifts s
    LEFT JOIN doctors u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT ${TOTALS},
             COUNT(*) FILTER (WHERE p.direction = 'in') AS payment_count,
             COUNT(DISTINCT p.bill_id) FILTER (WHERE p.direction = 'in') AS bill_count,
             COUNT(*) FILTER (WHERE p.direction = 'out') AS refund_count,
             COUNT(DISTINCT p.bill_id) FILTER (WHERE p.direction = 'out') AS credit_note_count
        FROM payments p
       WHERE p.shift_id = s.id
    ) t ON TRUE`;

const IST_DAY = `(s.opened_at AT TIME ZONE 'Asia/Kolkata')::date`;

function flowOf(row, flow) {
  const byMode = Object.fromEntries(
    PAYMENT_MODES.map((mode) => [mode, money(row[`${mode}_${flow}`])]),
  );
  const total = PAYMENT_MODES.reduce((sum, mode) => sum + paise(byMode[mode]), 0);
  return { ...byMode, total: total / 100 };
}

const drawerOf = (openingCash, collected, refunded) =>
  (paise(openingCash) + paise(collected[DRAWER_MODE]) - paise(refunded[DRAWER_MODE])) / 100;

function shape(row) {
  if (!row) return null;
  const collected = flowOf(row, "collected");
  const refunded = flowOf(row, "refunded");
  const openingCash = money(row.opening_cash);
  const isOpen = row.closed_at === null;
  return {
    id: row.id,
    user: { id: row.user_id, name: row.user_name ?? null, short_name: row.user_short_name ?? null },
    opened_at: row.opened_at,
    closed_at: row.closed_at,
    is_open: isOpen,
    opening_cash: openingCash,
    collected,
    refunded,
    payment_count: Number(row.payment_count ?? 0),
    bill_count: Number(row.bill_count ?? 0),
    refund_count: Number(row.refund_count ?? 0),
    credit_note_count: Number(row.credit_note_count ?? 0),
    expected_cash: isOpen ? drawerOf(openingCash, collected, refunded) : money(row.expected_cash),
    counted_cash: row.counted_cash === null ? null : money(row.counted_cash),
    difference: row.difference === null ? null : money(row.difference),
    note: row.note ?? null,
    closed_by: isOpen ? null : (row.updated_by ?? null),
  };
}

async function readShift(db, id) {
  const { rows } = await db.query(`${SHIFT_SQL} WHERE s.id = $1`, [id]);
  if (!rows.length) throw httpError(404, "That shift no longer exists");
  return shape(rows[0]);
}

export async function cashOutShift(client, userId) {
  const { rows } = await client.query(
    `SELECT id FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL FOR UPDATE`,
    [cleanUserId(userId)],
  );
  if (!rows.length) return null;
  const drawer = await client.query(DRAWER_SQL, [rows[0].id, DRAWER_MODE]);
  return { id: rows[0].id, cash: paise(drawer.rows[0].cash) };
}

export async function openShiftIdFor(client, userId) {
  const { rows } = await client.query(
    `SELECT id FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL FOR SHARE`,
    [cleanUserId(userId)],
  );
  return rows[0]?.id ?? null;
}

async function alreadyOpenError(client, userId) {
  const { rows } = await client.query(
    `SELECT opened_at FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL`,
    [userId],
  );
  const started = rows[0] ? ` It started on ${istMoment(rows[0].opened_at)}.` : "";
  return httpError(409, `A shift is already open for this desk.${started} Close it first.`);
}

export async function openShift(input = {}, ctx, db = pool) {
  const userId = actorOf(ctx, "open a shift");
  const openingCash =
    hasField(input, "opening_cash") && input.opening_cash !== null && input.opening_cash !== ""
      ? cleanMoney(input.opening_cash, "The opening cash")
      : 0;
  return inTransaction(async (client) => {
    await client.query("SAVEPOINT billing_shift_open");
    let id = null;
    try {
      const { rows } = await client.query(
        `INSERT INTO cash_shifts (user_id, opening_cash, created_by, updated_by)
         VALUES ($1, $2, $3, $3) RETURNING id`,
        [userId, openingCash, ctx?.actorId ?? null],
      );
      id = rows[0].id;
    } catch (error) {
      if (error.code !== "23505") throw error;
      await client.query("ROLLBACK TO SAVEPOINT billing_shift_open");
      throw await alreadyOpenError(client, userId);
    }
    await client.query("RELEASE SAVEPOINT billing_shift_open");
    const shift = await readShift(client, id);
    await writeAudit(client, {
      entity: "cash_shifts",
      entityId: id,
      action: "create",
      after: shift,
      ...auditFields(ctx),
    });
    return shift;
  }, db);
}

export async function getShift(id, db = pool) {
  return readShift(db, cleanUuid(id, "shift"));
}

export async function currentShift(ctx, db = pool) {
  const userId = actorOf(ctx, "see your shift");
  const { rows } = await db.query(`${SHIFT_SQL} WHERE s.user_id = $1 AND s.closed_at IS NULL`, [
    userId,
  ]);
  return rows.length ? shape(rows[0]) : null;
}

export async function listShifts(filters = {}, db = pool) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  if (filters.userId !== undefined && filters.userId !== null && filters.userId !== "") {
    add("s.user_id = ?", cleanUserId(filters.userId));
  }
  const from = cleanDate(filters.from, "The start date");
  const to = cleanDate(filters.to, "The end date");
  if (from && to && from > to) throw httpError(400, "The start date is after the end date");
  if (from) add(`${IST_DAY} >= ?::date`, from);
  if (to) add(`${IST_DAY} <= ?::date`, to);
  const status = cleanStatus(filters.status);
  if (status === "open") where.push("s.closed_at IS NULL");
  if (status === "closed") where.push("s.closed_at IS NOT NULL");
  params.push(cleanLimit(filters.limit));
  const { rows } = await db.query(
    `${SHIFT_SQL}
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY s.opened_at DESC, s.id DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map(shape);
}

export async function listMyShifts(filters = {}, ctx, db = pool) {
  return listShifts({ ...filters, userId: actorOf(ctx, "see your shifts") }, db);
}

async function expectedCashFor(client, id) {
  const { rows } = await client.query(DRAWER_SQL, [id, DRAWER_MODE]);
  const expected = money(rows[0].cash);
  if (expected < 0) {
    throw httpError(
      409,
      `More cash was paid back than this shift's drawer ever held (it comes to ${expected}) — check this shift's refunds before closing it`,
    );
  }
  if (expected > MONEY_MAX) {
    throw httpError(
      409,
      `The expected drawer comes to ${expected}, more than a shift can record (at most ${MONEY_MAX}) — check this shift's cash payments before closing it`,
    );
  }
  return expected;
}

export async function closeShift(id, input = {}, ctx, db = pool) {
  const shiftId = cleanUuid(id, "shift");
  const actorId = actorOf(ctx, "close a shift");
  const countedCash = cleanMoney(input.counted_cash, "The counted cash");
  const note = cleanNote(input.note);
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, opened_at, closed_at, opening_cash
         FROM cash_shifts WHERE id = $1 FOR UPDATE`,
      [shiftId],
    );
    if (!rows.length) throw httpError(404, "That shift no longer exists");
    const current = rows[0];
    if (current.closed_at) {
      throw httpError(409, `That shift was already closed on ${istMoment(current.closed_at)}`);
    }
    if (current.user_id !== actorId && !closesAnyDesk(ctx)) {
      throw httpError(403, "That shift belongs to another desk");
    }
    const before = await readShift(client, shiftId);
    const expected = await expectedCashFor(client, shiftId);
    await client.query(
      `UPDATE cash_shifts
          SET closed_at = GREATEST(NOW(), opened_at),
              expected_cash = $2,
              counted_cash = $3,
              difference = $4,
              note = $5,
              updated_at = NOW(),
              updated_by = $6
        WHERE id = $1`,
      [shiftId, expected, countedCash, money(countedCash - expected), note, actorId],
    );
    const shift = await readShift(client, shiftId);
    await writeAudit(client, {
      entity: "cash_shifts",
      entityId: shiftId,
      action: "update",
      before,
      after: shift,
      ...auditFields(ctx),
    });
    return shift;
  }, db);
}

export async function closeCurrentShift(input = {}, ctx, db = pool) {
  const open = await currentShift(ctx, db);
  if (!open) throw httpError(409, "No shift is open for this desk");
  return closeShift(open.id, input, ctx, db);
}
