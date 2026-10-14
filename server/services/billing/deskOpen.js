import pool from "../../config/db.js";
import { inTransaction } from "./transaction.js";
import { clearReceptionLines, openDraft } from "./bills.js";
import { consultationForDesk, testsForDesk } from "./visitLines.js";
import { healthrayLinesForDesk } from "./healthrayBillLines.js";
import { labCaseTestsForDesk } from "./labCaseLines.js";

export async function openDeskDraft(visitId, ctx, db = pool) {
  const opening = { ...ctx, unsavedDraft: true };
  return inTransaction(async (client) => {
    await consultationForDesk(visitId, opening, client);
    await healthrayLinesForDesk(visitId, opening, client);
    await testsForDesk(visitId, opening, client);
    await labCaseTestsForDesk(visitId, opening, client);
    await clearReceptionLines(visitId, opening, client);
    return openDraft(visitId, opening, client);
  }, db);
}
