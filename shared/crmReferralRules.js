import { isValidMobile, toEntryDigits } from "./phone.js";

const PERSON_NAME = /^[A-Za-z][A-Za-z .'-]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const REFERRAL_FIELD_LIMITS = {
  patient_name: 120,
  reason_category: 120,
  expected_action: 200,
};

export const REFERRAL_NEEDS_PATIENT = "Enter the patient's name or mobile number.";

const letterCount = (v) => (v.match(/[A-Za-z]/g) || []).length;

export const isUuid = (v) => UUID.test(String(v ?? ""));

export const referralPhoneDigits = (raw) => toEntryDigits(raw);

export function referralFieldError(key, raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const max = REFERRAL_FIELD_LIMITS[key];
  if (max && value.length > max) return `Keep this under ${max} characters.`;

  switch (key) {
    case "patient_name":
      return PERSON_NAME.test(value) && letterCount(value) >= 2
        ? null
        : "Use letters only, like Ramesh Kumar.";
    case "patient_phone":
      return isValidMobile(referralPhoneDigits(value))
        ? null
        : "Enter a 10-digit mobile number starting 6-9.";
    case "reason_category":
      return letterCount(value) >= 2 ? null : "Describe it in words, like Chest pain.";
    case "expected_action":
      return letterCount(value) >= 2 ? null : "Describe it in words, like Cardiology opinion.";
    default:
      return null;
  }
}

export function referralFormErrors(values) {
  const errors = {};
  for (const key of ["patient_name", "patient_phone", "reason_category", "expected_action"]) {
    const message = referralFieldError(key, values[key]);
    if (message) errors[key] = message;
  }
  if (!String(values.patient_name ?? "").trim() && !String(values.patient_phone ?? "").trim()) {
    errors.patient_name = REFERRAL_NEEDS_PATIENT;
  }
  return errors;
}
