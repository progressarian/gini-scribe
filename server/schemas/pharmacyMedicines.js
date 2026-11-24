import { z } from "zod";
import { blankToNull, optionalText } from "./pharmacyFields.js";
import { MEDICINE_TYPES } from "../../shared/medicineTypes.js";
import {
  GST_MAX,
  HSN_PATTERN,
  PACK_LABELS,
  SCHEDULES,
  UNIT_LABELS,
} from "../../shared/pharmacyVocab.js";

const twoDecimals = (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

const money = z.preprocess(
  blankToNull,
  z.coerce
    .number()
    .positive("must be more than 0")
    .max(10000000)
    .refine(twoDecimals, "can have at most 2 decimal places")
    .nullish(),
);

const units = (min) =>
  z.preprocess(blankToNull, z.coerce.number().int().min(min).max(100000000).nullish());

const medicineFields = {
  code: z.preprocess(
    (v) => blankToNull(typeof v === "string" ? v.trim().toUpperCase() : v),
    z
      .string()
      .regex(/^[A-Z0-9-]{2,30}$/, "can use 2 to 30 letters, digits or hyphens")
      .nullish(),
  ),
  name: z.string().trim().min(2, "must be at least 2 characters").max(200),
  generic_name: optionalText(300),
  manufacturer: optionalText(160),
  form: z.enum(MEDICINE_TYPES),
  strength: optionalText(60),
  pack_size: z.coerce.number().int().min(1).max(10000),
  unit_label: z.enum(UNIT_LABELS),
  pack_label: z.enum(PACK_LABELS),
  hsn_code: z.preprocess(
    (v) => blankToNull(typeof v === "string" ? v.replace(/\s/g, "") : v),
    z.string().regex(HSN_PATTERN, "must be 4 to 8 digits").nullish(),
  ),
  gst_rate_pct: z.coerce
    .number()
    .min(0)
    .max(GST_MAX)
    .refine(twoDecimals, "can have at most 2 decimal places"),
  schedule: z.enum(SCHEDULES).default("none"),
  default_mrp: money,
  default_sale_rate: money,
  min_stock_units: z.preprocess(
    blankToNull,
    z.coerce.number().int().min(0).max(100000000).default(0),
  ),
  max_stock_units: units(1),
  reorder_qty_units: units(1),
  default_rack: optionalText(40),
};

const consistent = (schema) =>
  schema
    .refine(
      (m) =>
        m.default_mrp == null ||
        m.default_sale_rate == null ||
        m.default_sale_rate <= m.default_mrp,
      { path: ["default_sale_rate"], message: "cannot be more than the MRP" },
    )
    .refine((m) => m.max_stock_units == null || m.max_stock_units >= m.min_stock_units, {
      path: ["max_stock_units"],
      message: "cannot be less than the minimum stock",
    });

export const pharmacyMedicineLabels = {
  code: "Code",
  name: "Medicine name",
  generic_name: "Generic name / composition",
  pack_size: "Units per pack",
  unit_label: "Unit",
  pack_label: "Pack",
  hsn_code: "HSN code",
  gst_rate_pct: "GST rate",
  default_mrp: "MRP per pack",
  default_sale_rate: "Sale rate per pack",
  min_stock_units: "Minimum stock",
  max_stock_units: "Maximum stock",
  reorder_qty_units: "Reorder quantity",
  default_rack: "Rack",
};

export const pharmacyMedicineSchema = consistent(z.strictObject(medicineFields));

export const pharmacyMedicineUpdateSchema = consistent(
  z.strictObject({
    ...medicineFields,
    code: z.preprocess(
      (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
      z.string().regex(/^[A-Z0-9-]{2,30}$/, "can use 2 to 30 letters, digits or hyphens"),
    ),
    version: z.coerce.number().int().min(1),
  }),
);

export const pharmacyMedicineActiveSchema = z.strictObject({ is_active: z.boolean() });

export const pharmacyMedicineListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  schedule: z.enum(SCHEDULES).optional(),
  form: z.enum(MEDICINE_TYPES).optional(),
  review: z.stringbool().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const rowList = z.preprocess(
  (v) =>
    typeof v === "string"
      ? v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : (v ?? []),
  z.array(z.coerce.number().int().min(1).max(1000000)).max(5000),
);

export const pharmacySheetDecisionFields = {
  default: z.enum(["sheet", "keep", "add", "skip"]).default("sheet"),
  keep: rowList,
  sheet: rowList,
  add: rowList,
  skip: rowList,
};

export const pharmacySheetDecisionQuerySchema = z.object(pharmacySheetDecisionFields);
export const pharmacySheetDecisionBodySchema = z.strictObject(pharmacySheetDecisionFields);
