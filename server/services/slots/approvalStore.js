import pool from "../../config/db.js";

let ready = false;
let checkedAt = 0;

export async function approvalsReady(client = pool) {
  if (ready || Date.now() - checkedAt < 60_000) return ready;
  checkedAt = Date.now();
  const { rows } = await client.query(
    "SELECT to_regclass('public.booking_approvals') IS NOT NULL AS ok",
  );
  ready = rows[0].ok;
  return ready;
}
