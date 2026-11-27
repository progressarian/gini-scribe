import pool from "../../config/db.js";
import { paise } from "../../../shared/labPayment.js";
import { writeAudit } from "./audit.js";
import {
  BILL_COLUMNS,
  billCodes,
  billLabel,
  cleanReason,
  dropLineIn,
  isEditing,
  liveLines,
  lockBill,
  reprice,
  resettleTestOrders,
  takenOn,
  withLines,
} from "./bills.js";
import { auditFields, wholeNumber } from "./common.js";
import { syncMemberships } from "./membershipCards.js";
import { settleTestOrders, syncLabSteps } from "./payments.js";
import { httpError, inTransaction } from "./transaction.js";

const RESTORED_BILL_COLUMNS = [
  "actual_amount",
  "discount_amount",
  "tax_amount",
  "patient_payable",
  "claim_amount",
  "adjustment_amount",
  "round_off",
  "claim_status",
  "manual_discount_kind",
  "manual_discount_value",
  "manual_discount_reason",
  "manual_discount_by",
  "manual_discount_at",
  "membership_card_id",
];

const LINE_SUMMARY = (line) => ({
  id: line.id,
  item_id: line.service_item_id,
  name: line.bill_name,
  quantity: Number(line.quantity),
  rate: paise(line.rate),
  discount: paise(line.discount) + paise(line.bill_discount ?? 0),
  payable: paise(line.patient_payable),
});

const rupees = (amount) => (amount / 100).toFixed(2);

function cleanVersion(input) {
  const version = wholeNumber(input?.version, "Version", { min: 0 });
  if (version === undefined) throw httpError(400, "Send the bill's version so nothing is lost");
  return version;
}

function assertSameVersion(bill, version) {
  if (bill.version !== version) {
    throw httpError(409, "This bill changed while you were working on it — open it again", {
      version: bill.version,
    });
  }
}

async function snapshotOf(client, billId) {
  const { rows } = await client.query(
    `SELECT to_jsonb(b) - 'edit_snapshot' AS bill,
            COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_no, l.id)
                        FROM bill_lines l WHERE l.bill_id = b.id), '[]'::jsonb) AS lines,
            COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at, d.id)
                        FROM bill_line_discounts d JOIN bill_lines l ON l.id = d.bill_line_id
                       WHERE l.bill_id = b.id), '[]'::jsonb) AS discounts
       FROM bills b WHERE b.id = $1`,
    [billId],
  );
  return rows[0];
}

function editRefusal(bill) {
  if (bill.bill_type !== "invoice") return "A credit note can't be edited";
  if (bill.status === "draft") return `${billLabel(bill)} is still a draft — change it directly`;
  if (bill.status !== "final") return `${billLabel(bill)} was cancelled, so it can't be edited`;
  return null;
}

const reread = async (client, billId) =>
  (await client.query(`SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1`, [billId])).rows[0];

const show = async (client, bill) =>
  withLines(client, bill, { codes: await billCodes(client, bill.id) });

export async function startEdit(billId, input, ctx, db = pool) {
  const version = cleanVersion(input);
  return inTransaction(async (client) => {
    const bill = await lockBill(client, billId);
    if (isEditing(bill)) return show(client, bill);
    assertSameVersion(bill, version);
    const refusal = editRefusal(bill);
    if (refusal) throw httpError(409, refusal, { code: "edit_refused" });
    const snapshot = await snapshotOf(client, bill.id);
    await client.query(
      `UPDATE bills SET edit_started_at = NOW(), edit_started_by = $2, edit_snapshot = $3,
              version = version + 1, updated_at = NOW(), updated_by = $2
        WHERE id = $1`,
      [bill.id, ctx?.actorId ?? null, snapshot],
    );
    await writeAudit(client, {
      entity: "bills",
      entityId: bill.id,
      action: "update",
      before: { edit_started: false },
      after: { edit_started: true, bill_no: bill.bill_no, revision_no: bill.revision_no },
      ...auditFields(ctx),
    });
    return show(client, await reread(client, bill.id));
  }, db);
}

async function lockedEdit(client, billId, version) {
  const bill = await lockBill(client, billId);
  if (!isEditing(bill)) {
    throw httpError(409, `${billLabel(bill)} isn't being edited`, { code: "not_editing" });
  }
  assertSameVersion(bill, version);
  return bill;
}

async function storedSnapshot(client, billId) {
  const { rows } = await client.query(`SELECT edit_snapshot FROM bills WHERE id = $1`, [billId]);
  return rows[0].edit_snapshot;
}

function changesOf(before, after) {
  const was = new Map(before.lines.filter((l) => l.is_live).map((l) => [l.id, LINE_SUMMARY(l)]));
  const now = new Map(after.lines.filter((l) => l.is_live).map((l) => [l.id, LINE_SUMMARY(l)]));
  const added = [...now.values()].filter((line) => !was.has(line.id));
  const removed = [...was.values()].filter((line) => !now.has(line.id));
  const changed = [...now.values()]
    .filter((line) => was.has(line.id))
    .filter((line) => JSON.stringify(line) !== JSON.stringify(was.get(line.id)))
    .map((line) => ({ before: was.get(line.id), after: line }));
  const total = (snapshot) => paise(snapshot.bill.patient_payable);
  const manual = (snapshot) =>
    JSON.stringify([snapshot.bill.manual_discount_kind, snapshot.bill.manual_discount_value]);
  return {
    added,
    removed,
    changed,
    payable_before: total(before),
    payable_after: total(after),
    bill_discount_changed: manual(before) !== manual(after),
  };
}

const nothingChanged = (changes) =>
  !changes.added.length &&
  !changes.removed.length &&
  !changes.changed.length &&
  !changes.bill_discount_changed &&
  changes.payable_before === changes.payable_after;

async function closeSession(client, bill, ctx, revised) {
  const { rows } = await client.query(
    `UPDATE bills SET edit_started_at = NULL, edit_started_by = NULL, edit_snapshot = NULL,
            revision_no = revision_no + $3::int,
            revised_at = CASE WHEN $3::int = 1 THEN NOW() ELSE revised_at END,
            revised_by = CASE WHEN $3::int = 1 THEN $2::int ELSE revised_by END,
            version = version + 1, updated_at = NOW(), updated_by = $2
      WHERE id = $1 RETURNING ${BILL_COLUMNS}`,
    [bill.id, ctx?.actorId ?? null, revised ? 1 : 0],
  );
  return rows[0];
}

export async function previewEdit(billId, db = pool) {
  return inTransaction(async (client) => {
    const bill = await lockBill(client, billId);
    if (!isEditing(bill)) throw httpError(409, `${billLabel(bill)} isn't being edited`);
    const changes = changesOf(
      await storedSnapshot(client, bill.id),
      await snapshotOf(client, bill.id),
    );
    const paid = await takenOn(client, bill.id);
    return { ...changes, paid, due: Math.max(0, changes.payable_after - paid) };
  }, db);
}

export async function saveEdit(billId, input, ctx, db = pool) {
  const version = cleanVersion(input);
  const reason = cleanReason(input?.reason, "Say why this bill is being changed");
  return inTransaction(async (client) => {
    const bill = await lockedEdit(client, billId, version);
    const lines = await liveLines(client, bill.id);
    if (!lines.length) {
      throw httpError(409, "A bill needs at least one item — cancel the bill instead");
    }
    const saved = await reprice(client, bill, await billCodes(client, bill.id), ctx);
    const unpriced = saved.priced?.lines?.find((line) => line.price_missing);
    if (unpriced) {
      throw httpError(409, `Enter this patient's price for ${unpriced.item_name}`, {
        code: "price_needed",
      });
    }
    const before = await storedSnapshot(client, bill.id);
    const after = await snapshotOf(client, bill.id);
    const changes = changesOf(before, after);
    if (nothingChanged(changes)) return show(client, await closeSession(client, bill, ctx, false));
    await syncMemberships(client, bill.id, ctx);
    await settleTestOrders(client, saved.bill, ctx);
    await syncLabSteps(client, saved.bill.visit_id);
    const revisionNo = bill.revision_no + 1;
    await client.query(
      `INSERT INTO bill_revisions (bill_id, revision_no, reason, before, after, revised_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [bill.id, revisionNo, reason, before, after, ctx?.actorId ?? null],
    );
    const closed = await closeSession(client, saved.bill, ctx, true);
    const paid = await takenOn(client, bill.id);
    await writeAudit(client, {
      entity: "bills",
      entityId: bill.id,
      action: "update",
      before: {
        bill_no: bill.bill_no,
        revision_no: bill.revision_no,
        patient_payable: rupees(changes.payable_before),
        lines: before.lines.filter((l) => l.is_live).map(LINE_SUMMARY),
      },
      after: {
        bill_no: bill.bill_no,
        revision_no: revisionNo,
        patient_payable: rupees(changes.payable_after),
        due: rupees(Math.max(0, changes.payable_after - paid)),
        added: changes.added.map((line) => line.name),
        removed: changes.removed.map((line) => line.name),
        changed: changes.changed.map((entry) => entry.after.name),
        reason,
      },
      ...auditFields(ctx),
    });
    return show(client, closed);
  }, db);
}

const lineColumns = (lines) => Object.keys(lines[0]).filter((key) => key !== "id");

async function restoreLines(client, bill, snapshot, ctx) {
  const kept = new Set(snapshot.lines.map((line) => line.id));
  for (const line of await liveLines(client, bill.id, { all: true })) {
    if (kept.has(line.id)) continue;
    await dropLineIn(
      client,
      bill,
      line,
      { removed: true, discarded: true, reason: "Bill edit discarded" },
      ctx,
    );
  }
  await client.query(
    `DELETE FROM bill_line_discounts d USING bill_lines l
      WHERE l.id = d.bill_line_id AND l.bill_id = $1`,
    [bill.id],
  );
  if (!snapshot.lines.length) return;
  await client.query(`UPDATE bill_lines SET line_no = line_no + 100000 WHERE bill_id = $1`, [
    bill.id,
  ]);
  const columns = lineColumns(snapshot.lines);
  await client.query(
    `INSERT INTO bill_lines
     SELECT * FROM jsonb_populate_recordset(NULL::bill_lines, $1::jsonb)
     ON CONFLICT (id) DO UPDATE SET ${columns.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`,
    [JSON.stringify(snapshot.lines)],
  );
  if (!snapshot.discounts.length) return;
  await client.query(
    `INSERT INTO bill_line_discounts
     SELECT * FROM jsonb_populate_recordset(NULL::bill_line_discounts, $1::jsonb)`,
    [JSON.stringify(snapshot.discounts)],
  );
}

async function restoreHeader(client, bill, snapshot) {
  const paid = await takenOn(client, bill.id);
  if (paise(snapshot.bill.patient_payable) < paid) {
    throw httpError(
      409,
      `₹${rupees(paid)} was collected during this edit, which is more than the bill came to before it, so the edit can't be discarded — save it instead`,
    );
  }
  const restored = Object.fromEntries(
    RESTORED_BILL_COLUMNS.map((column) => [column, snapshot.bill[column] ?? null]),
  );
  await client.query(
    `UPDATE bills b SET ${RESTORED_BILL_COLUMNS.map((c) => `${c} = r.${c}`).join(", ")}
       FROM jsonb_populate_record(NULL::bills, $2::jsonb) r
      WHERE b.id = $1`,
    [bill.id, JSON.stringify(restored)],
  );
}

export async function discardEdit(billId, input, ctx, db = pool) {
  const version = cleanVersion(input);
  return inTransaction(async (client) => {
    const bill = await lockedEdit(client, billId, version);
    const snapshot = await storedSnapshot(client, bill.id);
    await restoreHeader(client, bill, snapshot);
    await restoreLines(client, bill, snapshot, ctx);
    const closed = await closeSession(client, bill, ctx, false);
    await resettleTestOrders(client, closed, ctx);
    await syncLabSteps(client, closed.visit_id);
    await writeAudit(client, {
      entity: "bills",
      entityId: bill.id,
      action: "update",
      before: { edit_started: true },
      after: { edit_started: false, discarded: true, bill_no: bill.bill_no },
      ...auditFields(ctx),
    });
    return show(client, await reread(client, bill.id));
  }, db);
}
