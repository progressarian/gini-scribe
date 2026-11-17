import { httpError } from "../billing/transaction.js";
import { openShiftIdFor } from "../billing/cashShifts.js";

export async function shiftForPayments(client, ctx, modes, { requireForCash = false } = {}) {
  const shiftId = ctx?.actorId ? await openShiftIdFor(client, ctx.actorId) : null;
  if (requireForCash && !shiftId && modes.includes("cash")) {
    throw httpError(
      409,
      "Open your shift first, so this cash is in a drawer that can be counted at the end of it",
    );
  }
  return shiftId;
}
