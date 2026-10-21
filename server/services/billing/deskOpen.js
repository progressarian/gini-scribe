import pool from "../../config/db.js";
import { inTransaction } from "./transaction.js";
import { clearReceptionLines, openDraft } from "./bills.js";
import { consultationForDesk, testsForDesk } from "./visitLines.js";
import { healthrayLinesForDesk } from "./healthrayBillLines.js";
import { labCaseTestsForDesk } from "./labCaseLines.js";
import { autofillIsCurrent, rememberAutofill } from "./autofillKey.js";

export async function openDeskDraft(visitId, ctx, db = pool) {
  const opening = { ...ctx, unsavedDraft: true };
  return inTransaction(async (client) => {
    if (await autofillIsCurrent(client, visitId)) {
      return openDraft(visitId, { ...opening, skipPriceCatchUp: true }, client);
    }
    await consultationForDesk(visitId, opening, client);
    await healthrayLinesForDesk(visitId, opening, client);
    await testsForDesk(visitId, opening, client);
    await labCaseTestsForDesk(visitId, opening, client);
    await clearReceptionLines(visitId, opening, client);
    const opened = await openDraft(visitId, opening, client);
    await rememberAutofill(client, opened.id, visitId, opening);
    return opened;
  }, db);
}
