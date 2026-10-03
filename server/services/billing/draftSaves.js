import { writeAudit } from "./audit.js";
import { auditFields } from "./common.js";
export async function draftSnapshot(client, billId) {
  const { rows: bills } = await client.query(
    `SELECT scheme_code, scheme_label, payer_name, scheme_ref_enc, referral_no_enc,
            referral_doc_id
       FROM bills WHERE id = $1`,
    [billId],
  );
  const { rows: lines } = await client.query(
    `SELECT service_item_id, quantity, source, lab_order_id, doctor_id, agreed_rate, agreed_by
       FROM bill_lines WHERE bill_id = $1 AND is_live AND source <> 'ordered'
      ORDER BY line_no, created_at, id`,
    [billId],
  );
  const { rows: codes } = await client.query(
    `SELECT DISTINCT ON (lower(d.code)) d.code
       FROM bill_line_discounts d JOIN bill_lines l ON l.id = d.bill_line_id
      WHERE l.bill_id = $1 AND l.is_live AND d.code IS NOT NULL
      ORDER BY lower(d.code)`,
    [billId],
  );
  return {
    header: bills[0],
    codes: codes.map((row) => row.code),
    lines: lines.map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      agreed_rate: line.agreed_rate === null ? null : Number(line.agreed_rate),
    })),
  };
}

export async function markDraftSaved(client, billId, ctx) {
  const snapshot = await draftSnapshot(client, billId);
  await client.query(`UPDATE bills SET saved_at = NOW(), saved_snapshot = $2 WHERE id = $1`, [
    billId,
    snapshot,
  ]);
  await writeAudit(client, {
    entity: "bills",
    entityId: billId,
    action: "update",
    after: { draft_saved: true, lines: snapshot.lines.length },
    ...auditFields(ctx),
  });
}
