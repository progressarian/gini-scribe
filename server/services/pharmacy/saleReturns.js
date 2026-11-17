import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { nextNumber } from "../billing/billNumber.js";
import { postMovements } from "./stockLedger.js";
import { shiftForPayments } from "./paymentShift.js";
import { getBill } from "./bills.js";
import { pharmacyBillTotals, pharmacyReturnAmounts } from "../../../shared/pharmacyPricing.js";
import { toPaise, toRupees } from "../../../shared/pharmacyMoney.js";
import { DUE_SQL } from "./billDue.js";
import { PHARMACY_SERIES } from "../../../shared/pharmacyVocab.js";

const ENTITY = "pharmacy_bills";
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export async function returnedUnits(db, billId) {
  const { rows } = await db.query(
    `SELECT cl.credited_line_id AS line_id, SUM(cl.qty_units)::int AS units
       FROM pharmacy_bill_lines cl
       JOIN pharmacy_bills c ON c.id = cl.bill_id
      WHERE c.original_bill_id = $1 AND c.status = 'final'
      GROUP BY cl.credited_line_id`,
    [billId],
  );
  return new Map(rows.map((r) => [r.line_id, r.units]));
}

export async function createSaleReturn(id, input, ctx = {}, db = pool, { dueOnly = false } = {}) {
  return inTransaction(async (client) => {
    const { rows: locked } = await client.query(
      `SELECT * FROM pharmacy_bills WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!locked.length) throw httpError(404, "Pharmacy bill not found");
    const original = locked[0];
    if (original.bill_type !== "invoice" || original.status !== "final") {
      throw httpError(409, "Medicines can only be returned against a finalised bill");
    }
    if (original.version !== input.version) {
      throw httpError(409, "This bill changed while you were working on it. Reload it first");
    }
    const bill = await getBill(id, client);
    const returned = await returnedUnits(client, id);
    const byId = new Map(bill.lines.map((l) => [l.id, l]));
    const seen = new Set();
    const day = today();

    const priced = input.lines.map((wanted) => {
      const line = byId.get(wanted.line_id);
      if (!line) throw httpError(400, "One of the returned lines is not on this bill");
      if (seen.has(line.id)) throw httpError(400, `${line.medicine_name} is listed twice`);
      seen.add(line.id);
      const before = returned.get(line.id) ?? 0;
      const left = line.qty_units - before;
      if (wanted.qty_units > left) {
        throw httpError(
          409,
          `Only ${left} ${line.unit_label} of ${line.medicine_name} (batch ${line.batch_no}) can still be returned`,
        );
      }
      if (line.expiry_date <= day) {
        throw httpError(
          409,
          `${line.medicine_name} batch ${line.batch_no} has expired, so it cannot go back into stock`,
        );
      }
      const amounts = pharmacyReturnAmounts(line, bill, before, wanted.qty_units);
      if (amounts.total <= 0) {
        throw httpError(400, `The return of ${line.medicine_name} is too small to refund`);
      }
      return { line, units: wanted.qty_units, amounts };
    });
    const totals = pharmacyBillTotals(priced.map((p) => p.amounts));
    const { rows: prior } = await client.query(
      `SELECT COALESCE(SUM(net_amount), 0) AS credited FROM pharmacy_bills
        WHERE original_bill_id = $1 AND status = 'final'`,
      [id],
    );
    const remaining = toPaise(original.net_amount) - toPaise(prior[0].credited);
    if (remaining <= 0) {
      throw httpError(
        409,
        `Everything charged on bill ${original.bill_no} has already been credited`,
      );
    }
    totals.net = Math.min(totals.total, remaining);
    totals.roundOff = totals.net - totals.total;
    const { rows: dueRows } = await client.query(
      `SELECT ${DUE_SQL} AS due FROM pharmacy_bills b WHERE b.id = $1`,
      [id],
    );
    const dueAdjusted = Math.min(totals.net, toPaise(dueRows[0].due));
    const refund = totals.net - dueAdjusted;
    if (dueOnly && refund > 0) {
      throw httpError(
        409,
        `This return is worth ₹${toRupees(totals.net)} but only ₹${toRupees(dueAdjusted)} is still due on bill ${bill.bill_no}. Ask the pharmacy to take it back and refund the rest`,
      );
    }

    const number = await nextNumber(client, PHARMACY_SERIES.credit_note, day, ctx);
    const { rows: created } = await client.query(
      `INSERT INTO pharmacy_bills
         (bill_no, series, fy, bill_type, original_bill_id, sale_type, gst_folded,
          sale_rate_includes_gst, patient_id, visit_id, location_id, ipd_number, prescriber_name,
          bill_date, status, gross_amount, taxable_amount, cgst_amount, sgst_amount,
          folded_gst_amount, round_off, net_amount, paid_amount, due_adjusted, issued_legal_name, issued_gstin,
          issued_drug_license, notes, created_by, updated_by, finalised_by, finalised_at)
       SELECT $2, $3, $4, 'credit_note', o.id, o.sale_type, o.gst_folded,
              o.sale_rate_includes_gst, o.patient_id, o.visit_id, o.location_id, o.ipd_number,
              o.prescriber_name, $5, 'final', $6, $7, $8, $9, $10, $11, $12, $15, $16,
              o.issued_legal_name, o.issued_gstin, o.issued_drug_license, $13, $14, $14, $14, NOW()
         FROM pharmacy_bills o WHERE o.id = $1
       RETURNING id`,
      [
        id,
        number.number,
        number.series,
        number.fy,
        day,
        toRupees(totals.gross),
        toRupees(totals.taxable),
        toRupees(totals.cgst),
        toRupees(totals.sgst),
        toRupees(totals.foldedGst),
        toRupees(totals.roundOff),
        toRupees(totals.net),
        input.reason,
        ctx.actorId ?? null,
        toRupees(refund),
        toRupees(dueAdjusted),
      ],
    );
    const noteId = created[0].id;
    await client.query(
      `INSERT INTO pharmacy_bill_lines
         (bill_id, line_no, medicine_id, batch_id, credited_line_id, medicine_name, batch_no,
          expiry_date, hsn_code, schedule, rack_no, pack_size, unit_label, qty_units, pack_mrp,
          pack_sale_rate, gst_rate_pct, tax_rate_pct, gross_amount, mrp_amount, mrp_capped,
          taxable, cgst, sgst, folded_gst, total, created_by)
       SELECT $1, x.line_no, o.medicine_id, o.batch_id, o.id, o.medicine_name, o.batch_no,
              o.expiry_date, o.hsn_code, o.schedule, o.rack_no, o.pack_size, o.unit_label,
              x.qty_units, o.pack_mrp, o.pack_sale_rate, o.gst_rate_pct, o.tax_rate_pct,
              x.gross_amount, x.mrp_amount, o.mrp_capped, x.taxable, x.cgst, x.sgst,
              x.folded_gst, x.total, $2
         FROM jsonb_to_recordset($3::jsonb) AS x(
                line_no int, line_id uuid, qty_units int, gross_amount numeric,
                mrp_amount numeric, taxable numeric, cgst numeric, sgst numeric,
                folded_gst numeric, total numeric)
         JOIN pharmacy_bill_lines o ON o.id = x.line_id`,
      [
        noteId,
        ctx.actorId ?? null,
        JSON.stringify(
          priced.map(({ line, units, amounts }, i) => ({
            line_no: i + 1,
            line_id: line.id,
            qty_units: units,
            gross_amount: toRupees(amounts.gross),
            mrp_amount: toRupees(Math.max(amounts.mrpAmount, amounts.total)),
            taxable: toRupees(amounts.taxable),
            cgst: toRupees(amounts.cgst),
            sgst: toRupees(amounts.sgst),
            folded_gst: toRupees(amounts.foldedGst),
            total: toRupees(amounts.total),
          })),
        ),
      ],
    );

    await postMovements(
      client,
      priced.map(({ line, units }) => ({
        locationId: bill.location_id,
        batchId: line.batch_id,
        delta: units,
        kind: original.sale_type === "indent" ? "indent_return" : "sale_return",
        refType: ENTITY,
        refId: noteId,
        reason: input.reason,
      })),
      ctx,
    );

    if (refund > 0) {
      await client.query(
        `INSERT INTO pharmacy_payments
           (bill_id, direction, mode, amount, reference, upi_app, received_by, shift_id, patient_id)
         VALUES ($1, 'out', $2, $3, $4, $5, $6, $7, $8)`,
        [
          noteId,
          input.refund.mode,
          toRupees(refund),
          input.refund.reference ?? null,
          input.refund.upi_app ?? null,
          ctx.actorId ?? null,
          await shiftForPayments(client, ctx, [input.refund.mode]),
          bill.patient_id,
        ],
      );
    }
    await client.query(
      `UPDATE pharmacy_bills SET version = version + 1, updated_at = NOW(), updated_by = $2
        WHERE id = $1`,
      [id, ctx.actorId ?? null],
    );
    const note = await getBill(noteId, client);
    await writeAudit(client, {
      entity: ENTITY,
      entityId: noteId,
      action: "create",
      after: {
        bill_type: "credit_note",
        bill_no: note.bill_no,
        original_bill_no: bill.bill_no,
        refund: { mode: input.refund.mode, amount: toRupees(refund) },
        due_adjusted: toRupees(dueAdjusted),
        reason: input.reason,
        lines: priced.map(({ line, units }) => ({ batch_id: line.batch_id, qty_units: units })),
      },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return note;
  }, db);
}

export async function billReturns(id, db = pool) {
  const { rows } = await db.query(
    `SELECT c.id, c.bill_no, c.bill_date, c.net_amount, c.paid_amount AS refunded, c.due_adjusted,
            c.notes AS reason, c.finalised_at,
            (SELECT name FROM doctors d WHERE d.id = c.finalised_by) AS created_by_name,
            (SELECT pp.mode FROM pharmacy_payments pp WHERE pp.bill_id = c.id LIMIT 1) AS refund_mode
       FROM pharmacy_bills c
      WHERE c.original_bill_id = $1 AND c.status = 'final'
      ORDER BY c.finalised_at`,
    [id],
  );
  const returned = await returnedUnits(db, id);
  return { notes: rows, returned_units: Object.fromEntries(returned) };
}
