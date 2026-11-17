import pool from "../../config/db.js";
import { writeAudit } from "../billing/audit.js";
import { httpError, inTransaction } from "../billing/transaction.js";
import { rebuildInventoryFor } from "./inventorySync.js";

const FIELDS = [
  "legal_name",
  "gstin",
  "drug_license_no",
  "address",
  "phone",
  "bill_footer",
  "sale_rate_includes_gst",
  "near_expiry_warn_days",
  "expiry_alert_days",
  "stock_source",
  "credit_limit",
  "max_discount_pct",
];

const ROW = `${FIELDS.join(", ")}, version, updated_at,
  (SELECT name FROM doctors d WHERE d.id = pharmacy_settings.updated_by) AS updated_by_name`;

export async function getPharmacySettings(db = pool) {
  const { rows } = await db.query(`SELECT ${ROW} FROM pharmacy_settings WHERE id`);
  return rows[0];
}

export async function updatePharmacySettings({ version, ...input }, ctx = {}, db = pool) {
  return inTransaction(async (client) => {
    const { rows: current } = await client.query(
      `SELECT ${ROW} FROM pharmacy_settings WHERE id FOR UPDATE`,
    );
    const before = current[0];
    if (before.version !== version) {
      throw httpError(
        409,
        "Someone else changed the pharmacy settings. Reload them and make your change again",
      );
    }
    const { rows } = await client.query(
      `UPDATE pharmacy_settings
          SET ${FIELDS.map((f, i) => `${f} = $${i + 1}`).join(", ")},
              version = version + 1, updated_by = $${FIELDS.length + 1}, updated_at = NOW()
        WHERE id
        RETURNING ${ROW}`,
      [...FIELDS.map((f) => (input[f] === undefined ? before[f] : input[f])), ctx.actorId ?? null],
    );
    const inventory =
      before.stock_source !== rows[0].stock_source
        ? await rebuildInventoryFor(client, rows[0].stock_source)
        : null;
    await writeAudit(client, {
      entity: "pharmacy_settings",
      entityId: "pharmacy",
      action: "update",
      before,
      after: { ...rows[0], ...(inventory ? { inventory_rebuilt: inventory } : {}) },
      actorId: ctx.actorId,
      ip: ctx.ip,
    });
    return rows[0];
  }, db);
}
