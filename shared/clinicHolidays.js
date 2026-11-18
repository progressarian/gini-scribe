export const CLINIC_HOLIDAY_LIMITS = { back: 365, ahead: 365, maxSpan: 31 };

export const HOLIDAY_TITLE_MAX = 60;

export const HOLIDAY_TITLE = /^[A-Za-z0-9][A-Za-z0-9 .,'&()/-]*$/;

export function holidayTitleError(value) {
  const title = String(value ?? "").trim();
  if (!title) return "Enter the holiday name, like Diwali.";
  if (title.length > HOLIDAY_TITLE_MAX || !HOLIDAY_TITLE.test(title)) {
    return `Use letters and numbers only, up to ${HOLIDAY_TITLE_MAX}, like Diwali.`;
  }
  return null;
}
