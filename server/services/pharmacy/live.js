import { createHub } from "../giniflow/eventHub.js";

export const pharmacyHub = createHub({
  eventName: "pharmacy",
  shape: ({ kind, billId }) => ({ kind, billId }),
});

export function signalPharmacy(kind, billId) {
  if (billId) pharmacyHub.publish({ kind, billId: String(billId) });
}
