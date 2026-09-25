import { test, expect } from "@playwright/test";
import { one, query } from "../../helpers/db.mjs";
import { assertTestDatabase } from "../../setup/guard.mjs";
import {
  desk,
  discountCode,
  newTag,
  payRule,
  refused,
  setUp,
  subCategory,
  tearDown,
} from "../phase4/p4-bills-fixture.mjs";
import {
  askRefund,
  auditActions,
  billRow,
  db,
  draftWith,
  dropShifts,
  finalBill,
  inCash,
  lineFor,
  linesOf,
  openDeskShift,
  paiseOf,
  prepareCategory,
  refundApproved,
} from "./p4b-refunds.mjs";

if (process.env.DATABASE_URL) assertTestDatabase(process.env.DATABASE_URL);
const bills = await import("../../../server/services/billing/bills.js");
const creditNotes = await import("../../../server/services/billing/creditNotes.js");

const tag = newTag();
const PARTS = [
  "actual_amount",
  "discount",
  "listed_discount",
  "payable_discount",
  "bill_discount",
  "taxable",
  "cgst",
  "sgst",
  "patient_payable",
  "claim_amount",
  "adjustment_amount",
];
let ids;

const numberOf = (billNo) => Number(billNo.slice(ids.creditPrefix.length));

test.describe.serial("P4B-03 credit note service", () => {
  test.beforeAll(async () => {
    ids = await setUp(tag);
    await prepareCategory(ids);
    ids.code = `P4BCN${tag.toUpperCase()}`;
    await discountCode(ids, ids.code, { value: 10 });
    ids.claimed = await subCategory(ids, "Claimed", { allow_pay_later: true });
    await payRule(ids, ids.claimed, {
      name: "claimed pays a part",
      patient_pays: "amount",
      patient_value: 100,
    });
    await openDeskShift(0);
  });

  test.afterAll(async () => {
    await tearDown(ids);
    await dropShifts();
  });

  test("1. a whole-bill credit note is final, numbered CN, mirrors the bill and frees its items", async () => {
    const { visit, bill: final } = await finalBill(
      ids,
      "Whole",
      [{ item: ids.dressing, quantity: 2 }, { item: ids.brace }],
      { codes: [ids.code], pay: inCash },
    );
    expect(final.status).toBe("final");
    expect(final.totals.discount).toBeGreaterThan(0);

    const approved = await refundApproved(final.id, "whole");
    expect(approved.status).toBe("approved");
    const note = approved.credit_note;
    expect(note.bill_type).toBe("credit_note");
    expect(note.status).toBe("final");
    expect(note.bill_no.startsWith(ids.creditPrefix)).toBe(true);
    expect(note.original).toMatchObject({ id: final.id, bill_no: final.bill_no });
    for (const key of ["actual", "discount", "tax", "payable", "claim", "adjustment"]) {
      expect(note.totals[key], key).toBe(final.totals[key]);
    }
    expect(note.lines.map((line) => line.credited_line_id).sort()).toEqual(
      final.lines.map((line) => line.id).sort(),
    );
    expect(lineFor(note, ids.dressing).quantity).toBe(2);
    expect(note.refund.due).toBe(final.totals.payable);

    const stored = await billRow(note.id);
    expect(stored).toMatchObject({ status: "final", original_bill_id: final.id });
    const originals = await linesOf(final.id);
    expect(originals.every((line) => line.is_live === false)).toBe(true);
    const noteLines = await linesOf(note.id);
    expect(noteLines.every((line) => line.is_live === false)).toBe(true);

    const invoice = await bills.readBill(final.id, db);
    expect(invoice.status).toBe("final");
    expect(invoice.bill_no).toBe(final.bill_no);
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.version).toBeGreaterThan(final.version);

    const again = await bills.openDraft(visit, desk, db);
    const rebilled = await bills.addLine(again.id, { item_id: ids.brace }, desk, db);
    expect(rebilled.lines.map((line) => line.service_item_id)).toEqual([ids.brace]);

    expect(await auditActions("bills", note.id)).toEqual(["create"]);
    expect(await auditActions("bills", final.id)).toContain("update");
    ids.firstNote = note;
  });

  test("2. part of a line is credited in proportion, never past what is left, and the last part is exact", async () => {
    await query(`UPDATE service_items SET base_price = 333.33 WHERE id = $1`, [ids.dressing]);
    const { bill: final } = await finalBill(ids, "Parts", [{ item: ids.dressing, quantity: 3 }], {
      codes: [ids.code],
      pay: inCash,
    });
    const line = lineFor(final, ids.dressing);
    const [original] = (await linesOf(final.id)).filter((row) => row.id === line.id);

    const first = (await refundApproved(final.id, [{ line_id: line.id, quantity: 1 }])).credit_note;
    expect(first.lines[0].quantity).toBe(1);
    const firstLine = (await linesOf(first.id))[0];
    for (const key of PARTS) {
      const third = paiseOf(original[key]) / 3;
      expect(Math.abs(paiseOf(firstLine[key]) - third), key).toBeLessThanOrEqual(1);
    }
    expect(paiseOf(firstLine.patient_payable)).toBe(
      Math.round(paiseOf(original.patient_payable) / 3),
    );
    expect((await linesOf(final.id))[0].is_live).toBe(true);

    await refused(
      askRefund(final.id, [{ line_id: line.id, quantity: 3 }]),
      409,
      /Only 2 of .* is left to credit/,
      "crediting more than is left",
    );
    const second = (await refundApproved(final.id, [{ line_id: line.id, quantity: 1 }]))
      .credit_note;
    expect((await linesOf(final.id))[0].is_live).toBe(true);
    const third = (await refundApproved(final.id, [{ line_id: line.id }])).credit_note;
    expect(third.lines[0].quantity).toBe(1);
    expect((await linesOf(final.id))[0].is_live).toBe(false);

    const all = await query(
      `SELECT ${PARTS.map((key) => `SUM(${key}) AS ${key}`).join(", ")}, SUM(quantity) AS quantity
         FROM bill_lines WHERE credited_line_id = $1`,
      [line.id],
    );
    for (const key of PARTS) {
      expect(paiseOf(all.rows[0][key]), key).toBe(paiseOf(original[key]));
    }
    expect(Number(all.rows[0].quantity)).toBe(3);

    const notes = await creditNotes.listCreditNotes(final.id, db);
    expect(notes.map((note) => note.id)).toEqual([first.id, second.id, third.id]);
    expect(notes.map((note) => note.totals.round_off)).toEqual([0, 0, final.totals.round_off]);
    expect(notes.reduce((sum, note) => sum + note.totals.payable, 0)).toBe(final.totals.payable);
    expect(numberOf(second.bill_no)).toBe(numberOf(first.bill_no) + 1);
    expect(numberOf(third.bill_no)).toBe(numberOf(second.bill_no) + 1);

    await refused(
      askRefund(final.id, [{ line_id: line.id }]),
      409,
      /already been credited in full/,
      "crediting a line credited in full",
    );
    await query(`UPDATE service_items SET base_price = 500 WHERE id = $1`, [ids.dressing]);
  });

  test("3. a pending claim is reduced by what is credited; a cleared claim can't be credited", async () => {
    const { bill } = await finalBill(ids, "Claim", [{ item: ids.dressing, quantity: 2 }], {
      category: ids.claimed,
      payLater: true,
    });
    expect(bill.claim_status).toBe("pending");
    expect(bill.totals.claim).toBeGreaterThan(0);
    const line = lineFor(bill, ids.dressing);
    const half = (await refundApproved(bill.id, [{ line_id: line.id, quantity: 1 }])).credit_note;
    expect(half.totals.claim).toBe(Math.round(bill.totals.claim / 2));
    expect((await billRow(bill.id)).claim_status).toBe("pending");
    const rest = (await refundApproved(bill.id, [{ line_id: line.id }])).credit_note;
    expect(half.totals.claim + rest.totals.claim).toBe(bill.totals.claim);
    expect((await billRow(bill.id)).claim_status).toBe("none");

    const { bill: cleared } = await finalBill(ids, "Cleared", [{ item: ids.brace }], {
      category: ids.claimed,
      payLater: true,
    });
    await query(
      `WITH s AS (
         INSERT INTO claim_settlements (payer_name, received_on, reference, amount)
         SELECT payer_name, bill_date, 'UTR-' || bill_no, claim_amount FROM bills WHERE id = $1
         RETURNING id)
       UPDATE bills SET claim_status = 'cleared', claim_settlement_id = (SELECT id FROM s)
        WHERE id = $1`,
      [cleared.id],
    );
    const error = await refused(
      askRefund(cleared.id, "whole"),
      409,
      /already been paid by .* went to the payer/,
      "crediting a cleared claim",
    );
    expect(error.code).toBe("claim_cleared");
    await query(
      `UPDATE bills SET claim_status = 'pending', claim_settlement_id = NULL WHERE id = $1`,
      [cleared.id],
    );
  });

  test("4. only a final bill is credited, a line is named once, and the service needs the approval's transaction", async () => {
    const { bill: draft } = await draftWith(ids, "Draft", [{ item: ids.brace }]);
    await refused(askRefund(draft.id, "whole"), 409, /still a draft/, "a draft");
    const { bill: unpaid } = await finalBill(ids, "Cancel", [{ item: ids.brace }], {
      payLater: true,
    });
    await bills.cancelBill(unpaid.id, { reason: "Wrong patient" }, desk, db);
    await refused(askRefund(unpaid.id, "whole"), 409, /was cancelled/, "a cancelled bill");
    await refused(
      askRefund(ids.firstNote.id, "whole"),
      409,
      /That is a credit note/,
      "a credit note",
    );
    const { bill } = await finalBill(ids, "Twice", [{ item: ids.brace }], { payLater: true });
    const line = lineFor(bill, ids.brace);
    await refused(
      askRefund(bill.id, [
        { line_id: line.id, quantity: 1 },
        { line_id: line.id, quantity: 1 },
      ]),
      400,
      /only once/,
      "the same line twice",
    );
    const error = await creditNotes
      .creditNoteIn(db, { billId: bill.id, lines: [{ line_id: line.id, quantity: 1 }] }, desk)
      .then(() => null)
      .catch((e) => e);
    expect(error?.message).toMatch(/approving transaction's client/);
    const count = await one(`SELECT count(*)::int AS n FROM bills WHERE original_bill_id = $1`, [
      bill.id,
    ]);
    expect(count.n).toBe(0);
  });
});
