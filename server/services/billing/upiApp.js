import { UPI_APP_LABEL, UPI_APPS, UPI_MODE } from "../../../shared/billingVocab.js";
import { httpError } from "./transaction.js";

export const UPI_APP_NEEDED = `Choose the UPI app it was paid by: ${Object.values(UPI_APP_LABEL).join(", ")}`;

export function cleanUpiApp(mode, value) {
  if (mode !== UPI_MODE) return null;
  const app = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UPI_APPS.includes(app)) throw httpError(400, UPI_APP_NEEDED);
  return app;
}
