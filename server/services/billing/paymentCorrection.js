import pool from "../../config/db.js";
import { CAPABILITIES, hasAnyCapability } from "../../../shared/permissions.js";
import { HEALTHRAY_MODE } from "../../../shared/billingVocab.js";
import { paise } from "../../../shared/labPayment.js";
import { writeAudit } from "./audit.js";
import { DRAWER_MODE, PAYMENT_MODES, refreshClosedDrawer } from "./cashShifts.js";
import { auditFields } from "./common.js";
import { REFERENCE_MAX } from "./payments.js";
import { httpError, inTransaction } from "./transaction.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODE_LABEL = { cash: "Cash", card: "Card", upi: "UPI" };
const REASON_MAX = 300;

const PAYMENT_SQL = `
  SELECT p.id, p.bill_id, p.direction, p.mode, p.amount, p.reference, p.paid_via, p.receipt_no,
         p.shift_id, p.received_by, p.received_at, p.deposit_patient_id,
         b.status AS bill_status, b.bill_no,
         s.closed_at AS shift_closed_at,
         COALESCE(d.short_name, d.name) AS received_by_name
    FROM payments p
    JOIN bills b ON b.id = p.bill_id
    LEFT JOIN cash_shifts s ON s.id = p.shift_id
    LEFT JOIN doctors d ON d.id = p.received_by`;

const correctable = (row) =>
  row.direction === "in" && PAYMENT_MODES.includes(row.mode) && !row.deposit_patient_id;

const paidInHealthray = (row) => row.direction === "in" && row.mode === HEALTHRAY_MODE;

export function mayCorrect(row, ctx) {
  if (row.bill_status === "cancelled") return false;
  if (paidInHealthray(row)) return true;
  if (!correctable(row)) return false;
  if (hasAnyCapability(ctx?.role, CAPABILITIES.BILLING_MASTER)) return true;
  return row.received_by === ctx?.actorId && !!row.shift_id && !row.shift_closed_at;
}

function cleanCorrection(input) {
  const mode = typeof input?.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!PAYMENT_MODES.includes(mode)) {
    throw httpError(400, `Choose the mode it was really paid by: ${PAYMENT_MODES.join(", ")}`);
  }
  const typed = typeof input?.reference === "string" ? input.reference.trim() : "";
  if (mode !== DRAWER_MODE && !typed) {
    throw httpError(400, `A ${MODE_LABEL[mode]} payment needs its reference number`);
  }
  if (typed.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  const reason = typeof input?.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 5) throw httpError(400, "Say why the mode is being corrected");
  if (reason.length > REASON_MAX) {
    throw httpError(400, `The reason is too long — keep it under ${REASON_MAX} letters`);
  }
  return { mode, reference: mode === DRAWER_MODE ? null : typed, reason };
}

function refusal(row, ctx) {
  if (row.bill_status === "cancelled") {
    return httpError(409, "That bill was cancelled, so its payments can't be corrected");
  }
  if (!correctable(row)) {
    return httpError(
      409,
      "Only a cash, card, UPI or HealthRay payment can have its mode corrected",
    );
  }
  return httpError(
    403,
    row.received_by === ctx?.actorId
      ? "Your shift for that payment is closed — ask a reception admin to correct it"
      : "Only the person who took that payment (while their shift is open) or a reception admin can correct it",
  );
}

export async function correctPaymentMode(paymentId, input, ctx, db = pool) {
  const id = typeof paymentId === "string" ? paymentId.trim() : "";
  if (!UUID.test(id)) throw httpError(400, "Choose a valid payment");
  const wanted = cleanCorrection(input);
  return inTransaction(async (client) => {
    const { rows } = await client.query(`${PAYMENT_SQL} WHERE p.id = $1 FOR UPDATE OF p`, [id]);
    if (!rows.length) throw httpError(404, "That payment no longer exists");
    const before = rows[0];
    if (!mayCorrect(before, ctx)) throw refusal(before, ctx);
    if (paidInHealthray(before)) return recordHealthrayMode(client, before, wanted, ctx);
    if (before.mode === wanted.mode && (before.reference ?? null) === wanted.reference) {
      throw httpError(400, "That is already the payment's mode and reference");
    }
    const { rows: updated } = await client.query(
      `UPDATE payments SET mode = $2, reference = $3, updated_at = NOW(), updated_by = $4
        WHERE id = $1
        RETURNING id, bill_id, direction, mode, amount, reference, receipt_no, shift_id,
                  received_by, received_at`,
      [id, wanted.mode, wanted.reference, ctx?.actorId ?? null],
    );
    await writeAudit(client, {
      entity: "payments",
      entityId: id,
      action: "update",
      before: { mode: before.mode, reference: before.reference },
      after: { mode: wanted.mode, reference: wanted.reference, reason: wanted.reason },
      ...auditFields(ctx),
    });
    const drawerMoved = before.mode === DRAWER_MODE || wanted.mode === DRAWER_MODE;
    if (drawerMoved && before.shift_id) await refreshClosedDrawer(client, before.shift_id, ctx);
    return { ...updated[0], amount: paise(updated[0].amount) };
  }, db);
}

async function recordHealthrayMode(client, before, wanted, ctx) {
  if (before.paid_via === wanted.mode && (before.reference ?? null) === wanted.reference) {
    throw httpError(400, "That is already the payment's mode and reference");
  }
  const { rows: updated } = await client.query(
    `UPDATE payments SET paid_via = $2, reference = $3, updated_at = NOW(), updated_by = $4
      WHERE id = $1
      RETURNING id, bill_id, direction, mode, amount, reference, paid_via, receipt_no, shift_id,
                received_by, received_at`,
    [before.id, wanted.mode, wanted.reference, ctx?.actorId ?? null],
  );
  await writeAudit(client, {
    entity: "payments",
    entityId: before.id,
    action: "update",
    before: { paid_via: before.paid_via, reference: before.reference },
    after: { paid_via: wanted.mode, reference: wanted.reference, reason: wanted.reason },
    ...auditFields(ctx),
  });
  return { ...updated[0], amount: paise(updated[0].amount) };
}

export async function paymentsWithRights(billId, ctx, db = pool) {
  const { rows } = await db.query(
    `${PAYMENT_SQL} WHERE p.bill_id = $1 ORDER BY p.received_at, p.receipt_no, p.id`,
    [billId],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        received_by_name: row.received_by_name ?? null,
        shift_open: !!row.shift_id && !row.shift_closed_at,
        can_correct: mayCorrect(row, ctx),
      },
    ]),
  );
}
