import { test, expect } from "@playwright/test";
import { one } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import { CONSULTANTS } from "../../fixtures/data.mjs";
import { desk, newTag, refused, tearDown } from "../phase4/p4-bills-fixture.mjs";
import { refundApproved } from "../phase4b/p4b-refunds.mjs";
import { claimBill, db, pensionerBill, referralBill, scoped, setUpClaims } from "./p5-claims.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const register = await import("../../../server/services/billing/cghsRegister.js");
const bills = await import("../../../server/services/billing/bills.js");

const tag = newTag();
let ids;

const pending = (extra = {}) => register.listPending(scoped(ids, extra), db);
const numbers = (list) => list.rows.map((row) => row.bill_no).sort();

test.describe.serial("P5-02 pending register service", () => {
  test.beforeAll(async () => {
    test.setTimeout(120000);
    ids = await setUpClaims(tag);
    ids.pens = (await pensionerBill(ids)).bill;
    ids.refr = (await referralBill(ids)).bill;
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. both claims are pending, with every column, and total ₹1,050", async () => {
    const list = await pending();
    expect(numbers(list)).toEqual([ids.pens.bill_no, ids.refr.bill_no].sort());
    expect(list.totals).toEqual({ count: 2, amount: 105000 });
    expect(list.truncated).toBe(false);
    const pens = list.rows.find((row) => row.bill_id === ids.pens.id);
    expect(pens).toMatchObject({
      bill_no: ids.pens.bill_no,
      bill_date: ids.day,
      patient_name: `P4 Pens ${tag}`,
      uhid: `F4Pens-${tag}`,
      category: ids.pensioner,
      category_label: `P4 CGHS ${tag} › Pensioner`,
      payer_name: `CGHS ${tag}`,
      doctor_id: CONSULTANTS.banshali.id,
      doctor_name: CONSULTANTS.banshali.name,
      bill_codes: ["CC02"],
      referral_no: null,
      billed_claim: 70000,
      credited: 0,
      claim: 70000,
      days_pending: 0,
      claim_status: "pending",
      settlement: null,
    });
    const refr = list.rows.find((row) => row.bill_id === ids.refr.id);
    expect(refr).toMatchObject({
      category_label: `P4 CGHS ${tag} › Referral`,
      doctor_name: CONSULTANTS.rahul.name,
      bill_codes: ["CC01"],
      referral_no: "XXXX5678",
      claim: 35000,
    });
  });

  test("2. the pending total equals the claim amounts of those bills", async () => {
    const list = await pending();
    const stored = await one(
      `SELECT COALESCE(SUM(claim_amount), 0)::text AS total FROM bills WHERE id = ANY($1::uuid[])`,
      [list.rows.map((row) => row.bill_id)],
    );
    expect(Math.round(Number(stored.total) * 100)).toBe(list.totals.amount);
    const everything = await register.listPending({}, db);
    expect(everything.rows.reduce((sum, row) => sum + row.claim, 0)).toBe(everything.totals.amount);
    expect(everything.totals.count).toBe(everything.rows.length);
  });

  test("3. filters by doctor, sub-category, payer and date narrow the list and its totals", async () => {
    const banshali = await pending({ doctor_id: CONSULTANTS.banshali.id });
    expect(numbers(banshali)).toEqual([ids.pens.bill_no]);
    expect(banshali.totals).toEqual({ count: 1, amount: 70000 });
    const rahul = await pending({ doctor_id: String(CONSULTANTS.rahul.id) });
    expect(rahul.totals).toEqual({ count: 1, amount: 35000 });
    const referral = await pending({ category: ids.referral });
    expect(numbers(referral)).toEqual([ids.refr.bill_no]);
    const nobody = await pending({ payer: `ECHS ${tag}` });
    expect(nobody.totals).toEqual({ count: 0, amount: 0 });
    const before = await pending({ to: "2020-01-01" });
    expect(before.totals.count).toBe(0);
    const today = await pending({ from: ids.day, to: ids.day });
    expect(today.totals.count).toBe(2);
    expect(banshali.options.categories.map((c) => c.value)).toEqual(
      expect.arrayContaining([ids.pensioner, ids.referral]),
    );
    expect(banshali.options.payers.map((p) => p.value)).toContain(`CGHS ${tag}`);
    expect(banshali.options.doctors.map((d) => d.value)).toEqual(
      expect.arrayContaining([CONSULTANTS.banshali.id, CONSULTANTS.rahul.id]),
    );
    await refused(
      pending({ from: "2026-10-05", to: "2026-10-01" }),
      400,
      /on or before/,
      "from>to",
    );
    await refused(pending({ from: "2026-13-01" }), 400, /date like/, "a bad date");
  });

  test("4. a cancelled bill is not listed", async () => {
    const { bill } = await pensionerBill(ids, "Gone");
    expect((await pending()).totals.count).toBe(3);
    await bills.cancelBill(bill.id, { reason: "Wrong patient" }, desk, db);
    const list = await pending();
    expect(list.rows.map((row) => row.bill_id)).not.toContain(bill.id);
    expect(list.totals).toEqual({ count: 2, amount: 105000 });
  });

  test("5. a credit note reduces a pending claim; crediting the whole claim takes it off", async () => {
    const { bill } = await claimBill(ids, "Two", {
      category: ids.pensioner,
      itemId: [ids.fee700, ids.fee350],
    });
    const extra = await pensionerBill(ids, "Whole");
    expect((await pending()).totals).toEqual({ count: 4, amount: 280000 });

    const line = bill.lines.find((l) => l.service_item_id === ids.fee350);
    const part = await refundApproved(bill.id, [{ line_id: line.id }]);
    expect(part.credit_note.totals.claim).toBe(35000);
    const row = (await pending()).rows.find((r) => r.bill_id === bill.id);
    expect(row).toMatchObject({
      billed_claim: 105000,
      credited: 35000,
      claim: 70000,
      bill_codes: ["CC02"],
      claim_status: "pending",
    });

    const whole = await refundApproved(extra.bill.id, "whole");
    expect(whole.credit_note.totals.claim).toBe(70000);
    const list = await pending();
    expect(list.rows.map((r) => r.bill_id)).not.toContain(extra.bill.id);
    expect(list.totals).toEqual({ count: 3, amount: 175000 });
    expect(list.rows.reduce((sum, r) => sum + r.claim, 0)).toBe(list.totals.amount);
  });
});
