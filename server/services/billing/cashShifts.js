import pool from "../../config/db.js";
import { writeAudit } from "./audit.js";
import { httpError, inTransaction } from "./transaction.js";
import {
  auditFields,
  cleanDate,
  cleanMoney,
  CLOSED_BY_TEST_CANCEL,
  hasField,
  INT_MAX,
  MONEY_MAX,
  readNumber,
} from "./common.js";
import { CAPABILITIES, hasAnyCapability } from "../../../shared/permissions.js";
import { paise } from "../../../shared/labPayment.js";
import { HEALTHRAY_MODE, NEFT_MODE, PREPAID_MODE } from "../../../shared/billingVocab.js";
import { clearedInWindow } from "./clearedMoney.js";

export const PAYMENT_MODES = ["cash", "card", "upi"];
export const TAKE_MODES = [...PAYMENT_MODES, NEFT_MODE];
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
    TAKE_MODES.map(
      (mode) =>
        `COALESCE(SUM(p.amount) FILTER (WHERE p.direction = '${direction}' AND p.mode = '${mode}'), 0) AS ${mode}_${flow}`,
    ),
  )
  .join(",\n           ");

const TOTAL_COLUMNS = Object.keys(FLOWS)
  .flatMap((flow) => TAKE_MODES.map((mode) => `t.${mode}_${flow}`))
  .join(", ");

const DRAWER_SQL = `
  SELECT s.opening_cash
         + COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'in'), 0)
         - COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'out'), 0) AS cash
    FROM cash_shifts s
    LEFT JOIN payments p ON p.shift_id = s.id AND p.mode = $2 AND p.voided_at IS NULL
   WHERE s.id = $1
   GROUP BY s.opening_cash`;

const PHARMACY_DRAWER_SQL = `
  SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS cash
    FROM pharmacy_payments WHERE shift_id = $1 AND mode = $2`;

const HEALTHRAY_CASH = `h.mode = '${HEALTHRAY_MODE}' AND h.paid_via = '${DRAWER_MODE}' AND h.voided_at IS NULL`;

const HEALTHRAY_DRAWER_SQL = `
  SELECT COALESCE(SUM(CASE WHEN h.direction = 'in' THEN h.amount ELSE -h.amount END), 0) AS cash
    FROM cash_shifts s
    JOIN payments h ON h.received_by = s.user_id AND ${HEALTHRAY_CASH}
                   AND h.received_at >= s.opened_at
                   AND h.received_at <= COALESCE(s.closed_at, NOW())
   WHERE s.id = $1`;

async function drawerCash(client, shiftId) {
  const [hospital, pharmacy, healthray] = await Promise.all([
    client.query(DRAWER_SQL, [shiftId, DRAWER_MODE]),
    client.query(PHARMACY_DRAWER_SQL, [shiftId, DRAWER_MODE]),
    client.query(HEALTHRAY_DRAWER_SQL, [shiftId]),
  ]);
  return (
    (paise(hospital.rows[0].cash) + paise(pharmacy.rows[0].cash) + paise(healthray.rows[0].cash)) /
    100
  );
}

export async function shiftHoldingPayment(client, payment) {
  const { rows } = await client.query(
    `SELECT id FROM cash_shifts
      WHERE user_id = $1 AND opened_at <= $2 AND (closed_at IS NULL OR closed_at >= $2)
      ORDER BY opened_at DESC LIMIT 1`,
    [payment.received_by, payment.received_at],
  );
  return rows[0]?.id ?? null;
}

export const SHIFT_SQL = `
  SELECT s.id, s.user_id, s.opened_at, s.closed_at, s.opening_cash, s.expected_cash,
         s.counted_cash, s.difference, s.note, s.updated_by, s.handover, s.denominations,
         s.not_counted,
         u.name AS user_name, u.short_name AS user_short_name,
         ${TOTAL_COLUMNS},
         t.payment_count, t.bill_count, t.refund_count, t.credit_note_count,
         t.deposits_received, t.deposits_refunded, t.deposit_count,
         hr.healthray_collected, hr.healthray_refunded, hr.prepaid_collected,
         hr.healthray_cash_in, hr.healthray_cash_out,
         ph.pharmacy_collected, ph.pharmacy_refunded, ph.pharmacy_cash_in, ph.pharmacy_cash_out,
         ph.pharmacy_count
    FROM cash_shifts s
    LEFT JOIN doctors u ON u.id = s.user_id
    LEFT JOIN LATERAL (
      SELECT ${TOTALS},
             COUNT(*) FILTER (WHERE p.direction = 'in' AND p.bill_id IS NOT NULL) AS payment_count,
             COUNT(*) FILTER (WHERE p.direction = 'in' AND p.bill_id IS NULL) AS deposit_count,
             COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'in' AND p.bill_id IS NULL), 0)
               AS deposits_received,
             COALESCE(SUM(p.amount) FILTER (WHERE p.direction = 'out' AND p.bill_id IS NULL), 0)
               AS deposits_refunded,
             COUNT(DISTINCT p.bill_id) FILTER (WHERE p.direction = 'in') AS bill_count,
             COUNT(*) FILTER (WHERE p.direction = 'out') AS refund_count,
             COUNT(DISTINCT p.bill_id) FILTER (WHERE p.direction = 'out') AS credit_note_count
        FROM payments p
       WHERE p.shift_id = s.id AND p.voided_at IS NULL
    ) t ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(h.amount) FILTER (WHERE h.mode = '${HEALTHRAY_MODE}'
                                                AND h.direction = 'in'), 0) AS healthray_collected,
             COALESCE(SUM(h.amount) FILTER (WHERE h.mode = '${HEALTHRAY_MODE}'
                                                AND h.direction = 'out'), 0) AS healthray_refunded,
             COALESCE(SUM(h.amount) FILTER (WHERE h.mode = '${PREPAID_MODE}'
                                                AND h.direction = 'in'), 0) AS prepaid_collected,
             COALESCE(SUM(h.amount) FILTER (WHERE ${HEALTHRAY_CASH}
                                                AND h.direction = 'in'), 0) AS healthray_cash_in,
             COALESCE(SUM(h.amount) FILTER (WHERE ${HEALTHRAY_CASH}
                                                AND h.direction = 'out'), 0) AS healthray_cash_out
        FROM payments h
       WHERE h.mode IN ('${HEALTHRAY_MODE}', '${PREPAID_MODE}') AND h.received_by = s.user_id
         AND h.received_at >= s.opened_at AND h.received_at <= COALESCE(s.closed_at, NOW())
    ) hr ON TRUE
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(pp.amount) FILTER (WHERE pp.direction = 'in'), 0) AS pharmacy_collected,
             COALESCE(SUM(pp.amount) FILTER (WHERE pp.direction = 'out'), 0) AS pharmacy_refunded,
             COALESCE(SUM(pp.amount) FILTER (WHERE pp.direction = 'in' AND pp.mode = '${DRAWER_MODE}'), 0)
               AS pharmacy_cash_in,
             COALESCE(SUM(pp.amount) FILTER (WHERE pp.direction = 'out' AND pp.mode = '${DRAWER_MODE}'), 0)
               AS pharmacy_cash_out,
             COUNT(*) FILTER (WHERE pp.direction = 'in') AS pharmacy_count
        FROM pharmacy_payments pp
       WHERE pp.shift_id = s.id
    ) ph ON TRUE`;

const IST_DAY = `(s.opened_at AT TIME ZONE 'Asia/Kolkata')::date`;

function flowOf(row, flow) {
  const byMode = Object.fromEntries(
    TAKE_MODES.map((mode) => [mode, money(row[`${mode}_${flow}`])]),
  );
  const total = TAKE_MODES.reduce((sum, mode) => sum + paise(byMode[mode]), 0);
  return { ...byMode, total: total / 100 };
}

const drawerOf = (openingCash, collected, refunded) =>
  (paise(openingCash) + paise(collected[DRAWER_MODE]) - paise(refunded[DRAWER_MODE])) / 100;

export function shape(row) {
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
    deposits: {
      count: Number(row.deposit_count ?? 0),
      received: money(row.deposits_received),
      refunded: money(row.deposits_refunded),
    },
    healthray: {
      collected: money(row.healthray_collected),
      refunded: money(row.healthray_refunded),
      cash_collected: money(row.healthray_cash_in),
      cash_refunded: money(row.healthray_cash_out),
    },
    prepaid: { collected: money(row.prepaid_collected) },
    pharmacy: {
      count: Number(row.pharmacy_count ?? 0),
      collected: money(row.pharmacy_collected),
      refunded: money(row.pharmacy_refunded),
      cash_collected: money(row.pharmacy_cash_in),
      cash_refunded: money(row.pharmacy_cash_out),
    },
    expected_cash: isOpen
      ? (paise(drawerOf(openingCash, collected, refunded)) +
          paise(row.pharmacy_cash_in) -
          paise(row.pharmacy_cash_out) +
          paise(row.healthray_cash_in) -
          paise(row.healthray_cash_out)) /
        100
      : money(row.expected_cash),
    counted_cash: row.counted_cash === null ? null : money(row.counted_cash),
    difference: row.difference === null ? null : money(row.difference),
    note: row.note ?? null,
    closed_by: isOpen ? null : (row.updated_by ?? null),
    not_counted: Boolean(row.not_counted),
    handover: row.handover ?? null,
    denominations: row.denominations ?? null,
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
  return { id: rows[0].id, cash: paise(await drawerCash(client, rows[0].id)) };
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

const IST_TODAY = `(NOW() AT TIME ZONE 'Asia/Kolkata')::date`;

async function closeSkippedToday(db, shiftId) {
  const { rows } = await db.query(
    `SELECT EXISTS (
       SELECT 1 FROM billing_audit
        WHERE entity = 'cash_shifts' AND entity_id = $1
          AND after->>'close_skipped_on' = ${IST_TODAY}::text) AS skipped`,
    [shiftId],
  );
  return rows[0].skipped;
}

export async function currentShift(ctx, db = pool) {
  const userId = actorOf(ctx, "see your shift");
  const { rows } = await db.query(`${SHIFT_SQL} WHERE s.user_id = $1 AND s.closed_at IS NULL`, [
    userId,
  ]);
  if (!rows.length) return null;
  const shift = shape(rows[0]);
  return { ...shift, close_skipped_today: await closeSkippedToday(db, shift.id) };
}

export async function skipEarlierClose(ctx, db = pool) {
  const userId = actorOf(ctx, "carry on without closing your shift");
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, opened_at, ${IST_TODAY}::text AS today,
              (opened_at AT TIME ZONE 'Asia/Kolkata')::date < ${IST_TODAY} AS earlier
         FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL FOR UPDATE`,
      [userId],
    );
    if (!rows.length) throw httpError(409, "No shift is open for this desk");
    const open = rows[0];
    if (!open.earlier) {
      throw httpError(409, "Your shift was opened today, so there is no earlier shift to close");
    }
    if (!(await closeSkippedToday(client, open.id))) {
      await writeAudit(client, {
        entity: "cash_shifts",
        entityId: open.id,
        action: "update",
        after: { close_skipped_on: open.today, opened_at: open.opened_at },
        ...auditFields(ctx),
      });
    }
    return currentShift(ctx, client);
  }, db);
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
  const expected = money(await drawerCash(client, id));
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

export async function refreshClosedDrawer(client, shiftId, ctx) {
  const { rows } = await client.query(
    `SELECT closed_at, counted_cash FROM cash_shifts WHERE id = $1 FOR UPDATE`,
    [shiftId],
  );
  if (!rows[0]?.closed_at) return null;
  const before = await readShift(client, shiftId);
  const expected = await expectedCashFor(client, shiftId);
  await client.query(
    `UPDATE cash_shifts SET expected_cash = $2, difference = $3, updated_at = NOW(), updated_by = $4
      WHERE id = $1`,
    [
      shiftId,
      expected,
      rows[0].counted_cash === null ? null : money(Number(rows[0].counted_cash) - expected),
      ctx?.actorId ?? null,
    ],
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
}

export const NOTES = [500, 200, 100, 50, 20, 10];
const NOTE_COUNT_MAX = 100000;

function cleanDenominations(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "The note count must list how many of each note");
  }
  const notes = {};
  let total = 0;
  for (const note of NOTES) {
    const raw = value[String(note)];
    if (raw === undefined || raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > NOTE_COUNT_MAX) {
      throw httpError(400, `Enter a whole number of ₹${note} notes`);
    }
    if (n) notes[String(note)] = n;
    total += n * note * 100;
  }
  const coins =
    value.coins === undefined || value.coins === null || value.coins === ""
      ? 0
      : paise(cleanMoney(value.coins, "The coins"));
  total += coins;
  if (!total) return null;
  return { notes, coins, total };
}

async function handoverOf(client, shiftId, closedAt) {
  const shift = await readShift(client, shiftId);
  const { rows } = await client.query(
    `SELECT COUNT(DISTINCT COALESCE(b.patient_id, m.deposit_patient_id)) AS patients
       FROM payments m
       LEFT JOIN bills b ON b.id = m.bill_id
      WHERE m.shift_id = $1 AND m.voided_at IS NULL AND m.direction = 'in'`,
    [shiftId],
  );
  const finalised = await client.query(
    `SELECT COUNT(*) AS n FROM bills b
      WHERE b.finalised_by = $1 AND b.bill_type = 'invoice' AND b.finalised_at BETWEEN $2 AND $3
        AND NOT ${CLOSED_BY_TEST_CANCEL("b")}`,
    [shift.user.id, shift.opened_at, closedAt],
  );
  const cleared = await clearedInWindow(client, shift.user.id, shift.opened_at, closedAt);
  const inPaise = (flow) =>
    Object.fromEntries(Object.entries(flow).map(([key, value]) => [key, paise(value)]));
  return {
    unit: "paise",
    opening_cash: paise(shift.opening_cash),
    collected: inPaise(shift.collected),
    refunded: inPaise(shift.refunded),
    deposits: {
      count: shift.deposits.count,
      received: paise(shift.deposits.received),
      refunded: paise(shift.deposits.refunded),
    },
    healthray: inPaise(shift.healthray),
    prepaid: inPaise(shift.prepaid),
    pharmacy: {
      count: shift.pharmacy.count,
      collected: paise(shift.pharmacy.collected),
      refunded: paise(shift.pharmacy.refunded),
      cash_collected: paise(shift.pharmacy.cash_collected),
      cash_refunded: paise(shift.pharmacy.cash_refunded),
    },
    cleared,
    payment_count: shift.payment_count,
    refund_count: shift.refund_count,
    bill_count: shift.bill_count,
    bills_finalised: Number(finalised.rows[0].n),
    patients: Number(rows[0].patients),
  };
}

export async function closeShift(id, input = {}, ctx, db = pool) {
  const shiftId = cleanUuid(id, "shift");
  const actorId = actorOf(ctx, "close a shift");
  const notCounted = input.not_counted === true;
  if (notCounted && !closesAnyDesk(ctx)) {
    throw httpError(403, "Only an admin can close a shift without counting the cash");
  }
  const denominations = notCounted ? null : cleanDenominations(input.denominations);
  const countedCash = notCounted
    ? null
    : denominations && (input.counted_cash === undefined || input.counted_cash === null)
      ? denominations.total / 100
      : cleanMoney(input.counted_cash, "The counted cash");
  if (denominations && paise(countedCash) !== denominations.total) {
    throw httpError(
      400,
      `The note count comes to ₹${(denominations.total / 100).toFixed(2)}, but the counted cash is ₹${Number(countedCash).toFixed(2)} — correct one of them`,
    );
  }
  const note = cleanNote(input.note);
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, user_id, opened_at, closed_at, opening_cash, GREATEST(NOW(), opened_at) AS now
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
    const handover = await handoverOf(client, shiftId, current.now);
    const snapshot = {
      ...handover,
      expected_cash: paise(expected),
      counted_cash: countedCash === null ? null : paise(countedCash),
      difference: countedCash === null ? null : paise(countedCash) - paise(expected),
      not_counted: notCounted,
      closed_by: actorId,
      closed_by_owner: actorId === current.user_id,
    };
    await client.query(
      `UPDATE cash_shifts
          SET closed_at = $8,
              expected_cash = $2,
              counted_cash = $3,
              difference = $4,
              note = $5,
              not_counted = $7,
              handover = $9,
              denominations = $10,
              updated_at = NOW(),
              updated_by = $6
        WHERE id = $1`,
      [
        shiftId,
        expected,
        countedCash,
        countedCash === null ? null : money(countedCash - expected),
        note,
        actorId,
        notCounted,
        current.now,
        snapshot,
        denominations,
      ],
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
