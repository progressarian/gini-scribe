import { z } from "zod";
import { ADJUSTMENT_REASONS, GST_MAX } from "../../shared/pharmacyVocab.js";
import { blankToNull, optionalText, upper } from "./pharmacyFields.js";

const twoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const money = (min, message) =>
  z.coerce
    .number()
    .min(min, message)
    .max(10000000)
    .refine(twoDecimals, "can have at most 2 decimal places");

const id = z.coerce.number().int().min(1);
const optionalId = z.preprocess(blankToNull, id.nullish());
const optionalDate = z.preprocess(blankToNull, z.iso.date("must be a date").nullish());

export const BATCH_PATTERN = /^[A-Z0-9][A-Z0-9/._-]{0,29}$/;

export const pharmacyPurchaseLineSchema = z
  .strictObject({
    medicine_id: id,
    batch_no: z.preprocess(
      (v) => (typeof v === "string" ? upper(v).replace(/\s+/g, "") : v),
      z.string().regex(BATCH_PATTERN, "must be 1 to 30 letters, digits or / . _ -"),
    ),
    expiry_date: z.iso.date("must be a date"),
    mfg_date: optionalDate,
    qty_packs: z.coerce.number().int().min(0).max(1000000),
    free_packs: z.coerce.number().int().min(0).max(1000000).default(0),
    purchase_rate: money(0),
    discount_pct: z.coerce
      .number()
      .min(0)
      .max(100)
      .refine(twoDecimals, "can have at most 2 decimal places")
      .default(0),
    gst_rate_pct: z.coerce.number().min(0).max(GST_MAX).refine(twoDecimals),
    mrp: money(0.01, "must be more than 0"),
    sale_rate: money(0.01, "must be more than 0"),
    rack_no: optionalText(40),
    vendor_id: optionalId,
  })
  .refine((l) => l.qty_packs + l.free_packs > 0, {
    path: ["qty_packs"],
    message: "and free packs cannot both be 0",
  })
  .refine((l) => l.sale_rate <= l.mrp, {
    path: ["sale_rate"],
    message: "cannot be more than the MRP",
  })
  .refine((l) => !l.mfg_date || l.mfg_date < l.expiry_date, {
    path: ["mfg_date"],
    message: "must be before the expiry date",
  });

const header = {
  vendor_id: optionalId,
  invoice_no: optionalText(60),
  invoice_date: optionalDate,
  notes: optionalText(1000),
};

export const pharmacyPurchaseLabels = {
  vendor_id: "Vendor",
  invoice_no: "Invoice number",
  invoice_date: "Invoice date",
};

export const pharmacyPurchaseCreateSchema = z.strictObject({
  kind: z.enum(["purchase", "opening"]).default("purchase"),
  ...header,
});

export const pharmacyPurchaseUpdateSchema = z.strictObject({
  ...header,
  lines: z.array(pharmacyPurchaseLineSchema).max(2000, "can have at most 2000 lines"),
  version: id,
});

export const pharmacyPurchaseVersionSchema = z.strictObject({ version: id });

export const pharmacyPurchaseCancelSchema = z.strictObject({
  version: id,
  reason: z.string().trim().min(3, "must say why the receipt is cancelled").max(500),
});

export const pharmacyPurchaseListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(["draft", "posted", "cancelled", "all"]).default("all"),
  kind: z.enum(["purchase", "opening"]).optional(),
  vendor_id: optionalId,
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const locationParam = z.preprocess(blankToNull, id.nullish());

export const pharmacyStockViewQuerySchema = z.object({
  location_id: locationParam,
  q: z.string().trim().max(80).optional(),
  filter: z
    .enum(["all", "in_stock", "out", "low", "over", "near_expiry", "expired"])
    .default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyStockLocationQuerySchema = z.object({ location_id: locationParam });

export const pharmacyMedicineBatchesQuerySchema = z.object({
  location_id: locationParam,
  medicine_id: id,
});

export const pharmacyBatchMovementsQuerySchema = z.object({
  location_id: locationParam,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyAdjustmentLabels = {
  new_units: "New quantity",
  expected_units: "Current quantity",
  note: "Note",
};

export const pharmacyAdjustmentSchema = z.strictObject({
  location_id: locationParam,
  batch_id: id,
  expected_units: z.coerce.number().int().min(0),
  new_units: z.coerce.number().int().min(0).max(100000000),
  reason: z.enum(ADJUSTMENT_REASONS),
  note: z.string().trim().min(3, "must say what happened (at least 3 characters)").max(500),
});

export const pharmacyAdjustmentListQuerySchema = z.object({
  location_id: locationParam,
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyBatchListQuerySchema = z.object({
  location_id: locationParam,
  q: z.string().trim().max(80).optional(),
  form: z.preprocess(blankToNull, z.string().trim().max(20).nullish()),
  vendor_id: optionalId,
  expiry: z.enum(["all", "expired", "30", "90", "fresh"]).default("all"),
  include_empty: z
    .enum(["0", "1"])
    .optional()
    .transform((v) => v === "1"),
  sort: z.string().trim().max(30).optional(),
  dir: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyStockImportQuerySchema = z.object({
  hash: z.string().regex(/^[0-9a-f]{64}$/, "is missing. Check the file again before importing"),
  name: z.string().trim().max(200).optional(),
});
