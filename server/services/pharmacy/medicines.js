import pool from "../../config/db.js";
import { checkStockLevels } from "./alerts.js";
import { mainLocationId } from "./stockLedger.js";
import { canonicalMedKey } from "../medication/normalize.js";
import { masterRecords } from "./masterRecords.js";

export const medicineRecords = masterRecords({
  table: "pharmacy_medicines",
  noun: "medicine",
  fields: [
    "code",
    "name",
    "generic_name",
    "manufacturer",
    "form",
    "strength",
    "pack_size",
    "unit_label",
    "pack_label",
    "hsn_code",
    "gst_rate_pct",
    "schedule",
    "default_mrp",
    "default_sale_rate",
    "min_stock_units",
    "max_stock_units",
    "reorder_qty_units",
    "default_rack",
    "medicine_key",
    "needs_review",
  ],
  duplicates: {
    pharmacy_medicines_name_key: "A medicine with this name already exists",
    pharmacy_medicines_code_key: "Another medicine already uses this code",
  },
  searchColumns: ["name", "generic_name", "manufacturer", "code"],
  prepare: (input) => ({
    ...input,
    code: input.code ?? undefined,
    medicine_key: input.medicine_key ?? canonicalMedKey(input.name),
    needs_review: input.needs_review ?? false,
  }),
});

export function listMedicines({ schedule, form, review, ...params }) {
  const filters = [];
  if (review) filters.push({ sql: "needs_review = ?", value: true });
  if (schedule) filters.push({ sql: "schedule = ?", value: schedule });
  if (form) filters.push({ sql: "form = ?", value: form });
  return medicineRecords.list({ ...params, filters });
}

export const getMedicine = (id) => medicineRecords.get(id);
export const createMedicine = (input, ctx) => medicineRecords.create(input, ctx);
export async function updateMedicine(id, input, ctx) {
  const before = await medicineRecords.get(id);
  const sameName =
    before.name.trim().toLowerCase() ===
    String(input.name ?? "")
      .trim()
      .toLowerCase();
  const saved = await medicineRecords.update(
    id,
    sameName ? { ...input, medicine_key: before.medicine_key } : input,
    ctx,
  );
  try {
    const main = await mainLocationId(pool);
    await checkStockLevels(pool, [{ locationId: main, medicineId: saved.id }]);
  } catch (e) {
    console.error("[Pharmacy Alerts] level check after a medicine change failed:", e.message);
  }
  return saved;
}
export const setMedicineActive = (id, isActive, ctx) =>
  medicineRecords.setActive(id, isActive, ctx);
