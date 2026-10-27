import { isValidMobile } from "./phone.js";

const LETTERS_NAME = /^[A-Za-z][A-Za-z .'-]*$/;
const SPECIALTY_TEXT = /^[A-Za-z][A-Za-z .,&()/-]*$/;
const QUALIFICATIONS = /^[A-Za-z][A-Za-z0-9 .,&()/+-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const DOCTOR_REQUIRED_MESSAGES = {
  full_name: "Enter the doctor's name.",
  mobile: "Enter the doctor's 10-digit mobile number.",
  area: "Enter the area or sector.",
  specialty: "Choose a specialty.",
};

export const DOCTOR_FIELD_LIMITS = {
  full_name: 120,
  specialty: 80,
  qualifications: 120,
  clinic_name: 150,
  address_line: 300,
  area: 100,
  city: 80,
  email: 150,
  notes: 2000,
};

const letterCount = (v) => (v.match(/[A-Za-z]/g) || []).length;

export const stripDoctorTitle = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(dr\b\.?\s*)+/i, "");

export function doctorFieldError(key, raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const max = DOCTOR_FIELD_LIMITS[key];
  if (max && value.length > max) return `Keep this under ${max} characters.`;

  switch (key) {
    case "full_name": {
      const name = stripDoctorTitle(value);
      if (!LETTERS_NAME.test(name) || letterCount(name) < 2) {
        return "Use letters only, like Dr Rajesh Khanna.";
      }
      return null;
    }
    case "specialty":
      return SPECIALTY_TEXT.test(value) ? null : "Use letters only, like Neurology.";
    case "qualifications":
      return QUALIFICATIONS.test(value) ? null : "Start with letters, like MBBS, MD.";
    case "mobile":
      return isValidMobile(value) ? null : "Enter a 10-digit mobile number starting 6-9.";
    case "whatsapp":
      return isValidMobile(value) ? null : "Enter a 10-digit WhatsApp number starting 6-9.";
    case "clinic_phone":
      return /^\+?\d{6,15}$/.test(value.replace(/[\s-]/g, ""))
        ? null
        : "Enter the clinic phone with 6 to 15 digits.";
    case "email":
      return EMAIL.test(value) ? null : "Enter an email like name@example.com.";
    case "clinic_name":
      return letterCount(value) >= 2 ? null : "Enter the clinic's name, like Care Clinic.";
    case "address_line":
      return letterCount(value) >= 2 ? null : "Enter a street address, like SCO 12, Main Market.";
    case "area":
      return letterCount(value) >= 2 ? null : "Enter the area in words, like Sector 70 or Sohana.";
    case "city":
      return LETTERS_NAME.test(value) && letterCount(value) >= 2
        ? null
        : "Use letters only, like Mohali.";
    case "pin_code":
      return /^[1-9]\d{5}$/.test(value) ? null : "Enter a 6-digit PIN code, like 160062.";
    default:
      return null;
  }
}
