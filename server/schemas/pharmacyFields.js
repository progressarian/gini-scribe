import { z } from "zod";
import { GSTIN_PATTERN, isValidGstin } from "../../shared/pharmacyVocab.js";

export const digits = (v) => (typeof v === "string" ? v.replace(/[\s()+-]/g, "") : v);
export const upper = (v) => (typeof v === "string" ? v.trim().toUpperCase() : v);
export const blankToNull = (v) => (typeof v === "string" && !v.trim() ? null : v);

export const optionalText = (max) =>
  z.preprocess(blankToNull, z.string().trim().max(max).nullish());

export const optionalPattern = (pattern, hint, clean = upper) =>
  z.preprocess((v) => blankToNull(clean(v)), z.string().regex(pattern, hint).nullish());

const PHONE = /^[0-9]{10,12}$/;

export const phoneField = z.preprocess(digits, z.string().regex(PHONE, "must be 10 to 12 digits"));

export const optionalPhone = z.preprocess(
  (v) => blankToNull(digits(v)),
  z.string().regex(PHONE, "must be 10 to 12 digits").nullish(),
);

export const gstinField = z.preprocess(
  (v) => blankToNull(upper(v)),
  z
    .string()
    .regex(GSTIN_PATTERN, { message: "must be 15 characters, like 03AAPFU0939F1Z5", abort: true })
    .refine(isValidGstin, "has a typing mistake: its last character does not match")
    .nullish(),
);
