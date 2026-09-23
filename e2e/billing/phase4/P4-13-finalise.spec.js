import { test, expect } from "@playwright/test";
import { getPool, one, query } from "../../helpers/db.mjs";
import { USERS } from "../../fixtures/data.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  discountCode,
  extraVisit,
  labOrder,
  newTag,
  payRule,
  refused,
  setUp,
  tearDown,
} from "./p4-bills-fixture.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const visitLines = await import("../../../server/services/billing/visitLines.js");
const reception = await import("../../../server/services/giniflow/receptionStation.js");
const pricing = await import("../../../server/services/billing/priceBill.js");

const db = getPool();
const tag = newTag();
const CODE = `P4F${tag.toUpperCase()}`;
const LIMITED = `P4L${tag.toUpperCase()}`;
let ids;

const nextNo = () =>
  one(`SELECT next_no FROM bill_series WHERE series = 'MAIN' AND fy = $1`, [ids.fy]).then((r) =>
    Number(r.next_no),
  );

const pay = (billId, amount) =>
  query(`INSERT INTO payments (bill_id, mode, amount, received_by) VALUES ($1, 'cash', $2, $3)`, [
    billId,
    (amount / 100).toFixed(2),
    USERS.reception.id,
  ]);

test.describe.serial("P4-13 finalise", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await payRule(ids, ids.paid, {
      name: "paid consults",
      service_item_id: ids.consultDoctorNew,
      visit_types: ["New", "Follow Up"],
      patient_pays: "amount",
      patient_value: 700,
    });
    await payRule(ids, ids.referral, {
      name: "referral everything",
      patient_pays: "nothing",
    });
    await payRule(ids, ids.pensioner, { name: "pensioner pays", patient_pays: "full" });
    await discountCode(ids, CODE, { kind: "percent", value: 10 });
    ids.limited = await discountCode(ids, LIMITED, { kind: "percent", value: 5 });
  });

  test.afterAll(async () => {
    await tearDown(ids);
  });

  test("1. a whole visit: check in, two tests, an item, a code, a category, a final bill", async () => {
    await reception.markArrived(ids.visit, USERS.reception.id, db);
    const order = await labOrder(ids, [ids.hba1cName, ids.abiName]);
    const raised = await visitLines.linesForOrder(
      ids.visit,
      { labOrderId: order, testNames: [ids.hba1cName, ids.abiName] },
      desk,
      db,
    );
    expect(raised.added).toHaveLength(2);
    const draft = await one(`SELECT id FROM bills WHERE visit_id = $1 AND status = 'draft'`, [
      ids.visit,
    ]);
    ids.bill = draft.id;
    await bills.addLine(ids.bill, { item_id: ids.dressing }, desk, db);
    await bills.addCode(ids.bill, { code: CODE }, desk, db);
    const ready = await bills.setCategory(ids.bill, { category: ids.paid }, desk, db);
    expect(ready.lines).toHaveLength(4);

    const expected = await pricing.priceBill(
      {
        patientId: ids.patient,
        appointmentId: ids.appointment,
        category: ids.paid,
        date: ids.day,
        role: desk.role,
        codes: [CODE],
        lines: ready.lines.map((line) => ({
          item: line.service_item_id,
          quantity: line.quantity,
          doctorId: line.doctor_id,
        })),
      },
      db,
    );
    expect(ready.totals.payable).toBe(expected.totals.payable);
    expect(ready.totals.claim).toBe(expected.totals.claim);

    await pay(ids.bill, ready.totals.payable);
    const number = await nextNo();
    const bill = await bills.finaliseBill(ids.bill, { version: ready.version }, desk, db);
    expect(bill.status).toBe("final");
    expect(bill.bill_no).toBe(`${ids.prefix}${String(number).padStart(6, "0")}`);
    expect(bill.series).toBe("MAIN");
    expect(bill.fy).toBe(ids.fy);
    expect(bill.claim_status).toBe("pending");
    expect(bill.totals.payable).toBe(expected.totals.payable);
    expect(bill.totals.claim).toBe(expected.totals.claim);
    expect(bill.pay_later).toBe(false);

    const stored = await one(
      `SELECT actual_amount, discount_amount, tax_amount, patient_payable, claim_amount,
              adjustment_amount, round_off FROM bills WHERE id = $1`,
      [ids.bill],
    );
    expect(Number(stored.patient_payable) * 100).toBe(expected.totals.payable);
    expect(Number(stored.round_off) * 100).toBe(expected.totals.round_off);
    const sums = await one(
      `SELECT SUM(patient_payable)::numeric AS payable, SUM(claim_amount)::numeric AS claim,
              COUNT(*)::int AS lines FROM bill_lines WHERE bill_id = $1 AND is_live`,
      [ids.bill],
    );
    expect(sums.lines).toBe(4);
    expect(Number(sums.payable) * 100 + expected.totals.round_off).toBe(expected.totals.payable);
    expect(Number(sums.claim) * 100).toBe(expected.totals.claim);
    const steps = await one(
      `SELECT COUNT(*)::int AS count FROM bill_line_discounts d
         JOIN bill_lines l ON l.id = d.bill_line_id WHERE l.bill_id = $1`,
      [ids.bill],
    );
    expect(steps.count).toBeGreaterThan(0);
  });

  test("2. a final bill can't be finalised again", async () => {
    await refused(
      bills.finaliseBill(ids.bill, { version: 99 }, desk, db),
      409,
      /already final/,
      "finalising twice",
    );
  });

  test("3. the version must match, and an empty bill is refused", async () => {
    const { visit } = await extraVisit(ids, "Ver");
    const draft = await bills.openDraft(visit, desk, db);
    await refused(
      bills.finaliseBill(draft.id, { version: draft.version }, desk, db),
      409,
      /no items/,
      "an empty bill",
    );
    const withLine = await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    await refused(
      bills.finaliseBill(draft.id, { version: withLine.version - 1 }, desk, db),
      409,
      /changed while you were working/,
      "a stale version",
    );
    await refused(bills.finaliseBill(draft.id, {}, desk, db), 400, /version/, "no version at all");
    ids.verBill = draft.id;
    ids.verVersion = withLine.version;
  });

  test("4. the category must be settled before the bill is made final", async () => {
    const { patient, visit } = await extraVisit(ids, "Cat");
    await query(`UPDATE patients SET scheme_code = $2 WHERE id = $1`, [patient, ids.parent]);
    const draft = await bills.openDraft(visit, desk, db);
    const withLine = await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    expect(withLine.category).toBeNull();
    const before = await nextNo();
    const refusal = await refused(
      bills.finaliseBill(draft.id, { version: withLine.version }, desk, db),
      409,
      /choose one before this bill can be made final/,
      "an unsettled category",
    );
    expect(refusal.needs_sub_category).toBe(true);
    const after = await one(`SELECT status, bill_no FROM bills WHERE id = $1`, [draft.id]);
    expect(after).toMatchObject({ status: "draft", bill_no: null });
    expect(await nextNo()).toBe(before);
    const chosen = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    await pay(draft.id, chosen.totals.payable);
    const bill = await bills.finaliseBill(draft.id, { version: chosen.version }, desk, db);
    expect(bill.status).toBe("final");
    expect(bill.claim_status).toBe("none");
  });

  test("5. a referral category needs its number and its scan", async () => {
    const { patient, visit } = await extraVisit(ids, "Ref");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const set = await bills.setCategory(draft.id, { category: ids.referral }, desk, db);
    expect(set.totals.payable).toBe(0);
    await refused(
      bills.finaliseBill(draft.id, { version: set.version }, desk, db),
      409,
      /referral number/,
      "a referral bill with no number",
    );
    const numbered = await bills.setCategory(draft.id, { referral_no: "REF-2026-77" }, desk, db);
    await refused(
      bills.finaliseBill(draft.id, { version: numbered.version }, desk, db),
      409,
      /referral letter/,
      "a referral bill with no scan",
    );
    const scan = await one(
      `INSERT INTO documents (patient_id, doc_type, title) VALUES ($1, 'referral', 'Letter')
       RETURNING id`,
      [patient],
    );
    const ready = await bills.setCategory(draft.id, { referral_doc_id: scan.id }, desk, db);
    const bill = await bills.finaliseBill(draft.id, { version: ready.version }, desk, db);
    expect(bill.status).toBe("final");
    expect(bill.totals.payable).toBe(0);
    expect(bill.claim_status).toBe("pending");
    expect(bill.referral_no).toBe("XXXX2677");
    const { count } = await one(`SELECT COUNT(*)::int AS count FROM payments WHERE bill_id = $1`, [
      draft.id,
    ]);
    expect(count).toBe(0);
  });

  test("6. money still owed is refused unless pay later is allowed and chosen", async () => {
    await query(`UPDATE patient_schemes SET allow_pay_later = FALSE WHERE code = $1`, [
      ids.pensioner,
    ]);
    const { visit } = await extraVisit(ids, "Later");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const set = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    expect(set.totals.payable).toBe(50000);
    await refused(
      bills.finaliseBill(draft.id, { version: set.version }, desk, db),
      409,
      /still to be collected/,
      "a bill with nothing paid",
    );
    await refused(
      bills.finaliseBill(draft.id, { version: set.version, pay_later: true }, desk, db),
      409,
      /Pay later isn't allowed/,
      "pay later where it isn't allowed",
    );
    await pay(draft.id, 20000);
    await refused(
      bills.finaliseBill(draft.id, { version: set.version }, desk, db),
      409,
      /₹300.00 is still to be collected/,
      "a part-paid bill",
    );
    await query(`UPDATE patient_schemes SET allow_pay_later = TRUE WHERE code = $1`, [
      ids.pensioner,
    ]);
    const bill = await bills.finaliseBill(
      draft.id,
      { version: set.version, pay_later: true },
      desk,
      db,
    );
    expect(bill.status).toBe("final");
    expect(bill.pay_later).toBe(true);
    await query(`UPDATE patient_schemes SET allow_pay_later = NULL WHERE code = $1`, [
      ids.pensioner,
    ]);
  });

  test("7. a coupon's daily limit is re-checked at finalise, with the rule locked", async () => {
    const { visit: firstVisit } = await extraVisit(ids, "Cap1");
    const first = await bills.openDraft(firstVisit, desk, db);
    await bills.addLine(first.id, { item_id: ids.dressing }, desk, db);
    const coded = await bills.addCode(first.id, { code: LIMITED }, desk, db);
    await pay(first.id, coded.totals.payable);
    await bills.finaliseBill(first.id, { version: coded.version }, desk, db);

    const { visit: secondVisit } = await extraVisit(ids, "Cap2");
    const second = await bills.openDraft(secondVisit, desk, db);
    await bills.addLine(second.id, { item_id: ids.dressing }, desk, db);
    const ready = await bills.addCode(second.id, { code: LIMITED }, desk, db);
    await pay(second.id, ready.totals.payable);
    await query(`UPDATE discount_rules SET max_uses_per_day = 1 WHERE id = $1`, [ids.limited]);
    const refusal = await refused(
      bills.finaliseBill(second.id, { version: ready.version }, desk, db),
      409,
      /Daily limit reached/,
      "a coupon over its daily limit",
    );
    expect(refusal.reason).toBe("daily_limit");
    const after = await one(`SELECT status, bill_no FROM bills WHERE id = $1`, [second.id]);
    expect(after).toMatchObject({ status: "draft", bill_no: null });
    await query(`UPDATE discount_rules SET max_uses_per_day = NULL WHERE id = $1`, [ids.limited]);
    const bill = await bills.finaliseBill(second.id, { version: ready.version }, desk, db);
    expect(bill.status).toBe("final");
  });

  test("8. a bill can't be brought below what has already been taken", async () => {
    const { visit } = await extraVisit(ids, "Taken");
    const draft = await bills.openDraft(visit, desk, db);
    await bills.addLine(draft.id, { item_id: ids.dressing }, desk, db);
    const both = await bills.addLine(draft.id, { item_id: ids.brace }, desk, db);
    const ready = await bills.setCategory(draft.id, { category: ids.pensioner }, desk, db);
    expect(ready.totals.payable).toBe(130000);
    await pay(draft.id, ready.totals.payable);
    const brace = both.lines.find((line) => line.service_item_id === ids.brace);
    await refused(
      bills.removeLine(draft.id, brace.id, { reason: "not taken" }, desk, db),
      409,
      /₹1300.00 has already been taken/,
      "reducing a bill below what was paid",
    );
    const after = await bills.readBill(draft.id, db);
    expect(after.lines).toHaveLength(2);
    expect(after.totals.payable).toBe(130000);
    await pay(draft.id, 100);
    await refused(
      bills.finaliseBill(draft.id, { version: after.version }, desk, db),
      409,
      /₹1301.00 has already been taken/,
      "a bill that was overpaid",
    );
    expect((await one(`SELECT status FROM bills WHERE id = $1`, [draft.id])).status).toBe("draft");
  });

  test("9. the bill numbers run on without a gap, and finalising is audited", async () => {
    const { rows } = await query(
      `SELECT bill_no FROM bills WHERE patient_id IN
         (SELECT id FROM patients WHERE name LIKE $1) AND bill_no IS NOT NULL
        ORDER BY bill_no`,
      [`P4 %${tag}`],
    );
    const numbers = rows.map((r) => Number(r.bill_no.slice(ids.prefix.length)));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(new Set(numbers).size).toBe(numbers.length);
    const audit = await query(
      `SELECT action, actor_id FROM billing_audit WHERE entity = 'bills' AND entity_id = $1
        ORDER BY id`,
      [ids.bill],
    );
    expect(audit.rows.at(-1)).toMatchObject({ action: "update", actor_id: desk.actorId });
  });
});
