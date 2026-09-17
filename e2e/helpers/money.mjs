import { expect } from "@playwright/test";
import { paise, rupeesFromPaise } from "../../shared/labPayment.js";

export { paise, rupeesFromPaise };

export function expectRupees(actual, expected, label = "amount") {
  expect(paise(actual), `${label}: expected ₹${expected}, got ₹${actual}`).toBe(paise(expected));
}

export function sumRupees(values) {
  return rupeesFromPaise(values.reduce((total, value) => total + paise(value), 0));
}
