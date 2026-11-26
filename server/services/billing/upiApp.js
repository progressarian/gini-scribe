import { DEFAULT_UPI_APP, UPI_APPS, UPI_MODE } from "../../../shared/billingVocab.js";

export function cleanUpiApp(mode, value) {
  if (mode !== UPI_MODE) return null;
  const app = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UPI_APPS.includes(app) ? app : DEFAULT_UPI_APP;
}
