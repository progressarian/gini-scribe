export const ISSUED_GST_COLUMNS = ["issued_gst", "issued_gstin", "issued_legal_name"];

export async function issuedGstReady(db) {
  const { rows } = await db.query(
    `SELECT count(*) = $1 AS ready
       FROM pg_attribute
      WHERE attrelid = 'public.bills'::regclass AND attname = ANY($2) AND NOT attisdropped`,
    [ISSUED_GST_COLUMNS.length, ISSUED_GST_COLUMNS],
  );
  return rows[0].ready;
}
