import { NEFT_LABEL, NEFT_MODE } from "../../../shared/billingVocab.js";
import { DRAWER_MODE, NEW_TAKE_MODES } from "./cashShifts.js";
import { REFERENCE_MAX } from "./payments.js";
import { httpError } from "./transaction.js";
import { cleanUpiApp } from "./upiApp.js";

const MODE_LABEL = { cash: "Cash", card: "Card", upi: "UPI", [NEFT_MODE]: NEFT_LABEL };

export function cleanPaidMode(input, ask) {
  const mode = typeof input?.mode === "string" ? input.mode.trim().toLowerCase() : "";
  if (!NEW_TAKE_MODES.includes(mode)) {
    throw httpError(400, `${ask}: ${NEW_TAKE_MODES.map((m) => MODE_LABEL[m] ?? m).join(", ")}`);
  }
  const upiApp = cleanUpiApp(mode, input?.upi_app);
  const typed = typeof input?.reference === "string" ? input.reference.trim() : "";
  if (typed.length > REFERENCE_MAX) {
    throw httpError(400, `The reference is too long — keep it under ${REFERENCE_MAX} letters`);
  }
  return { mode, reference: mode === DRAWER_MODE ? null : typed || null, upi_app: upiApp };
}
