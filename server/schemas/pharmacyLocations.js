import { z } from "zod";
import { blankToNull } from "./pharmacyFields.js";

const locationFields = {
  code: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toUpperCase() : v),
    z.string().regex(/^[A-Z0-9-]{2,20}$/, "can use 2 to 20 letters, digits or hyphens"),
  ),
  name: z.string().trim().min(2, "must be at least 2 characters").max(120),
  notes: z.preprocess(blankToNull, z.string().trim().max(500).nullish()),
};

export const pharmacyLocationLabels = { code: "Code", name: "Department name" };

export const pharmacyLocationSchema = z.strictObject(locationFields);

export const pharmacyLocationUpdateSchema = z.strictObject({
  ...locationFields,
  version: z.coerce.number().int().min(1),
});

export const pharmacyLocationActiveSchema = z.strictObject({ is_active: z.boolean() });

export const pharmacyLocationListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const pharmacyLevelLabels = { min_units: "Minimum stock", max_units: "Maximum stock" };

export const pharmacyLevelSchema = z
  .strictObject({
    min_units: z.coerce.number().int().min(0).max(100000000),
    max_units: z.preprocess(blankToNull, z.coerce.number().int().min(1).max(100000000).nullish()),
  })
  .refine((l) => l.max_units == null || l.max_units >= l.min_units, {
    path: ["max_units"],
    message: "cannot be less than the minimum stock",
  });

export const pharmacyLevelListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
