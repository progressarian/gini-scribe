import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { desk, extraVisit, newTag } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  backdate,
  db,
  mine,
  paiseOf,
  paymentsOfMine,
  privateDay,
  SEED_WAIT_MS,
  seedReports,
  unseed,
} from "./p5-reports-seed.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reports = await import("../../../server/services/billing/reports.js");
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const requests = await import("../../../server/services/billing/billingRequests.js");

const tag = newTag();
let ids;

const MOVED = ["payments_in", "received", "payments_out", "paid_back", "net"];
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

const run = (key, extra = {}, client = db) =>
  reports.runReport(key, { from: ids.privateDay, to: ids.privateDay, ...extra }, client);

async function moneyOfMine() {
  const paid = await paymentsOfMine(ids);
  const of = (direction) => paid.filter((p) => p.direction === direction);
  return {
    paid,
    received: of("in").reduce((t, p) => t + paiseOf(p.amount), 0),
    paidBack: of("out").reduce((t, p) => t + paiseOf(p.amount), 0),
    ins: of("in").length,
    outs: of("out").length,
  };
}

test.describe.serial("P5-08 collection and dues reports", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 60000);
    ids = await seedReports(tag);
  });

  test.afterAll(async () => {
    await unseed(ids);
  });

  test("1. collections equal the sum of payments: money in less money paid back", async () => {
    const money = await moneyOfMine();
    const result = await run("collections");
    expect(result.sections.map((part) => part.key)).toEqual(["modes", "users", "shifts", "days"]);
    for (const part of result.sections) {
      expect(part.total, part.key).toEqual({
        payments_in: money.ins,
        received: money.received,
        payments_out: money.outs,
        paid_back: money.paidBack,
        net: money.received - money.paidBack,
      });
      for (const key of MOVED)
        expect(sum(part.rows, key), `${part.key} ${key}`).toBe(part.total[key]);
    }
    const modes = Object.fromEntries(result.sections[0].rows.map((row) => [row.label, row]));
    const byMode = (mode, direction) =>
      money.paid
        .filter((p) => p.mode === mode && p.direction === direction)
        .reduce((t, p) => t + paiseOf(p.amount), 0);
    for (const [label, mode] of [
      ["Cash", "cash"],
      ["Card", "card"],
      ["UPI", "upi"],
    ]) {
      expect(modes[label]).toMatchObject({
        received: byMode(mode, "in"),
        paid_back: byMode(mode, "out"),
        net: byMode(mode, "in") - byMode(mode, "out"),
      });
    }
    expect(modes.Card.paid_back).toBeGreaterThan(0);
    const [user] = result.sections[1].rows;
    expect(user.label).toBe(USERS.reception_admin.name);
    const [shift] = result.sections[2].rows;
    expect(shift.label).toBe(USERS.reception_admin.name);
    expect(result.sections[3].rows.map((row) => row.day_text)).toEqual([ids.privateDay]);

    const someoneElse = await run("collections", { user: USERS.reception.id });
    expect(someoneElse.sections[0].total.net).toBe(0);
    const claimOnly = await run("collections", { sub_category: ids.paid });
    expect(claimOnly.sections[0].rows.map((row) => [row.label, row.net])).toEqual([["UPI", 30000]]);
  });

  test("2. a payment belongs to the India day it was taken on", async () => {
    const [cash] = (await moneyOfMine()).paid.filter(
      (p) => p.bill_id === ids.bills.due && p.direction === "in",
    );
    const next = privateDay(tag, 1);
    const at = (day, time) =>
      db.query(
        `UPDATE payments SET received_at = ($2::date + $3::time) AT TIME ZONE 'Asia/Kolkata'
          WHERE id = $1`,
        [cash.id, day, time],
      );
    const net = async (day) =>
      (await reports.runReport("collections", { from: day, to: day }, db)).sections[0].total.net;
    const whole = await net(ids.privateDay);
    try {
      await at(next, "00:10");
      expect(await net(ids.privateDay)).toBe(whole - 30000);
      expect(await net(next)).toBe(30000);
      await at(ids.privateDay, "23:50");
      expect(await net(ids.privateDay)).toBe(whole);
      expect(await net(next)).toBe(0);
    } finally {
      await at(ids.privateDay, "11:15");
    }
  });

  test("3. dues show each pay-later balance after credits and refunds", async () => {
    const { visit } = await extraVisit(ids, "RepG");
    const opened = await bills.openDraft(visit, mine, db);
    await bills.addLine(opened.id, { item_id: ids.brace }, mine, db);
    await bills.addLine(opened.id, { item_id: ids.dressing }, mine, db);
    await bills.setCategory(opened.id, { category: ids.pensioner }, mine, db);
    const drafted = await bills.readBill(opened.id, db);
    const final = await bills.finaliseBill(
      opened.id,
      { version: drafted.version, pay_later: true },
      mine,
      db,
    );
    await payments.takePayments(
      final.id,
      { version: final.version, payments: [{ mode: "cash", amount: 500 }] },
      mine,
      db,
    );
    const dressing = final.lines.find((line) => line.service_item_id === ids.dressing);
    const asked = await requests.createRefundRequest(
      { bill_id: final.id, lines: [{ line_id: dressing.id }], reason: "Dressing not done" },
      desk,
      db,
    );
    const approved = await requests.approveRequest(asked.id, {}, admin, db);
    ids.requests.push(asked.id);
    ids.allBills.push(final.id, approved.credit_note.id);
    await backdate(ids, ids.privateDay, [final.id, approved.credit_note.id]);

    const [part] = (await run("dues")).sections;
    expect(part.rows.map((row) => row.bill_no).sort()).toEqual(
      [final.bill_no, (await bills.readBill(ids.bills.due, db)).bill_no].sort(),
    );
    for (const key of ["payable", "credited", "paid", "refunded", "outstanding"]) {
      expect(sum(part.rows, key), key).toBe(part.total[key]);
    }
    const credited = part.rows.find((row) => row.bill_no === final.bill_no);
    expect(credited).toMatchObject({
      payable: final.totals.payable,
      credited: approved.credit_note.totals.payable,
      paid: 50000,
      refunded: 0,
      outstanding: final.totals.payable - approved.credit_note.totals.payable - 50000,
    });
    for (const row of part.rows) {
      const patient = await db.query(`SELECT patient_id FROM bills WHERE bill_no = $1`, [
        row.bill_no,
      ]);
      const [listed] = await payments.listDues({ patientId: patient.rows[0].patient_id }, db);
      expect(listed.outstanding, row.bill_no).toBe(row.outstanding);
    }
    const none = await run("dues", { from: privateDay(tag, 1), to: privateDay(tag, 1) });
    expect(none.sections[0].rows).toEqual([]);
  });

  test("4. with pay later switched off, balances left while it was on still show, and the report says so", async () => {
    const [before] = (await run("dues")).sections;
    expect(before.rows.length).toBeGreaterThan(0);
    expect(before.note).toBeUndefined();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE billing_settings SET allow_pay_later = FALSE`);
      await client.query(
        `UPDATE patient_schemes SET allow_pay_later = FALSE WHERE allow_pay_later`,
      );
      const [part] = (await run("dues", {}, client)).sections;
      expect(part.rows).toEqual(before.rows);
      expect(part.total).toEqual(before.total);
      expect(part.note).toMatch(/Pay later is off now/);
      const empty = privateDay(tag, 1);
      const [none] = (await run("dues", { from: empty, to: empty }, client)).sections;
      expect(none.rows).toEqual([]);
      expect(none.note).toMatch(/Pay later is off, so no bill can be left with a balance/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    const [part] = (await run("dues")).sections;
    expect(part.rows.length).toBeGreaterThan(0);
  });
});
