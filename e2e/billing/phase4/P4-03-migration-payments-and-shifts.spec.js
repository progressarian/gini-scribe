import { test, expect } from "@playwright/test";
import {
  AUDIT_COLUMNS,
  HAS_COMMENTS,
  REFUSED,
  SEEDS_ROWS,
  allowedValuesOf,
  columnsOf,
  indexesOf,
  lockdownOf,
  openFreshCopy,
  readMigration,
  tablesCreatedBy,
} from "../../helpers/migration.mjs";

const SQL = readMigration("2026-10-17_billing_bills.sql");
const PAYMENTS = "payments";
const SHIFTS = "cash_shifts";

const PAYMENT_COLUMNS = [
  "id",
  "bill_id",
  "direction",
  "mode",
  "amount",
  "reference",
  "received_by",
  "received_at",
  "shift_id",
  "receipt_no",
  ...AUDIT_COLUMNS,
];

const SHIFT_COLUMNS = [
  "id",
  "user_id",
  "opened_at",
  "closed_at",
  "opening_cash",
  "expected_cash",
  "counted_cash",
  "difference",
  "note",
  ...AUDIT_COLUMNS,
];

let db = null;
const ids = {};

const addPayment = `INSERT INTO payments (bill_id, direction, mode, amount, reference, shift_id, receipt_no)
  VALUES ($1, COALESCE($2, 'in'), COALESCE($3, 'cash'), COALESCE($4::numeric, 100), $5, $6, $7)`;

const payment = (o = {}) => [
  o.bill ?? ids.bill,
  o.direction ?? null,
  o.mode ?? null,
  o.amount ?? null,
  o.reference ?? null,
  o.shift ?? ids.shift,
  o.receipt ?? null,
];

const addShift = `INSERT INTO cash_shifts
  (user_id, opened_at, closed_at, opening_cash, expected_cash, counted_cash, difference, note)
  VALUES ($1, COALESCE($2::timestamptz, NOW()), $3, COALESCE($4::numeric, 0),
          $5::numeric, $6::numeric, $7::numeric, $8)`;

const shift = (o = {}) => [
  o.user ?? ids.doctor,
  o.openedAt ?? null,
  o.closedAt ?? null,
  o.opening ?? null,
  o.expected ?? null,
  o.counted ?? null,
  o.difference ?? null,
  o.note ?? null,
];

test.describe.serial("P4-03 migration: payments and cash shifts", () => {
  test.beforeAll(async () => {
    db = await openFreshCopy(SQL);
    const { client } = db;
    const one = async (sql, params = []) => (await client.query(sql, params)).rows[0];
    ids.patient = (
      await one(`INSERT INTO patients (name) VALUES ('P403 Patient') RETURNING id`)
    ).id;
    ids.visit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [ids.patient])
    ).id;
    ids.bill = (
      await one(
        `INSERT INTO bills (patient_id, visit_id, actual_amount, patient_payable, status, bill_no,
                            series, fy, finalised_at)
         VALUES ($1, $2, 700, 700, 'final', 'P403/000001', 'MAIN', '2026-27', NOW()) RETURNING id`,
        [ids.patient, ids.visit],
      )
    ).id;
    ids.doctor = (
      await one(`INSERT INTO doctors (name, role) VALUES ('P403 Desk', 'reception') RETURNING id`)
    ).id;
    ids.otherDoctor = (
      await one(`INSERT INTO doctors (name, role) VALUES ('P403 Desk 2', 'reception') RETURNING id`)
    ).id;
    ids.shift = (
      await one(`INSERT INTO cash_shifts (user_id, opening_cash) VALUES ($1, 2000) RETURNING id`, [
        ids.doctor,
      ])
    ).id;
  });

  test.afterAll(async () => {
    await db?.close();
  });

  test("1. the file creates both tables, inserts no rows and has no comments", () => {
    expect(tablesCreatedBy(SQL)).toEqual(expect.arrayContaining([PAYMENTS, SHIFTS]));
    expect(SQL).not.toMatch(SEEDS_ROWS);
    expect(SQL).not.toMatch(HAS_COMMENTS);
  });

  test("2. it runs twice and both tables have exactly the planned columns", async () => {
    expect(await columnsOf(db.client, PAYMENTS)).toEqual([...PAYMENT_COLUMNS].sort());
    expect(await columnsOf(db.client, SHIFTS)).toEqual([...SHIFT_COLUMNS].sort());
  });

  test("3. receipt numbers are unique, a desk has one open shift, and the lookups are indexed", async () => {
    const indexes = await indexesOf(db.client, [PAYMENTS, SHIFTS]);
    expect(indexes.payments_receipt_no_key).toMatch(
      /UNIQUE INDEX .*\(receipt_no\) WHERE \(receipt_no IS NOT NULL\)/,
    );
    expect(indexes.cash_shifts_open_per_user_key).toMatch(
      /UNIQUE INDEX .*\(user_id\) WHERE \(closed_at IS NULL\)/,
    );
    expect(indexes.payments_bill_idx).toMatch(/\(bill_id\)/);
    expect(indexes.payments_shift_idx).toMatch(/\(shift_id\) WHERE \(shift_id IS NOT NULL\)/);
  });

  test("4. RLS is on and forced, and anon/authenticated have no access", async () => {
    const { rls, publicGrants } = await lockdownOf(db.client, [PAYMENTS, SHIFTS]);
    expect(rls.sort((a, b) => a.relname.localeCompare(b.relname))).toEqual([
      { relname: SHIFTS, relrowsecurity: true, relforcerowsecurity: true },
      { relname: PAYMENTS, relrowsecurity: true, relforcerowsecurity: true },
    ]);
    expect(publicGrants).toEqual([]);
  });

  test("5. no payments are seeded", async () => {
    expect((await db.client.query(`SELECT count(*)::int AS n FROM ${PAYMENTS}`)).rows[0].n).toBe(0);
  });

  test("6. the desk takes cash, card and UPI, and money only comes in", async () => {
    expect(await allowedValuesOf(db.client, PAYMENTS, "mode")).toEqual(["card", "cash", "upi"]);
    expect(await allowedValuesOf(db.client, PAYMENTS, "direction")).toEqual(["in"]);
  });

  test("7. a payment saves with its receipt, and the rules hold", async () => {
    const { refused } = db;
    const { rows } = await db.client.query(
      `${addPayment} RETURNING direction, mode, amount, received_at IS NOT NULL AS stamped`,
      payment({ receipt: "RCPT/26-27/000001", amount: 700 }),
    );
    expect(rows[0]).toEqual({ direction: "in", mode: "cash", amount: "700.00", stamped: true });

    for (const mode of ["card", "upi"]) {
      expect(
        await refused(addPayment, payment({ mode, reference: "TXN123", receipt: `R-${mode}` })),
        mode,
      ).toBeNull();
    }
    expect(
      await refused(addPayment, payment({ receipt: null })),
      "a payment not yet receipted",
    ).toBeNull();

    const bad = [
      ["a refund", { direction: "out" }],
      ["an unknown mode", { mode: "cheque" }],
      ["a payment of nothing", { amount: 0 }],
      ["a payment of less than nothing", { amount: -100 }],
      ["a blank receipt number", { receipt: " " }],
      ["a card payment with no approval reference", { mode: "card", receipt: "R-card-2" }],
      ["a UPI payment with a blank reference", { mode: "upi", reference: " ", receipt: "R-upi-2" }],
    ];
    for (const [why, o] of bad)
      expect(await refused(addPayment, payment(o)), why).toBe(REFUSED.rule);

    expect(
      await refused(addPayment, payment({ receipt: "RCPT/26-27/000001" })),
      "the same receipt number twice",
    ).toBe(REFUSED.duplicate);
    expect(
      await refused(addPayment, payment({ bill: "00000000-0000-0000-0000-000000000001" })),
      "a payment against no bill",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(addPayment, payment({ shift: "00000000-0000-0000-0000-000000000002" })),
      "a payment in a shift that doesn't exist",
    ).toBe(REFUSED.missingParent);
    expect(
      await refused(`INSERT INTO payments (bill_id, mode) VALUES ($1, 'cash')`, [ids.bill]),
      "a payment of no amount at all",
    ).toBe("23502");
  });

  test("8. a shift opens once per desk and only closes with a counted drawer", async () => {
    const { refused } = db;
    expect(await refused(addShift, shift()), "a second open shift for the same desk").toBe(
      REFUSED.duplicate,
    );
    expect(
      await refused(addShift, shift({ user: ids.otherDoctor, opening: 1500 })),
      "another desk opening its own shift",
    ).toBeNull();

    const closed = {
      user: ids.otherDoctor,
      closedAt: "2026-09-23T20:00:00Z",
      openedAt: "2026-09-23T08:00:00Z",
      opening: 2000,
      expected: 9500,
      counted: 9300,
      difference: -200,
    };
    const bad = [
      ["a closed shift with nothing counted", { ...closed, counted: null, difference: null }],
      ["a closed shift with no expected total", { ...closed, expected: null, difference: null }],
      ["a difference that isn't the shortfall", { ...closed, difference: -100 }],
      ["a count on an open shift", { user: ids.doctor, counted: 9300 }],
      ["a shift closed before it opened", { ...closed, closedAt: "2026-09-23T07:00:00Z" }],
      ["a negative opening float", { user: ids.doctor, opening: -100 }],
      ["a negative count", { ...closed, counted: -1, difference: -9501 }],
    ];
    for (const [why, o] of bad) expect(await refused(addShift, shift(o)), why).toBe(REFUSED.rule);

    expect(await refused(addShift, shift(closed)), "a shift that balances to the paisa").toBeNull();
    expect(
      await refused(
        addShift,
        shift({ ...closed, expected: 9500, counted: 9500, difference: 0, note: "Clean day" }),
      ),
      "a drawer that tallies",
    ).toBeNull();
    expect(await refused(addShift, shift({ user: 0 })), "a desk that doesn't exist").toBe(
      REFUSED.missingParent,
    );
  });

  test("8a. a bill can't be banked for more than it comes to", async () => {
    const { refused } = db;
    expect(
      await refused(`UPDATE bills SET paid_amount = 700.01 WHERE id = $1`, [ids.bill]),
      "a paisa more than the patient owes",
    ).toBe(REFUSED.rule);
    expect(
      await refused(`UPDATE bills SET paid_amount = 700 WHERE id = $1`, [ids.bill]),
      "the bill paid in full",
    ).toBeNull();
    expect(
      await refused(`UPDATE bills SET paid_amount = 300 WHERE id = $1`, [ids.bill]),
      "a part payment left as a due",
    ).toBeNull();
  });

  test("9. a bill, shift or desk with money against it can't be deleted", async () => {
    const { refused } = db;
    expect(await refused(`DELETE FROM bills WHERE id = $1`, [ids.bill])).toBe(REFUSED.stillUsed);
    expect(await refused(`DELETE FROM cash_shifts WHERE id = $1`, [ids.shift])).toBe(
      REFUSED.stillUsed,
    );
    expect(await refused(`DELETE FROM doctors WHERE id = $1`, [ids.doctor])).toBe(
      REFUSED.stillUsed,
    );
  });
});
