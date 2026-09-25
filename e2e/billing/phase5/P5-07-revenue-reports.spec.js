import { test, expect } from "@playwright/test";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
import { extraVisit, newTag } from "../phase4/p4-bills-fixture.mjs";
import {
  backdate,
  billRowsOfMine,
  db,
  linesOfMine,
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

const tag = newTag();
let ids;

const MONEY = [
  "invoiced",
  "credited",
  "actual",
  "discount",
  "tax",
  "patient",
  "claim",
  "adjustment",
];

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

const sign = (line) => (line.bill_type === "credit_note" ? -1 : 1);

function expectedFrom(lines, keep = () => true) {
  const picked = lines.filter((line) => line.status === "final" && keep(line));
  const net = (field) => picked.reduce((t, l) => t + sign(l) * paiseOf(l[field]), 0);
  return {
    lines: picked.length,
    quantity: picked.reduce((t, l) => t + sign(l) * Number(l.quantity), 0),
    invoiced: picked
      .filter((l) => l.bill_type === "invoice")
      .reduce((t, l) => t + paiseOf(l.actual_amount), 0),
    credited: picked
      .filter((l) => l.bill_type === "credit_note")
      .reduce((t, l) => t + paiseOf(l.actual_amount), 0),
    actual: net("actual_amount"),
    discount: net("discount"),
    tax: net("cgst") + net("sgst"),
    patient: net("patient_payable"),
    claim: net("claim_amount"),
    adjustment: net("adjustment_amount"),
  };
}

const run = (key, extra = {}) =>
  reports.runReport(key, { from: ids.privateDay, to: ids.privateDay, ...extra }, db);

function expectLeavesAddUp(part, keys) {
  const deepest = Math.max(...part.rows.map((row) => row.depth));
  const leaves = part.rows.filter((row) => row.depth === deepest);
  for (const key of keys) expect(sum(leaves, key), key).toBe(part.total[key]);
  for (const [index, row] of part.rows.entries()) {
    if (row.depth === deepest) continue;
    const children = [];
    for (const next of part.rows.slice(index + 1)) {
      if (next.depth <= row.depth) break;
      if (next.depth === row.depth + 1) children.push(next);
    }
    for (const key of keys) expect(sum(children, key), `${row.label} ${key}`).toBe(row[key]);
  }
}

test.describe.serial("P5-07 revenue reports", () => {
  test.beforeAll(async () => {
    test.setTimeout(SEED_WAIT_MS + 60000);
    ids = await seedReports(tag);
    const { visit } = await extraVisit(ids, "RepDraft");
    const draft = await bills.openDraft(visit, mine, db);
    await bills.addLine(draft.id, { item_id: ids.brace }, mine, db);
    await bills.setCategory(draft.id, { category: ids.pensioner }, mine, db);
    await backdate(ids, ids.privateDay, [draft.id]);
    ids.draft = draft.id;
  });

  test.afterAll(async () => {
    await unseed(ids);
  });

  test("1. by group › subgroup › item: every total is the sum of its lines, net of credit notes", async () => {
    const [part] = (await run("revenue_items")).sections;
    const lines = await linesOfMine(ids);
    expect(part.total).toMatchObject(expectedFrom(lines));
    expectLeavesAddUp(part, ["lines", "quantity", ...MONEY]);
    expect(part.rows.map((row) => row.level)).toEqual([
      "group",
      "subgroup",
      "item",
      "item",
      "item",
      "item",
    ]);
    const brace = part.rows.find((row) => row.code === `P4-BR-${tag}`);
    expect(brace).toMatchObject({ invoiced: 240000, credited: 80000, quantity: 2 });
    expect(brace.actual).toBe(brace.invoiced - brace.credited);
    const dressing = part.rows.find((row) => row.code === `P4-DR-${tag}`);
    expect(dressing.quantity).toBe(5);
    const cancelled = lines.filter((line) => line.status === "cancelled");
    expect(cancelled).toHaveLength(1);
    expect(part.total.lines).toBe(lines.filter((line) => line.status === "final").length);
    const drafted = await db.query(`SELECT count(*)::int AS n FROM bill_lines WHERE bill_id = $1`, [
      ids.draft,
    ]);
    expect(drafted.rows[0].n).toBe(1);
  });

  test("2. per day, week and month the periods add up to the same total", async () => {
    const whole = (await run("revenue_items")).sections[0].total;
    const next = privateDay(tag, 1);
    await backdate(ids, next, [ids.bills.cash]);
    try {
      const byDay = (
        await reports.runReport(
          "revenue_items",
          { from: ids.privateDay, to: next, period: "day" },
          db,
        )
      ).sections[0];
      expect(byDay.total).toEqual(whole);
      expectLeavesAddUp(byDay, ["lines", ...MONEY]);
      const days = byDay.rows.filter((row) => row.level === "period");
      expect(days.map((row) => row.period_start)).toEqual([ids.privateDay, next]);
      expect(sum(days, "actual")).toBe(whole.actual);
      for (const period of ["week", "month"]) {
        const part = (
          await reports.runReport("revenue_items", { from: ids.privateDay, to: next, period }, db)
        ).sections[0];
        expect(part.total).toEqual(whole);
        const starts = part.rows.filter((row) => row.level === "period");
        const weekday = new Date(`${starts[0].period_start}T00:00:00Z`).getUTCDay();
        if (period === "week") expect(weekday).toBe(1);
        else expect(starts[0].period_start.slice(8)).toBe("01");
        expect(sum(starts, "actual")).toBe(whole.actual);
      }
    } finally {
      await backdate(ids, ids.privateDay, [ids.bills.cash]);
    }
  });

  test("3. by consultant: the consultants add up to the total, split by what was billed", async () => {
    const [part] = (await run("revenue_consultants")).sections;
    const lines = await linesOfMine(ids);
    const withoutQuantity = ({ quantity: _quantity, ...rest }) => rest;
    expect(part.total).toMatchObject(withoutQuantity(expectedFrom(lines)));
    expectLeavesAddUp(part, ["lines", "consultations", "tests", "other", ...MONEY]);
    const rahul = part.rows.find((row) => row.label === CONSULTANTS.rahul.name);
    const banshali = part.rows.find((row) => row.label === CONSULTANTS.banshali.name);
    expect(rahul).toMatchObject(
      withoutQuantity(expectedFrom(lines, (line) => line.bill_id === ids.bills.claim)),
    );
    expect(rahul.consultations).toBe(rahul.actual);
    expect(banshali.actual + rahul.actual).toBe(part.total.actual);
    for (const row of part.rows) {
      expect(row.consultations + row.tests + row.other).toBe(row.actual);
    }
  });

  test("4. by category › sub-category: actual, collected, to be claimed and adjusted side by side", async () => {
    const [part] = (await run("revenue_categories")).sections;
    const lines = await linesOfMine(ids);
    const rows = (await billRowsOfMine(ids)).filter((bill) => bill.status === "final");
    const paid = await paymentsOfMine(ids);
    expect(part.total).toMatchObject({
      actual: expectedFrom(lines).actual,
      claim: expectedFrom(lines).claim,
      bills: rows.filter((b) => b.bill_type === "invoice").length,
      credit_notes: 1,
      patient: rows.reduce((t, b) => t + sign(b) * paiseOf(b.patient_payable), 0),
      collected: paid
        .filter((p) => rows.some((b) => b.id === p.bill_id))
        .reduce((t, p) => t + (p.direction === "out" ? -1 : 1) * paiseOf(p.amount), 0),
    });
    expectLeavesAddUp(part, [
      "bills",
      "credit_notes",
      "actual",
      "discount",
      "tax",
      "round_off",
      "patient",
      "collected",
      "claim",
      "adjustment",
    ]);
    for (const row of [...part.rows, part.total]) {
      expect(row.patient).toBe(row.patient_lines + row.round_off);
      expect(row.actual - row.discount + row.tax + row.round_off).toBe(
        row.patient + row.claim + row.adjustment,
      );
    }
    const paidSub = part.rows.find((row) => row.code === ids.paid);
    expect(paidSub).toMatchObject({ patient: 30000, claim: 120000, collected: 30000 });
    const collections = (await run("collections")).sections[0].total;
    expect(part.total.collected).toBe(collections.net);
  });
});
