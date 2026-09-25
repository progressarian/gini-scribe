import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { CONSULTANTS, USERS } from "../../fixtures/data.mjs";
import { desk, extraVisit, newTag } from "../phase4/p4-bills-fixture.mjs";
import {
  admin,
  backdate,
  billRowsOfMine,
  db,
  mine,
  paiseOf,
  SEED_WAIT_MS,
  seedReports,
  unseed,
} from "./p5-reports-seed.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const reports = await import("../../../server/services/billing/reports.js");
const bills = await import("../../../server/services/billing/bills.js");
const payments = await import("../../../server/services/billing/payments.js");
const requests = await import("../../../server/services/billing/billingRequests.js");
const { indiaToday } = await import("../../../server/services/billing/categoryResolver.js");

const tag = newTag();
let ids;

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const DAY_MS = 86400000;
const daysAgo = (n) =>
  new Date(Date.parse(`${indiaToday()}T00:00:00Z`) - n * DAY_MS).toISOString().slice(0, 10);

const run = (key, extra = {}) =>
  reports.runReport(key, { from: ids.privateDay, to: ids.privateDay, ...extra }, db);

const section = (result, key) => result.sections.find((part) => part.key === key);

async function pendingClaimOfMine() {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(b.claim_amount - COALESCE(
              (SELECT SUM(c.claim_amount) FROM bills c
                WHERE c.original_bill_id = b.id AND c.status = 'final'), 0)), 0) AS pending
       FROM bills b
      WHERE b.id = ANY($1::uuid[]) AND b.status = 'final' AND b.bill_type = 'invoice'
        AND b.claim_status = 'pending'`,
    [ids.allBills],
  );
  return paiseOf(rows[0].pending);
}

test.describe.serial("P5-10 receivables, coupons, cancellations and requests reports", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 60000);
    ids = await seedReports(tag);
    const { visit } = await extraVisit(ids, "RepH", { doctorId: CONSULTANTS.rahul.id });
    const opened = await bills.openDraft(visit, mine, db);
    await bills.addLine(opened.id, { item_id: ids.consultNew }, mine, db);
    await bills.addLine(opened.id, { item_id: ids.brace }, mine, db);
    await bills.setCategory(opened.id, { category: ids.paid }, mine, db);
    const drafted = await bills.readBill(opened.id, db);
    const taken = await payments.takePayments(
      opened.id,
      {
        version: drafted.version,
        payments: [
          { mode: "upi", amount: drafted.totals.payable / 100, reference: `UPI-${tag}-H` },
        ],
      },
      mine,
      db,
    );
    const final = await bills.finaliseBill(opened.id, { version: taken.version }, mine, db);
    const brace = final.lines.find((line) => line.service_item_id === ids.brace);
    const asked = await requests.createRefundRequest(
      { bill_id: final.id, lines: [{ line_id: brace.id }], reason: "Brace returned" },
      desk,
      db,
    );
    const approved = await requests.approveRequest(asked.id, {}, admin, db);
    ids.requests.push(asked.id);
    ids.claimH = final.id;
    ids.claimNote = approved.credit_note;
    ids.allBills.push(final.id, approved.credit_note.id);
    await backdate(ids, ids.privateDay, [final.id, approved.credit_note.id]);
  });

  test.afterAll(async () => {
    await unseed(ids);
  });

  test("1. CGHS receivables: pending by sub-category and doctor, net of credits, with ageing", async () => {
    const pending = await pendingClaimOfMine();
    expect(ids.claimNote.totals.claim).toBeGreaterThan(0);
    const result = await run("receivables");
    const bySub = section(result, "sub_categories");
    expect(bySub.total).toMatchObject({ bills: 2, amount: pending });
    expect(bySub.rows.map((row) => [row.level, row.label, row.amount])).toEqual([
      ["category", `P4 CGHS ${tag}`, pending],
      ["sub_category", "Paid", pending],
    ]);
    const byDoctor = section(result, "consultants");
    expect(byDoctor.rows).toEqual([
      expect.objectContaining({ label: CONSULTANTS.rahul.name, bills: 2, amount: pending }),
    ]);
    const ageing = section(result, "ageing");
    expect(ageing.rows.map((row) => row.label)).toEqual([
      "0–30 days",
      "31–60 days",
      "61–90 days",
      "Over 90 days",
    ]);
    expect(sum(ageing.rows, "amount")).toBe(pending);
    expect(ageing.rows.at(-1).amount).toBe(pending);

    const claimC = (await billRowsOfMine(ids)).find((bill) => bill.id === ids.bills.claim);
    await backdate(ids, daysAgo(40), [ids.bills.claim]);
    try {
      const recent = await reports.runReport("receivables", { category: ids.parent }, db);
      const buckets = Object.fromEntries(
        section(recent, "ageing").rows.map((row) => [row.label, row.amount]),
      );
      expect(buckets["31–60 days"]).toBe(paiseOf(claimC.claim_amount));
      expect(buckets["Over 90 days"]).toBe(pending - paiseOf(claimC.claim_amount));
      expect(recent.filters.from).toBeNull();
    } finally {
      await backdate(ids, ids.privateDay, [ids.bills.claim]);
    }
  });

  test("2. cleared per month reads the CGHS register's settlements, and a voided one drops out", async () => {
    const claimC = (await billRowsOfMine(ids)).find((bill) => bill.id === ids.bills.claim);
    const before = await pendingClaimOfMine();
    const settlement = (
      await db.query(
        `INSERT INTO claim_settlements (payer_name, received_on, reference, amount, cleared_by)
         VALUES ($1, $2::date, $3, $4, $5) RETURNING id`,
        [`CGHS ${tag}`, ids.privateDay, `UTR-${tag}`, claimC.claim_amount, admin.actorId],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO claim_settlement_bills (settlement_id, bill_id, amount) VALUES ($1, $2, $3)`,
      [settlement, claimC.id, claimC.claim_amount],
    );
    await db.query(
      `UPDATE bills SET claim_status = 'cleared', claim_settlement_id = $2 WHERE id = $1`,
      [claimC.id, settlement],
    );
    const result = await run("receivables");
    const cleared = section(result, "cleared");
    expect(cleared.rows).toEqual([
      expect.objectContaining({
        month_start: `${ids.privateDay.slice(0, 8)}01`,
        settlements: 1,
        bills: 1,
        amount: paiseOf(claimC.claim_amount),
      }),
    ]);
    expect(cleared.total.amount).toBe(paiseOf(claimC.claim_amount));
    expect(section(result, "sub_categories").total.amount).toBe(
      before - paiseOf(claimC.claim_amount),
    );

    await db.query(
      `UPDATE claim_settlements SET voided_at = NOW(), voided_by = $2, void_reason = 'Wrong UTR'
        WHERE id = $1`,
      [settlement, admin.actorId],
    );
    await db.query(`UPDATE claim_settlement_bills SET voided_at = NOW() WHERE settlement_id = $1`, [
      settlement,
    ]);
    const voided = await run("receivables");
    expect(section(voided, "cleared").rows).toEqual([]);
  });

  test("3. coupon usage per code, per day and per doctor, against the limits", async () => {
    const result = await run("coupons");
    const codes = section(result, "codes");
    expect(codes.rows).toEqual([
      expect.objectContaining({ label: ids.code, uses: 2, ever: 2, total_limit: null }),
    ]);
    const days = section(result, "days");
    expect(days.rows).toEqual([
      expect.objectContaining({
        label: ids.code,
        day: ids.privateDay,
        uses: 2,
        day_limit: 5,
        over_limit: false,
      }),
    ]);
    const doctors = section(result, "doctors");
    expect(doctors.rows).toEqual([
      expect.objectContaining({
        label: ids.code,
        doctor: CONSULTANTS.banshali.name,
        uses: 2,
        doctor_day_limit: 3,
        over_limit: false,
      }),
    ]);
    await db.query(`UPDATE discount_rules SET max_uses_per_day = 1 WHERE id = $1`, [ids.codeRule]);
    const over = section(await run("coupons"), "days");
    expect(over.rows[0]).toMatchObject({ uses: 2, day_limit: 1, over_limit: true });
    const rahul = await run("coupons", { consultant: CONSULTANTS.rahul.id });
    expect(section(rahul, "codes").rows).toEqual([]);
  });

  test("4. cancellations list each cancelled bill with its reason, by reason and by user", async () => {
    const result = await run("cancellations");
    const cancelled = (await billRowsOfMine(ids)).find((bill) => bill.status === "cancelled");
    const [row] = section(result, "bills").rows;
    expect(section(result, "bills").rows).toHaveLength(1);
    expect(row).toMatchObject({
      bill_no: cancelled.bill_no,
      cancel_reason: "Billed the wrong patient",
      cancelled_by_name: USERS.reception_admin.name,
      actual: paiseOf(cancelled.actual_amount),
      patient: paiseOf(cancelled.patient_payable),
    });
    for (const key of ["reasons", "users"]) {
      const part = section(result, key);
      expect(part.total).toEqual({ bills: 1, actual: row.actual, patient: row.patient, claim: 0 });
      expect(sum(part.rows, "bills")).toBe(1);
    }
    expect(section(result, "reasons").rows[0].reason).toBe("Billed the wrong patient");
    const other = await run("cancellations", { user: USERS.reception.id });
    expect(section(other, "bills").rows).toEqual([]);
  });

  test("5. desk requests by user, approved against rejected", async () => {
    const result = await run("requests");
    const users = section(result, "users");
    const top = users.rows.filter((row) => row.level === "user");
    expect(
      top.map((row) => [row.label, row.asked, row.pending, row.approved, row.rejected]),
    ).toEqual([
      [USERS.reception.name, 2, 0, 2, 0],
      [USERS.reception_admin.name, 2, 1, 0, 1],
    ]);
    for (const key of ["asked", "pending", "approved", "rejected"]) {
      expect(sum(top, key), key).toBe(users.total[key]);
      expect(sum(section(result, "kinds").rows, key), key).toBe(users.total[key]);
    }
    expect(section(result, "kinds").rows.map((row) => [row.label, row.asked])).toEqual([
      ["new item", 2],
      ["refund", 2],
    ]);
    const mineOnly = await run("requests", { user: USERS.reception_admin.id });
    expect(section(mineOnly, "users").total).toMatchObject({ asked: 2, rejected: 1 });
  });
});
