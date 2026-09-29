export async function draftSnapshot(client, billId) {
  const { rows: bills } = await client.query(
    `SELECT scheme_code, scheme_label, payer_name, scheme_ref_enc, referral_no_enc,
            referral_doc_id
       FROM bills WHERE id = $1`,
    [billId],
  );
  const { rows: lines } = await client.query(
    `SELECT service_item_id, quantity, source, lab_order_id, doctor_id
       FROM bill_lines WHERE bill_id = $1 AND is_live
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
    lines: lines.map((line) => ({ ...line, quantity: Number(line.quantity) })),
  };
}

export async function markDraftSaved(client, billId) {
  await client.query(`UPDATE bills SET saved_at = NOW(), saved_snapshot = $2 WHERE id = $1`, [
    billId,
    await draftSnapshot(client, billId),
  ]);
}
