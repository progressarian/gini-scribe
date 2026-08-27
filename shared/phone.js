// One definition of "a phone number we can actually call". An Indian mobile is
// 10 digits starting 6-9; anything shorter, longer or starting 0-5 is a typo,
// a landline or a partially typed number, and none of those reach the patient.
export const PHONE_DIGITS = 10;

export const toLocal10 = (raw) =>
  String(raw || "")
    .replace(/\D/g, "")
    .slice(-PHONE_DIGITS);

// What a 10-digit entry box should keep as the user types or pastes: a pasted
// +91/0-prefixed number loses its prefix rather than being truncated to a wrong
// number, while extra keystrokes past the tenth digit are simply ignored.
export const toEntryDigits = (raw) => {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.length > PHONE_DIGITS && digits.startsWith("91")) digits = digits.slice(-PHONE_DIGITS);
  if (digits.length > PHONE_DIGITS && digits.startsWith("0")) digits = digits.slice(-PHONE_DIGITS);
  return digits.slice(0, PHONE_DIGITS);
};

export const isValidMobile = (local) => /^[6-9]\d{9}$/.test(local || "");

export const MOBILE_HINT = "Enter a 10-digit mobile starting 6-9";
