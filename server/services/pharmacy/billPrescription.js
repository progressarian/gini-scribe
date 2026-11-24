import pool from "../../config/db.js";
import { httpError } from "../billing/transaction.js";
import { canonicalMedKey } from "../medication/normalize.js";
import { suggestedUnits } from "../../../shared/rxQuantity.js";

const DISPENSABLE = ["continued", "changed", "new"];
const COUNTED_UNITS = ["tab", "cap"];

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export const medicineKeysOf = (pharmacyMatch, name) =>
  [...new Set([canonicalMedKey(pharmacyMatch), canonicalMedKey(name)])].filter(Boolean);

const keysFor = (item) => medicineKeysOf(item.pharmacy_match, item.medicine_name);

export async function stockByKey(keys, locationId, db = pool) {
  const byKey = new Map();
  if (!keys.length) return byKey;
  const { rows } = await db.query(
    `SELECT m.id, m.code, m.name, m.medicine_key, m.pack_size, m.pack_label, m.unit_label,
            COALESCE(SUM(s.qty_units) FILTER (WHERE b.expiry_date > $3::date), 0)::int
              AS sellable_units
       FROM pharmacy_medicines m
       LEFT JOIN pharmacy_batches b ON b.medicine_id = m.id
       LEFT JOIN pharmacy_stock s ON s.batch_id = b.id AND s.location_id = $2
      WHERE m.medicine_key = ANY($1::text[]) AND m.is_active
      GROUP BY m.id
      ORDER BY m.id`,
    [keys, locationId, today()],
  );
  for (const m of rows) if (!byKey.has(m.medicine_key)) byKey.set(m.medicine_key, m);
  return byKey;
}

export async function prescriptionsFor(visitIds, { locationId, billId = null }, db = pool) {
  const result = new Map(visitIds.map((id) => [id, []]));
  if (!visitIds.length) return result;
  const { rows: items } = await db.query(
    `SELECT i.id, i.visit_id, i.medicine_name, i.pharmacy_match, i.dose, i.frequency, i.duration,
            i.form, i.change_type
       FROM giniflow_rx_items i
      WHERE i.visit_id = ANY($1::uuid[])
        AND i.change_type = ANY($2::text[])
        AND COALESCE(i.approval_status, 'approved') IN ('approved', 'adjusted')
      ORDER BY i.visit_id, i.sort_order NULLS LAST, i.created_at`,
    [visitIds, DISPENSABLE],
  );
  if (!items.length) return result;

  const byKey = await stockByKey([...new Set(items.flatMap(keysFor))], locationId, db);

  let onBill = new Set();
  if (billId) {
    const { rows: billed } = await db.query(
      `SELECT DISTINCT medicine_id FROM pharmacy_bill_lines WHERE bill_id = $1`,
      [billId],
    );
    onBill = new Set(billed.map((r) => r.medicine_id));
  }

  for (const item of items) {
    const medicine =
      keysFor(item)
        .map((k) => byKey.get(k))
        .find(Boolean) ?? null;
    const units =
      medicine && COUNTED_UNITS.includes(medicine.unit_label) ? suggestedUnits(item) : null;
    result.get(item.visit_id).push({
      rx_item_id: item.id,
      medicine_name: item.medicine_name,
      dose: item.dose,
      frequency: item.frequency,
      duration: item.duration,
      medicine: medicine && {
        id: medicine.id,
        code: medicine.code,
        name: medicine.name,
        pack_size: medicine.pack_size,
        pack_label: medicine.pack_label,
        unit_label: medicine.unit_label,
        sellable_units: medicine.sellable_units,
      },
      suggested_units: units,
      on_bill: Boolean(medicine && onBill.has(medicine.id)),
    });
  }
  return result;
}

export async function visitPrescription(visitId, options, db = pool) {
  return (await prescriptionsFor([visitId], options, db)).get(visitId);
}

export async function billPrescription(billId, db = pool) {
  const { rows: bills } = await db.query(
    `SELECT id, visit_id, location_id FROM pharmacy_bills WHERE id = $1`,
    [billId],
  );
  if (!bills.length) throw httpError(404, "Pharmacy bill not found");
  const bill = bills[0];
  if (!bill.visit_id) return { visit_id: null, items: [] };
  return {
    visit_id: bill.visit_id,
    items: await visitPrescription(
      bill.visit_id,
      { locationId: bill.location_id, billId: bill.id },
      db,
    ),
  };
}
