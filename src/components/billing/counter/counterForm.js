import { DEPOSIT_MODE, UPI_APPS } from "../../../../shared/billingVocab.js";
import { TAKE_MODE_LABEL } from "./lineText";

export const BILL_FORM_PREFIX = "billing.counter.form.";

export const billFormKey = (billId) => (billId ? `${BILL_FORM_PREFIX}${billId}` : null);

export const SHIFT_FORM_PREFIX = "billing.counter.shift.";

export const shiftFormKey = (userId) => (userId ? `${SHIFT_FORM_PREFIX}${userId}` : null);

export const emptyPaymentRow = () => ({ mode: "", amount: "", reference: "", upiApp: "" });

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isText = (value, max) => typeof value === "string" && value.length <= max;

const isId = (value) =>
  (typeof value === "string" && value.length > 0 && value.length <= 64) || Number.isInteger(value);

const isReason = (value) => isText(value, 500) && value.trim().length > 0;

const text = (max) => ({ blank: "", valid: (value) => isText(value, max) });

const isPaymentRow = (row) =>
  isObject(row) &&
  (row.mode === "" || Object.hasOwn(TAKE_MODE_LABEL, row.mode) || row.mode === DEPOSIT_MODE) &&
  (row.upiApp === undefined || row.upiApp === "" || UPI_APPS.includes(row.upiApp)) &&
  isText(row.amount, 12) &&
  /^\d*(\.\d{0,2})?$/.test(row.amount) &&
  isText(row.reference, 60);

export const BILL_FORM = {
  rows: {
    blank: [emptyPaymentRow()],
    valid: (value) =>
      Array.isArray(value) && value.length >= 1 && value.length <= 10 && value.every(isPaymentRow),
  },
  payLater: { blank: false, valid: (value) => typeof value === "boolean" },
  code: text(40),
  chosen: { blank: null, valid: (value) => value === null || isText(value, 80) },
  search: text(100),
  addOpen: { blank: false, valid: (value) => typeof value === "boolean" },
  again: {
    blank: null,
    valid: (value) =>
      value === null ||
      (isObject(value) &&
        isObject(value.item) &&
        isId(value.item.id) &&
        isText(value.item.name, 200) &&
        isReason(value.reason)),
  },
  newItem: {
    blank: null,
    valid: (value) =>
      value === null ||
      (isObject(value) &&
        isText(value.name, 200) &&
        isText(value.group, 200) &&
        isText(value.reason, 500)),
  },
  removing: {
    blank: null,
    valid: (value) =>
      value === null || (isObject(value) && isId(value.lineId) && isReason(value.reason)),
  },
  cancelReason: { blank: null, valid: (value) => value === null || isReason(value) },
};

export const NOTES = [500, 200, 100, 50, 20, 10];

const isNoteCount = (value) =>
  isObject(value) &&
  Object.entries(value).every(
    ([key, count]) =>
      (NOTES.map(String).includes(key) && isText(count, 6) && /^\d*$/.test(count)) ||
      (key === "coins" && isText(count, 12) && /^\d*(\.\d{0,2})?$/.test(count)),
  );

export const SHIFT_FORM = {
  opening: { blank: "", valid: (value) => isText(value, 12) && /^\d*(\.\d{0,2})?$/.test(value) },
  counted: { blank: "", valid: (value) => isText(value, 12) && /^\d*(\.\d{0,2})?$/.test(value) },
  notes: { blank: {}, valid: isNoteCount },
  note: text(280),
};

export function noteCountTotal(notes = {}) {
  const coins = Math.round(Number(notes.coins || 0) * 100);
  return NOTES.reduce((sum, note) => sum + Number(notes[note] || 0) * note * 100, coins);
}

export const noteCountUsed = (notes = {}) =>
  Object.values(notes).some((value) => Number(value) > 0);
