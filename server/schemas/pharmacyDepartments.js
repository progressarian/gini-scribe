import { z } from "zod";
import { blankToNull, optionalText } from "./pharmacyFields.js";
import { VENDOR_RETURN_REASONS } from "../../shared/pharmacyVocab.js";

const id = z.coerce.number().int().min(1);
const optionalId = z.preprocess(blankToNull, id.nullish());
const units = z.coerce.number().int().min(1, "must be at least 1").max(100000);

export const pharmacyDepartmentLabels = {
  from_location_id: "From",
  to_location_id: "To",
  location_id: "Department",
  patient_id: "Patient",
  ipd_number: "IPD number",
  qty_units: "Quantity",
  lines: "Medicines",
  notes: "Note",
};

export const pharmacyTransferSchema = z.strictObject({
  from_location_id: id,
  to_location_id: id,
  notes: optionalText(300),
  lines: z
    .array(z.strictObject({ batch_id: id, qty_units: units }))
    .min(1, "must have at least one medicine")
    .max(200, "can have at most 200 lines"),
});

export const pharmacyTransferListQuerySchema = z.object({
  location_id: optionalId,
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyIndentSchema = z.strictObject({
  location_id: id,
  patient_id: id,
  ipd_number: optionalText(40),
  notes: optionalText(300),
  lines: z
    .array(
      z.strictObject({ batch_id: id, qty_units: units, near_expiry_ok: z.boolean().optional() }),
    )
    .min(1, "must have at least one medicine")
    .max(200, "can have at most 200 medicines"),
});

export const pharmacyIndentListQuerySchema = z.object({
  location_id: optionalId,
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyExpiryQuerySchema = z.object({
  location_id: optionalId,
  bucket: z.enum(["all", "expired", "30", "60", "90"]).default("all"),
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyVendorReturnLabels = {
  vendor_id: "Vendor",
  reason: "Reason",
  vendor_ref: "Vendor credit note / reference",
  lines: "Batches",
  qty_units: "Quantity",
};

export const pharmacyVendorReturnSchema = z.strictObject({
  vendor_id: id,
  reason: z.enum(VENDOR_RETURN_REASONS),
  vendor_ref: optionalText(60),
  notes: optionalText(300),
  lines: z
    .array(z.strictObject({ batch_id: id, qty_units: units }))
    .min(1, "must have at least one batch")
    .max(200, "can have at most 200 lines"),
});

export const pharmacyVendorReturnListQuerySchema = z.object({
  vendor_id: optionalId,
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

const day = z.preprocess(blankToNull, z.iso.date("must be a date").nullish());

export const pharmacyReportQuerySchema = z.object({ from: day, to: day });

export const pharmacyIndentReturnSchema = z.strictObject({
  version: id,
  reason: z.string().trim().min(3, "must say why the medicines came back").max(300),
  lines: z
    .array(
      z.strictObject({
        line_id: z.uuid("must be a valid line"),
        qty_units: units,
      }),
    )
    .min(1, "must have at least one medicine")
    .max(200),
});

export const pharmacyTopItemsQuerySchema = z.object({
  from: day,
  to: day,
  location_id: optionalId,
  sale_type: z.preprocess(blankToNull, z.enum(["opd", "walkin", "ipd", "indent"]).nullish()),
  form: z.preprocess(blankToNull, z.string().trim().max(20).nullish()),
  vendor_id: optionalId,
  q: z.string().trim().max(80).optional(),
  group: z.enum(["item", "vendor"]).default("item"),
  sort: z.string().trim().max(30).optional(),
  dir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
