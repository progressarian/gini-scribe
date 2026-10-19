import "../loadEnv.js";
import pool from "../config/db.js";
import { createItem } from "../services/billing/serviceItems.js";
import { RECENT_FOLLOW_UP } from "../../shared/billingVocab.js";

const apply = process.argv.includes("--apply");
const ITEM = {
  code: "CONS-FU3",
  name: "Follow-up within 3 days",
  kind: "consultation",
  visit_type: RECENT_FOLLOW_UP,
  doctor_id: null,
  base_price: 0,
};

try {
  const { rows: allowed } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'service_items_visit_type_check'`,
  );
  if (!allowed[0]?.def.includes(RECENT_FOLLOW_UP)) {
    throw new Error("Apply migrations/2026-11-02_follow_up_within_3_days.sql first");
  }
  const { rows: existing } = await pool.query(
    `SELECT id, code, name, base_price, is_active FROM service_items
      WHERE kind = 'consultation' AND visit_type = $1 AND doctor_id IS NULL`,
    [RECENT_FOLLOW_UP],
  );
  if (existing.some((row) => row.is_active)) {
    console.log(
      "Already there:",
      existing.filter((row) => row.is_active),
    );
  } else if (!apply) {
    console.log("Would create:", ITEM);
    console.log("Dry run, nothing written. Re-run with --apply.");
  } else {
    const created = await createItem(ITEM, { actorId: null });
    console.log("Created:", {
      id: created.id,
      code: created.code,
      name: created.name,
      base_price: created.base_price,
      visit_type: created.visit_type,
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
