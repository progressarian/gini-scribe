import { z } from "zod";
import { GSTIN_PATTERN, IFSC_PATTERN, PAN_PATTERN } from "../../shared/pharmacyVocab.js";

const digits = (v) => (typeof v === "string" ? v.replace(/[\s()+-]/g, "") : v);
const upper = (v) => (typeof v === "string" ? v.trim().toUpperCase() : v);
const blankToNull = (v) => (typeof v === "string" && !v.trim() ? null : v);

const optionalText = (max) => z.preprocess(blankToNull, z.string().trim().max(max).nullish());

const optionalPattern = (pattern, hint, clean = upper) =>
  z.preprocess((v) => blankToNull(clean(v)), z.string().regex(pattern, hint).nullish());

const phone = z.preprocess(digits, z.string().regex(/^[0-9]{10,12}$/, "must be 10 to 12 digits"));

const vendorFields = {
  name: z.string().trim().min(2, "must be at least 2 characters").max(160),
  contact_person: optionalText(120),
  phone,
  alt_phone: z.preprocess(
    (v) => blankToNull(digits(v)),
    z
      .string()
      .regex(/^[0-9]{10,12}$/, "must be 10 to 12 digits")
      .nullish(),
  ),
  email: z.preprocess(
    (v) => blankToNull(typeof v === "string" ? v.trim().toLowerCase() : v),
    z.email("is not a valid email address").max(160).nullish(),
  ),
  address: optionalText(500),
  city: optionalText(80),
  state: optionalText(80),
  pincode: optionalPattern(/^[1-9][0-9]{5}$/, "must be 6 digits", digits),
  gstin: optionalPattern(GSTIN_PATTERN, "must be 15 characters, like 03ABCDE1234F1Z5"),
  pan: optionalPattern(PAN_PATTERN, "must be 10 characters, like ABCDE1234F"),
  drug_license_no: optionalText(80),
  drug_license_expiry: z.preprocess(blankToNull, z.iso.date("must be a date").nullish()),
  payment_terms_days: z.coerce.number().int().min(0).max(365).default(0),
  bank_name: optionalText(120),
  bank_account: optionalPattern(/^[0-9]{6,20}$/, "must be 6 to 20 digits", digits),
  ifsc: optionalPattern(IFSC_PATTERN, "must be 11 characters, like HDFC0001234"),
  notes: optionalText(1000),
};

export const pharmacyVendorLabels = {
  name: "Vendor name",
  contact_person: "Contact person",
  alt_phone: "Alternate phone",
  gstin: "GSTIN",
  pan: "PAN",
  ifsc: "IFSC",
  drug_license_no: "Drug licence number",
  drug_license_expiry: "Drug licence expiry",
  payment_terms_days: "Payment terms (days)",
  bank_account: "Bank account number",
};

export const pharmacyVendorSchema = z.strictObject(vendorFields);

export const pharmacyVendorUpdateSchema = z.strictObject({
  ...vendorFields,
  version: z.coerce.number().int().min(1),
});

export const pharmacyVendorActiveSchema = z.strictObject({
  is_active: z.boolean(),
});

export const pharmacyVendorListQuerySchema = z.object({
  q: z.string().trim().max(80).optional(),
  status: z.enum(["active", "inactive", "all"]).default("active"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
