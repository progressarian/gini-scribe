import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const numbers = await import("../../../server/services/billing/billNumber.js");
const series = await import("../../../server/services/billing/billSeries.js");

const db = getPool();
const ctx = { actorId: USERS.admin.id, ip: "10.4.0.5" };
const failure = (promise) => promise.then(() => null).catch((e) => e);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ids = {};

const FYS = ["2035-36", "2036-37", "2037-38", "2044-45", "2045-46"];

const refused = async (promise, status, message, label) => {
  const error = await failure(promise);
  expect(error?.status, label).toBe(status);
  if (message) expect(error.message, label).toMatch(message);
  return error;
};

const seed = (name, fy, prefix, width, next) =>
  query(
    `INSERT INTO bill_series (series, fy, prefix, number_width, next_no)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (series, fy) DO UPDATE
        SET prefix = $3, number_width = $4, next_no = $5`,
    [name, fy, prefix, width, next],
  );

const nextNo = async (name, fy) =>
  Number(
    (await one(`SELECT next_no FROM bill_series WHERE series = $1 AND fy = $2`, [name, fy]))
      .next_no,
  );

const issue = async (name, date) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await numbers.nextNumber(client, name, date);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const addBill = (billNo, fy) =>
  one(
    `INSERT INTO bills (patient_id, visit_id, status, bill_no, series, fy, finalised_at)
     VALUES ($1, $2, 'final', $3, 'MAIN', $4, NOW())
     RETURNING id`,
    [ids.patient, ids.visit, billNo, fy],
  );

test.describe.serial("P4-05 bill and receipt numbers", () => {
  test.beforeAll(async () => {
    ids.patient = (
      await one(`INSERT INTO patients (name) VALUES ('P405 Patient') RETURNING id`)
    ).id;
    ids.visit = (
      await one(`INSERT INTO giniflow_visits (patient_id) VALUES ($1) RETURNING id`, [ids.patient])
    ).id;
    ids.draft = (
      await one(`INSERT INTO bills (patient_id, visit_id) VALUES ($1, $2) RETURNING id`, [
        ids.patient,
        ids.visit,
      ])
    ).id;
  });

  test.afterAll(async () => {
    await query(
      `DELETE FROM payments WHERE bill_id IN (SELECT id FROM bills WHERE visit_id = $1)`,
      [ids.visit],
    );
    await query(`DELETE FROM bills WHERE visit_id = $1`, [ids.visit]);
    await query(`DELETE FROM giniflow_visits WHERE id = $1`, [ids.visit]);
    await query(`DELETE FROM patients WHERE id = $1`, [ids.patient]);
    await query(`DELETE FROM bill_series WHERE fy = ANY($1)`, [FYS]);
  });

  test("1. the financial year runs April to March", async () => {
    await seed("MAIN", "2035-36", "A/35-36/", 4, 1);
    await seed("MAIN", "2036-37", "B/36-37/", 6, 1);
    const last = await issue("MAIN", "2036-03-31");
    const first = await issue("MAIN", "2036-04-01");
    expect(last).toMatchObject({ series: "MAIN", fy: "2035-36", number: "A/35-36/0001", no: 1 });
    expect(first).toMatchObject({ series: "MAIN", fy: "2036-37", number: "B/36-37/000001" });
    expect(series.financialYear("2036-03-31")).toBe("2035-36");
  });

  test("2. the number takes its shape from the prefix and width, and next_no advances", async () => {
    expect(await nextNo("MAIN", "2035-36")).toBe(2);
    const second = await issue("MAIN", "2035-06-01");
    const third = await issue("MAIN", "2035-12-01");
    expect([second.number, third.number]).toEqual(["A/35-36/0002", "A/35-36/0003"]);
    expect(await nextNo("MAIN", "2035-36")).toBe(4);
    await seed("MAIN", "2035-36", "A/35-36/", 4, 9999);
    expect((await issue("MAIN", "2035-12-01")).number).toBe("A/35-36/9999");
    await refused(issue("MAIN", "2035-12-01"), 409, /used every 4-digit number/);
    await seed("MAIN", "2035-36", "A/35-36/", 4, 4);
  });

  test("3. with no series row for that year it asks the admin to set one", async () => {
    const error = await refused(
      issue("MAIN", "2038-09-01"),
      409,
      /^Ask the admin to set the bill series for 2038-39$/,
    );
    expect(error).toMatchObject({ series: "MAIN", fy: "2038-39" });
    await refused(issue("RCPT", "2038-09-01"), 409, /for 2038-39/);
  });

  test("4. two finalises at the same time get consecutive numbers with no gap", async () => {
    const start = await nextNo("MAIN", "2035-36");
    const a = await db.connect();
    const b = await db.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      const first = await numbers.nextNumber(a, "MAIN", "2035-06-01");
      const waiting = numbers.nextNumber(b, "MAIN", "2035-06-01");
      const settled = waiting.then(() => "through").catch(() => "failed");
      expect(
        await Promise.race([settled, sleep(400).then(() => "waiting")]),
        "the second finalise waits on the locked series row",
      ).toBe("waiting");
      await a.query("COMMIT");
      const second = await waiting;
      await b.query("COMMIT");
      expect(first.no).toBe(start);
      expect(second.no, "consecutive, no gap").toBe(start + 1);
      expect(first.number).not.toBe(second.number);
      expect(await nextNo("MAIN", "2035-36"), "exactly two numbers were used").toBe(start + 2);
    } finally {
      await a.query("ROLLBACK").catch(() => {});
      await b.query("ROLLBACK").catch(() => {});
      a.release();
      b.release();
    }
  });

  test("5. a rolled back finalise does not burn a number", async () => {
    const start = await nextNo("MAIN", "2035-36");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const taken = await numbers.nextNumber(client, "MAIN", "2035-06-01");
      expect(taken.no).toBe(start);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await nextNo("MAIN", "2035-36"), "the number is free again").toBe(start);
    expect((await issue("MAIN", "2035-06-01")).no).toBe(start);
  });

  test("6. receipts are numbered in their own series", async () => {
    await seed("RCPT", "2035-36", "R/35-36/", 3, 1);
    const billNo = await nextNo("MAIN", "2035-36");
    const receipt = await issue("RCPT", "2035-08-01");
    expect(receipt).toMatchObject({ series: "RCPT", fy: "2035-36", number: "R/35-36/001", no: 1 });
    expect(await nextNo("MAIN", "2035-36"), "the bill series is untouched").toBe(billNo);
    expect((await issue("RCPT", "2035-08-01")).number).toBe("R/35-36/002");
    expect((await issue("MAIN", "2035-08-01")).number).toBe(
      `A/35-36/${String(billNo).padStart(4, "0")}`,
    );
  });

  test("7. nextNumber needs the caller's open transaction", async () => {
    const pooled = await failure(numbers.nextNumber(db, "MAIN", "2035-06-01"));
    expect(pooled.message).toMatch(/not the pool/);
    const loose = await db.connect();
    try {
      const outside = await failure(numbers.nextNumber(loose, "MAIN", "2035-06-01"));
      expect(outside.message).toMatch(/BEGIN first/);
    } finally {
      loose.release();
    }
    await refused(issue("MIAN", "2035-06-01"), 400, /must be one of: MAIN, RCPT/);
    await refused(issue("MAIN", "01-06-2035"), 400, /must look like 2026-04-01/);
  });

  test("8. once a bill is numbered, that year's prefix and width are fixed", async () => {
    await seed("MAIN", "2037-38", "C/37-38/", 6, 1);
    const free = await series.saveSeries(
      { series: "MAIN", fy: "2037-38", prefix: "D/37-38/", number_width: 5 },
      ctx,
      db,
    );
    expect(free).toMatchObject({ prefix: "D/37-38/", number_width: 5 });
    const issued = await issue("MAIN", "2037-07-01");
    await addBill(issued.number, "2037-38");
    expect(await series.hasIssuedNumber("MAIN", "2037-38", db)).toBe(true);
    await refused(
      series.saveSeries({ series: "MAIN", fy: "2037-38", prefix: "E/" }, ctx, db),
      409,
      /already been issued for 2037-38, so the prefix can't change/,
    );
    await refused(
      series.saveSeries({ series: "MAIN", fy: "2037-38", number_width: 8 }, ctx, db),
      409,
      /so the number of digits can't change/,
    );
    const raised = await series.saveSeries(
      { series: "MAIN", fy: "2037-38", next_no: 500 },
      ctx,
      db,
    );
    expect(raised, "raising the next number stays allowed").toMatchObject({ next_no: 500 });
    const same = await series.saveSeries(
      { series: "MAIN", fy: "2037-38", prefix: "D/37-38/", next_no: 600 },
      ctx,
      db,
    );
    expect(same, "resending the same prefix is not a change").toMatchObject({
      prefix: "D/37-38/",
      next_no: 600,
    });
  });

  test("9. a receipt locks its own year, and each series is judged on its own", async () => {
    await seed("RCPT", "2037-38", "S/37-38/", 6, 1);
    const widened = await series.saveSeries(
      { series: "RCPT", fy: "2037-38", number_width: 7 },
      ctx,
      db,
    );
    expect(widened, "a bill number does not lock the receipt series").toMatchObject({
      number_width: 7,
    });
    const receipt = await issue("RCPT", "2037-09-10");
    const bill = await addBill(`C/37-38/${receipt.no}`, "2037-38");
    await query(
      `INSERT INTO payments (bill_id, mode, amount, receipt_no, received_at)
       VALUES ($1, 'cash', 1, $2, '2037-09-10 11:00+05:30')`,
      [bill.id, receipt.number],
    );
    expect(await series.hasIssuedNumber("RCPT", "2037-38", db)).toBe(true);
    expect(
      await series.hasIssuedNumber("RCPT", "2036-37", db),
      "a September receipt belongs to the year that started that April",
    ).toBe(false);
    await refused(
      series.saveSeries({ series: "RCPT", fy: "2037-38", prefix: "T/" }, ctx, db),
      409,
      /RCPT numbers have already been issued for 2037-38/,
    );
    const raised = await series.saveSeries(
      { series: "RCPT", fy: "2037-38", next_no: 900 },
      ctx,
      db,
    );
    expect(raised).toMatchObject({ next_no: 900 });
  });

  test("10. from 1 March the list warns that next year's series is missing", async () => {
    await seed("MAIN", "2044-45", "M/44-45/", 6, 1);
    await seed("RCPT", "2044-45", "R/44-45/", 6, 1);
    await seed("MAIN", "2045-46", "M/45-46/", 6, 1);
    const on = (today) =>
      series.listSeries(db, today).then((list) => list.filter((s) => s.fy === "2044-45"));
    const flags = (list) => Object.fromEntries(list.map((s) => [s.series, s.next_fy_missing]));
    expect(flags(await on("2045-02-28")), "no warning before March").toEqual({
      MAIN: false,
      RCPT: false,
    });
    expect(flags(await on("2045-03-01")), "RCPT 2045-46 is missing").toEqual({
      MAIN: false,
      RCPT: true,
    });
    expect(flags(await on("2045-03-31"))).toEqual({ MAIN: false, RCPT: true });
    const row = (await on("2045-03-01")).find((s) => s.series === "RCPT");
    expect(row.next_fy).toBe("2045-46");
    await seed("RCPT", "2045-46", "R/45-46/", 6, 1);
    expect(flags(await on("2045-03-01")), "the warning clears once it is set").toEqual({
      MAIN: false,
      RCPT: false,
    });
    const other = (await series.listSeries(db, "2045-03-01")).find((s) => s.fy === "2036-37");
    expect(other.next_fy_missing, "only the current year is warned about").toBe(false);
  });
});
