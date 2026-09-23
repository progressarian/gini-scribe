import crypto from "node:crypto";
import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const svc = await import("../../../server/services/billing/cashShifts.js");

const db = getPool();
const tag = crypto.randomBytes(3).toString("hex");
const desk = { actorId: USERS.reception.id, ip: "10.9.2.1", role: USERS.reception.role };
const otherDesk = { actorId: USERS.coordinator.id, ip: "10.9.2.2", role: USERS.coordinator.role };
const master = {
  actorId: USERS.reception_admin.id,
  ip: "10.9.2.3",
  role: USERS.reception_admin.role,
};
const boss = { actorId: USERS.admin.id, ip: "10.9.2.4", role: USERS.admin.role };
const ids = {};
let receipts = 0;

const failure = (promise) => promise.then(() => null).catch((e) => e);
const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, `${label}: ${error?.message ?? "no refusal"}`).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};

const auditFor = (id) =>
  query(
    `SELECT action, actor_id, ip FROM billing_audit
      WHERE entity = 'cash_shifts' AND entity_id = $1 ORDER BY id`,
    [String(id)],
  ).then((r) => r.rows);

const addPayment = async ({ bill, mode, amount, shift }) => {
  receipts += 1;
  return one(
    `INSERT INTO payments (bill_id, mode, amount, reference, shift_id, receipt_no, received_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      bill,
      mode,
      amount,
      mode === "cash" ? null : `REF-${tag}-${receipts}`,
      shift ?? null,
      `P422-${tag}-${receipts}`,
      USERS.reception.id,
    ],
  ).then((row) => row.id);
};

test.describe.serial("P4-22 shifts and cash closing", () => {
  test.beforeAll(async () => {
    await query(
      `UPDATE cash_shifts
          SET closed_at = NOW(), expected_cash = opening_cash, counted_cash = opening_cash,
              difference = 0
        WHERE closed_at IS NULL AND user_id = ANY($1::int[])`,
      [[USERS.reception.id, USERS.coordinator.id, USERS.admin.id, USERS.reception_admin.id]],
    );
    const onIstDay = async (moment) =>
      (
        await one(
          `INSERT INTO cash_shifts (user_id, opening_cash, opened_at, closed_at,
                                    expected_cash, counted_cash, difference)
           VALUES ($1, 0, ($2::timestamp AT TIME ZONE 'Asia/Kolkata'),
                   ($2::timestamp AT TIME ZONE 'Asia/Kolkata'), 0, 0, 0) RETURNING id`,
          [USERS.admin.id, moment],
        )
      ).id;
    ids.lateShift = await onIstDay("2026-03-10 23:45:00");
    ids.earlyShift = await onIstDay("2026-03-11 00:15:00");
    ids.patient = (
      await one(`INSERT INTO patients (name, file_no, age) VALUES ($1, $2, 52) RETURNING id`, [
        `P422 Patient ${tag}`,
        `F422-${tag}`,
      ])
    ).id;
    ids.visit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [ids.patient])
    ).id;
    ids.otherVisit = (
      await one(
        `INSERT INTO giniflow_visits (patient_id, visit_date) VALUES ($1, CURRENT_DATE - 1) RETURNING id`,
        [ids.patient],
      )
    ).id;
    const bill = async (visit) =>
      (
        await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
          ids.patient,
          visit,
        ])
      ).id;
    ids.bill = await bill(ids.visit);
    ids.otherBill = await bill(ids.otherVisit);
    ids.strayShift = (
      await one(
        `INSERT INTO cash_shifts (user_id, opening_cash, closed_at, expected_cash, counted_cash, difference)
         VALUES ($1, 200, NOW(), 200, 200, 0) RETURNING id`,
        [USERS.admin.id],
      )
    ).id;
  });

  test("1. a shift opens with its opening cash, and the open is audited", async () => {
    const shift = await svc.openShift({ opening_cash: "1000" }, desk, db);
    ids.shift = shift.id;
    expect(shift.user).toMatchObject({ id: USERS.reception.id });
    expect(shift.is_open).toBe(true);
    expect(shift.opening_cash).toBe(1000);
    expect(shift.closed_at).toBeNull();
    expect(shift.counted_cash).toBeNull();
    expect(shift.difference).toBeNull();
    expect(shift.collected).toEqual({ cash: 0, card: 0, upi: 0, total: 0 });
    expect(shift.expected_cash).toBe(1000);
    expect(shift.payment_count).toBe(0);
    expect(shift.bill_count).toBe(0);
    const stored = await one(`SELECT created_by, updated_by FROM cash_shifts WHERE id = $1`, [
      shift.id,
    ]);
    expect(stored).toMatchObject({
      created_by: USERS.reception.id,
      updated_by: USERS.reception.id,
    });
    expect(await auditFor(shift.id)).toEqual([
      { action: "create", actor_id: USERS.reception.id, ip: "10.9.2.1" },
    ]);
  });

  test("2. a second shift for the same desk is refused, naming when the open one started", async () => {
    const error = await refused(
      svc.openShift({ opening_cash: 50 }, desk, db),
      409,
      /already open/i,
      "second open",
    );
    expect(error.message).toMatch(/It started on .*\d{4}/);
    const mine = await query(
      `SELECT id FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL`,
      [USERS.reception.id],
    );
    expect(mine.rows.map((r) => r.id)).toEqual([ids.shift]);
  });

  test("3. the totals count only this shift's payments, mode by mode", async () => {
    await addPayment({ bill: ids.bill, mode: "cash", amount: 500, shift: ids.shift });
    await addPayment({ bill: ids.bill, mode: "cash", amount: 250, shift: ids.shift });
    await addPayment({ bill: ids.otherBill, mode: "card", amount: 300, shift: ids.shift });
    await addPayment({ bill: ids.otherBill, mode: "upi", amount: 200, shift: ids.shift });
    await addPayment({ bill: ids.bill, mode: "cash", amount: 9999, shift: ids.strayShift });
    await addPayment({ bill: ids.bill, mode: "card", amount: 8888, shift: ids.strayShift });
    await addPayment({ bill: ids.bill, mode: "cash", amount: 7777, shift: null });
    await addPayment({ bill: ids.bill, mode: "upi", amount: 6666, shift: null });

    const shift = await svc.getShift(ids.shift, db);
    expect(shift.collected).toEqual({ cash: 750, card: 300, upi: 200, total: 1250 });
    expect(shift.expected_cash).toBe(1750);
    expect(shift.payment_count).toBe(4);
    expect(shift.bill_count).toBe(2);

    const sums = await one(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE mode = 'cash'), 0) AS cash,
              COALESCE(SUM(amount) FILTER (WHERE mode = 'card'), 0) AS card,
              COALESCE(SUM(amount) FILTER (WHERE mode = 'upi'), 0) AS upi
         FROM payments WHERE shift_id = $1`,
      [ids.shift],
    );
    expect(Number(sums.cash)).toBe(shift.collected.cash);
    expect(Number(sums.card)).toBe(shift.collected.card);
    expect(Number(sums.upi)).toBe(shift.collected.upi);
    expect(shift.expected_cash).toBe(shift.opening_cash + Number(sums.cash));
  });

  test("4. another desk's shift is its own, and each desk sees only its own current shift", async () => {
    const other = await svc.openShift({ opening_cash: 500 }, otherDesk, db);
    ids.otherShift = other.id;
    await addPayment({ bill: ids.bill, mode: "cash", amount: 120, shift: ids.otherShift });
    await addPayment({ bill: ids.bill, mode: "card", amount: 80, shift: ids.otherShift });

    const theirs = await svc.getShift(ids.otherShift, db);
    expect(theirs.collected).toEqual({ cash: 120, card: 80, upi: 0, total: 200 });
    expect(theirs.expected_cash).toBe(620);

    const mine = await svc.currentShift(desk, db);
    expect(mine.id).toBe(ids.shift);
    expect(mine.collected.cash).toBe(750);
    expect((await svc.currentShift(otherDesk, db)).id).toBe(ids.otherShift);
    await refused(svc.currentShift({}, db), 401, /Sign in/, "no actor");
  });

  test("5. an admin lists every shift, newest first, and can filter by user and by day", async () => {
    const all = await svc.listShifts({}, db);
    const listed = all.map((s) => s.id);
    expect(listed).toContain(ids.shift);
    expect(listed).toContain(ids.otherShift);
    expect(listed).toContain(ids.strayShift);
    expect(listed.indexOf(ids.otherShift)).toBeLessThan(listed.indexOf(ids.shift));

    const byUser = await svc.listShifts({ userId: USERS.coordinator.id }, db);
    expect(byUser.map((s) => s.id)).toContain(ids.otherShift);
    expect(byUser.map((s) => s.id)).not.toContain(ids.shift);
    expect(byUser.every((s) => s.user.id === USERS.coordinator.id)).toBe(true);

    const today = (await one(`SELECT (NOW() AT TIME ZONE 'Asia/Kolkata')::date::text AS day`)).day;
    const onToday = await svc.listShifts({ from: today, to: today }, db);
    expect(onToday.map((s) => s.id)).toContain(ids.shift);
    const longAgo = await svc.listShifts({ from: "2001-01-01", to: "2001-01-31" }, db);
    expect(longAgo.map((s) => s.id)).not.toContain(ids.shift);

    const day = async (date) =>
      (await svc.listShifts({ userId: USERS.admin.id, from: date, to: date }, db)).map((s) => s.id);
    const tenth = await day("2026-03-10");
    const eleventh = await day("2026-03-11");
    expect(tenth).toContain(ids.lateShift);
    expect(tenth).not.toContain(ids.earlyShift);
    expect(eleventh).toContain(ids.earlyShift);
    expect(eleventh).not.toContain(ids.lateShift);

    const openOnly = await svc.listShifts({ status: "open" }, db);
    expect(openOnly.map((s) => s.id)).toContain(ids.shift);
    expect(openOnly.map((s) => s.id)).not.toContain(ids.strayShift);
    expect(openOnly.every((s) => s.is_open)).toBe(true);
    const closedOnly = await svc.listShifts({ status: "closed" }, db);
    expect(closedOnly.map((s) => s.id)).toContain(ids.strayShift);
    expect(closedOnly.map((s) => s.id)).not.toContain(ids.shift);
    expect(await svc.listShifts({ limit: 1 }, db)).toHaveLength(1);

    await refused(svc.listShifts({ status: "half" }, db), 400, /Status must be/, "status");
    await refused(svc.listShifts({ from: "01-01-2026" }, db), 400, /must be a date/, "from");
    await refused(
      svc.listShifts({ from: "2026-03-02", to: "2026-03-01" }, db),
      400,
      /after the end date/,
      "range",
    );
    await refused(svc.listShifts({ userId: "abc" }, db), 400, /valid user/, "user");
  });

  test("6. closing records the expected drawer, the counted cash and a short difference", async () => {
    const closed = await svc.closeShift(
      ids.shift,
      { counted_cash: 1700, note: "  Two fifty-rupee notes short  " },
      desk,
      db,
    );
    expect(closed.is_open).toBe(false);
    expect(closed.closed_at).not.toBeNull();
    expect(closed.expected_cash).toBe(1750);
    expect(closed.counted_cash).toBe(1700);
    expect(closed.difference).toBe(-50);
    expect(closed.note).toBe("Two fifty-rupee notes short");
    expect(closed.collected).toEqual({ cash: 750, card: 300, upi: 200, total: 1250 });

    const stored = await one(
      `SELECT expected_cash, counted_cash, difference, closed_at, updated_by
         FROM cash_shifts WHERE id = $1`,
      [ids.shift],
    );
    expect(Number(stored.expected_cash)).toBe(1750);
    expect(Number(stored.difference)).toBe(-50);
    expect(stored.updated_by).toBe(USERS.reception.id);
    expect(stored.closed_at).not.toBeNull();
    expect((await auditFor(ids.shift)).map((r) => r.action)).toEqual(["create", "update"]);
    expect(await svc.currentShift(desk, db)).toBeNull();
  });

  test("7. closing twice is refused, and so is closing another desk's shift", async () => {
    await refused(
      svc.closeShift(ids.shift, { counted_cash: 1750 }, desk, db),
      409,
      /already closed/i,
      "close twice",
    );
    await refused(
      svc.closeShift(ids.otherShift, { counted_cash: 620 }, desk, db),
      403,
      /another desk/i,
      "other desk",
    );
    const stored = await one(`SELECT counted_cash FROM cash_shifts WHERE id = $1`, [ids.shift]);
    expect(Number(stored.counted_cash)).toBe(1700);
  });

  test("8. a drawer counted over records a positive difference", async () => {
    const closed = await svc.closeCurrentShift({ counted_cash: 640 }, otherDesk, db);
    expect(closed.id).toBe(ids.otherShift);
    expect(closed.expected_cash).toBe(620);
    expect(closed.difference).toBe(20);
    expect(closed.note).toBeNull();
    await refused(
      svc.closeCurrentShift({ counted_cash: 100 }, otherDesk, db),
      409,
      /No shift is open/i,
      "nothing open",
    );
  });

  test("9. bad input is refused in plain words", async () => {
    await refused(
      svc.openShift({ opening_cash: -1 }, otherDesk, db),
      400,
      /can't be negative/,
      "negative opening cash",
    );
    await refused(
      svc.openShift({ opening_cash: "lots" }, otherDesk, db),
      400,
      /amount in rupees/,
      "opening cash in words",
    );
    await refused(svc.openShift({}, {}, db), 401, /Sign in/, "no actor");
    await refused(
      svc.closeShift(ids.otherShift, {}, otherDesk, db),
      400,
      /counted cash is required/i,
      "missing counted cash",
    );
    await refused(
      svc.closeShift(ids.otherShift, { counted_cash: 100, note: "x".repeat(501) }, otherDesk, db),
      400,
      /note is too long/i,
      "long note",
    );
    await refused(svc.getShift("not-a-shift", db), 400, /valid shift/, "bad id");
    await refused(
      svc.getShift("00000000-0000-0000-0000-000000000000", db),
      404,
      /no longer exists/,
      "missing shift",
    );
    const stillOpen = await svc.openShift({}, otherDesk, db);
    expect(stillOpen.opening_cash).toBe(0);
    ids.emptyShift = stillOpen.id;
  });

  test("10. the payments service can find a desk's open shift", async () => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      expect(await svc.openShiftIdFor(client, USERS.coordinator.id)).toBe(ids.emptyShift);
      expect(await svc.openShiftIdFor(client, USERS.reception.id)).toBeNull();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("11. two Opens at the same moment leave one shift, and the loser is told so", async () => {
    const both = await Promise.allSettled([
      svc.openShift({ opening_cash: 300 }, boss, db),
      svc.openShift({ opening_cash: 400 }, boss, db),
    ]);
    const opened = both.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const rejected = both.filter((r) => r.status === "rejected").map((r) => r.reason);
    expect(opened).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(409);
    expect(rejected[0].message).toMatch(/already open/i);
    ids.bossShift = opened[0].id;
    const mine = await query(
      `SELECT id FROM cash_shifts WHERE user_id = $1 AND closed_at IS NULL`,
      [USERS.admin.id],
    );
    expect(mine.rows.map((r) => r.id)).toEqual([ids.bossShift]);
  });

  test("12. a payment still being written keeps the shift open until it lands", async () => {
    const client = await db.connect();
    let closing;
    try {
      await client.query("BEGIN");
      const shiftId = await svc.openShiftIdFor(client, USERS.admin.id);
      expect(shiftId).toBe(ids.bossShift);
      closing = svc.closeShift(ids.bossShift, { counted_cash: 700 }, boss, db);
      let settled = false;
      closing.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(settled, "the close ran while a payment was still being written").toBe(false);
      receipts += 1;
      await client.query(
        `INSERT INTO payments (bill_id, mode, amount, shift_id, receipt_no, received_by)
         VALUES ($1, 'cash', 400, $2, $3, $4)`,
        [ids.bill, shiftId, `P422-${tag}-${receipts}`, USERS.admin.id],
      );
      await client.query("COMMIT");
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
      await closing?.catch(() => {});
    }
    const closed = await closing;
    expect(closed.collected.cash).toBe(400);
    expect(closed.expected_cash).toBe(700);
    expect(closed.difference).toBe(0);
  });

  test("13. a drawer bigger than a shift can record is refused, and the shift stays open", async () => {
    const huge = await svc.openShift({ opening_cash: 9999999999.99 }, boss, db);
    ids.hugeShift = huge.id;
    await addPayment({ bill: ids.bill, mode: "cash", amount: 100, shift: huge.id });
    await refused(
      svc.closeShift(huge.id, { counted_cash: 100 }, boss, db),
      409,
      /more than a shift can record/i,
      "drawer too large",
    );
    const stored = await one(
      `SELECT closed_at, expected_cash, counted_cash FROM cash_shifts WHERE id = $1`,
      [huge.id],
    );
    expect(stored).toMatchObject({ closed_at: null, expected_cash: null, counted_cash: null });
  });

  test("14. only a billing master closes another desk's shift", async () => {
    await refused(
      svc.closeShift(ids.emptyShift, { counted_cash: 0 }, desk, db),
      403,
      /another desk/i,
      "a desk role",
    );
    await refused(
      svc.closeShift(ids.emptyShift, { counted_cash: 0 }, { ...master, role: null }, db),
      403,
      /another desk/i,
      "no role given",
    );
    const closed = await svc.closeShift(ids.emptyShift, { counted_cash: 0 }, master, db);
    expect(closed.is_open).toBe(false);
    expect(closed.expected_cash).toBe(0);
    expect(closed.difference).toBe(0);
    expect(closed.closed_by).toBe(USERS.reception_admin.id);
    expect(closed.user.id).toBe(USERS.coordinator.id);
  });

  test("15. two Closes at the same moment record one drawer", async () => {
    const shift = await svc.openShift({ opening_cash: 30 }, otherDesk, db);
    ids.lastShift = shift.id;
    const both = await Promise.allSettled([
      svc.closeShift(shift.id, { counted_cash: 30 }, otherDesk, db),
      svc.closeShift(shift.id, { counted_cash: 25 }, otherDesk, db),
    ]);
    const done = both.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const rejected = both.filter((r) => r.status === "rejected").map((r) => r.reason);
    expect(done).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(409);
    expect(rejected[0].message).toMatch(/already closed/i);
    const stored = await one(`SELECT counted_cash FROM cash_shifts WHERE id = $1`, [shift.id]);
    expect(Number(stored.counted_cash)).toBe(done[0].counted_cash);
  });

  test.afterAll(async () => {
    await query(`DELETE FROM payments WHERE receipt_no LIKE $1`, [`P422-${tag}-%`]);
    const shifts = [
      ids.shift,
      ids.otherShift,
      ids.strayShift,
      ids.emptyShift,
      ids.lateShift,
      ids.earlyShift,
      ids.bossShift,
      ids.hugeShift,
      ids.lastShift,
    ].filter(Boolean);
    await query(`DELETE FROM cash_shifts WHERE id = ANY($1::uuid[])`, [shifts]);
    await query(`DELETE FROM bills WHERE visit_id = ANY($1::uuid[])`, [
      [ids.visit, ids.otherVisit],
    ]);
    await query(`DELETE FROM giniflow_visits WHERE id = ANY($1::uuid[])`, [
      [ids.visit, ids.otherVisit],
    ]);
    await query(`DELETE FROM patients WHERE id = $1`, [ids.patient]);
  });
});
