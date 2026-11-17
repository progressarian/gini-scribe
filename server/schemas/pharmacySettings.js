import { z } from "zod";
import { blankToNull, gstinField, optionalPhone, optionalText } from "./pharmacyFields.js";

export const pharmacySettingsLabels = {
  legal_name: "Legal name",
  gstin: "GSTIN",
  drug_license_no: "Drug licence numbers",
  bill_footer: "Bill footer",
  near_expiry_warn_days: "Near-expiry warning (days)",
  expiry_alert_days: "Expiry alert (days)",
  credit_limit: "Credit limit per patient",
  max_discount_pct: "Maximum discount %",
};

export const pharmacySettingsSchema = z
  .strictObject({
    legal_name: optionalText(200),
    gstin: gstinField,
    drug_license_no: optionalText(200),
    address: optionalText(500),
    phone: optionalPhone,
    bill_footer: optionalText(500),
    sale_rate_includes_gst: z.boolean(),
    near_expiry_warn_days: z.coerce.number().int().min(0).max(365),
    expiry_alert_days: z.coerce.number().int().min(1).max(730),
    stock_source: z.enum(["darpan", "scribe"]),
    max_discount_pct: z.preprocess(
      blankToNull,
      z.coerce
        .number()
        .min(0, "cannot be below 0")
        .max(100, "cannot be more than 100")
        .refine(
          (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6,
          "can have at most 2 decimal places",
        )
        .nullish(),
    ),
    credit_limit: z.preprocess(
      blankToNull,
      z.coerce
        .number()
        .min(0, "cannot be below 0")
        .max(10000000)
        .refine(
          (n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6,
          "can have at most 2 decimal places",
        )
        .nullish(),
    ),
    version: z.coerce.number().int().min(1),
  })
  .refine((s) => s.expiry_alert_days >= s.near_expiry_warn_days, {
    path: ["expiry_alert_days"],
    message: "cannot be fewer days than the near-expiry warning",
  });
