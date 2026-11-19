import pool from "../../config/db.js";
import { HEALTHRAY_MODE } from "../../../shared/billingVocab.js";
import { ROLES } from "../../../shared/permissions.js";
import { approveRequest, createRefundRequest } from "./billingRequests.js";
import { addLine, cleanReason, clearHealthrayAndFinalise, openDraft, readBill } from "./bills.js";
import { payOut, refundPlan } from "./payments.js";
import { takesPatientPrice } from "./serviceItems.js";
import { writeAudit } from "./audit.js";
import { auditFields } from "./common.js";
import { httpError, inTransaction } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanDropped(value) {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string" || !UUID.test(id))) {
    throw httpError(400, "Choose the lines to leave off by their ids");
  }
  return new Set(value.map((id) => id.toLowerCase()));
}

async function billToCorrect(client, billId) {
  const { rows } = await client.query(
    `SELECT id, bill_no, bill_type, status, visit_id FROM bills WHERE id = $1 FOR UPDATE`,
    [billId],
  );
  const bill = rows[0];
  if (!bill) throw httpError(404, "That bill no longer exists");
  if (bill.bill_type !== "invoice" || bill.status !== "final" || !bill.visit_id) {
    throw httpError(409, `Only a final visit bill can be corrected, and ${bill.bill_no} isn't one`);
  }
  const { rows: credited } = await client.query(
    `SELECT bill_no FROM bills WHERE original_bill_id = $1 LIMIT 1`,
    [bill.id],
  );
  if (credited.length) {
    throw httpError(
      409,
      `${bill.bill_no} already has credit note ${credited[0].bill_no}, so it can't be corrected this way`,
    );
  }
  const { rows: modes } = await client.query(
    `SELECT DISTINCT mode FROM payments WHERE bill_id = $1 AND direction = 'in'`,
    [bill.id],
  );
  if (!modes.length || modes.some((row) => row.mode !== HEALTHRAY_MODE)) {
    throw httpError(
      409,
      `${bill.bill_no} has money taken in Scribe, not only in HealthRay, so it can't be corrected this way — refund it at the desk instead`,
    );
  }
  return bill;
}

async function linesToKeep(client, bill, dropped) {
  const { rows } = await client.query(
    `SELECT l.id, l.service_item_id, l.lab_order_id, l.agreed_rate, l.agreed_by,
            i.price_per_patient, i.base_price, i.no_charge
       FROM bill_lines l JOIN service_items i ON i.id = l.service_item_id
      WHERE l.bill_id = $1 AND l.is_live
      ORDER BY l.line_no, l.id`,
    [bill.id],
  );
  const unknown = [...dropped].find((id) => !rows.some((row) => row.id === id));
  if (unknown) throw httpError(400, `Line ${unknown} isn't on ${bill.bill_no}`);
  const kept = rows.filter((row) => !dropped.has(row.id));
  if (!kept.length) throw httpError(400, "Keep at least one line, or cancel the bill instead");
  return kept;
}

export async function markReplaced(client, bill, newBillId, reason, ctx) {
  await client.query(
    `UPDATE bills SET replaced_by_bill_id = $2, updated_at = NOW(), updated_by = $3 WHERE id = $1`,
    [bill.id, newBillId, ctx?.actorId ?? null],
  );
  await writeAudit(client, {
    entity: "bills",
    entityId: bill.id,
    action: "update",
    before: { replaced_by_bill_id: null },
    after: { replaced_by_bill_id: newBillId, reason },
    ...auditFields(ctx),
  });
}

const lineInput = (line) => ({
  item_id: line.service_item_id,
  ...(line.lab_order_id
    ? { source: "lab_order", lab_order_id: line.lab_order_id }
    : { source: "added" }),
  ...(line.agreed_rate !== null && takesPatientPrice(line)
    ? line.agreed_by
      ? { agreed_rate: line.agreed_rate, agreed_by: line.agreed_by }
      : { agreed_rate: line.agreed_rate, price_from_healthray: true }
    : {}),
});

export async function rebillFinalBill(billId, input, ctx, db = pool) {
  if (ctx?.role !== ROLES.ADMIN || !ctx?.actorId) {
    throw httpError(403, "Only an admin can correct a final bill");
  }
  if (typeof billId !== "string" || !UUID.test(billId)) throw httpError(400, "Choose a valid bill");
  const reason = cleanReason(input?.reason, "Say why this bill is being corrected");
  const dropped = cleanDropped(input?.drop_line_ids);
  return inTransaction(async (client) => {
    const bill = await billToCorrect(client, billId.toLowerCase());
    const kept = await linesToKeep(client, bill, dropped);
    const request = await createRefundRequest(
      {
        bill_id: bill.id,
        whole_bill: true,
        reason_code: "other",
        note: reason,
        requested_mode: "as_paid",
      },
      ctx,
      client,
    );
    const approved = await approveRequest(
      request.id,
      { note: reason, release_done_tests: true },
      ctx,
      client,
    );
    const note = approved.credit_note;
    const plan = await refundPlan(note.id, client);
    await payOut(
      note.id,
      {
        version: note.version,
        payments: plan.legs.map((leg) => ({ mode: leg.mode, amount: leg.amount / 100 })),
      },
      ctx,
      client,
    );
    const draft = await openDraft(bill.visit_id, { ...ctx, skipPriceCatchUp: true }, client);
    if (draft.lines.length) {
      throw httpError(
        409,
        "This visit already has a draft bill with items on it — clear that draft before correcting",
      );
    }
    for (const line of kept) await addLine(draft.id, lineInput(line), ctx, client);
    const ready = await readBill(draft.id, client);
    await clearHealthrayAndFinalise(draft.id, { version: ready.version }, ctx, client);
    await markReplaced(client, bill, draft.id, reason, ctx);
    return {
      credit_note_id: note.id,
      credit_note_no: note.bill_no,
      refunded: plan.due,
      bill: await readBill(draft.id, client),
    };
  }, db);
}
