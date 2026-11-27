import { httpError } from "./transaction.js";

export async function assertNotEditing(client, billId, doing) {
  const { rows } = await client.query(`SELECT bill_no, edit_started_at FROM bills WHERE id = $1`, [
    billId,
  ]);
  if (rows[0]?.edit_started_at) {
    throw httpError(
      409,
      `Bill ${rows[0].bill_no} is being edited — save or discard the edit before ${doing}`,
      { code: "bill_editing" },
    );
  }
}
